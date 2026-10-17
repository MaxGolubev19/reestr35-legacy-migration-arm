'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { APP_ROOT, dataRoot, dataSubdir } = require('../../../data-dir.cjs');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { buildArgs, qaEnvironment } = require('./config.cjs');

const RECORD_REVIEW = Object.freeze({ type: 'function', name: 'record_review',
  description: 'Immediately persist the visual review of the next attached PNG in order.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'sha256', 'status', 'issues'],
    properties: { name: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      status: { type: 'string', enum: ['passed', 'issues'] }, issues: { type: 'array', items: { type: 'string' } } } } });

// A profile names the inline MCP server, its tool surface and the relay kinds
// each tool call is forwarded under. Tool names feed the session allowlist;
// the schemas themselves live in the per-profile stdio bridge.
const QA_PROFILE = Object.freeze({ mcpName: 'reestr35-qa', tools: ['record_review'],
  relay: Object.freeze({ record_review: 'onReview' }),
  instructionsPath: path.join(APP_ROOT, 'src', 'qa-instructions.txt') });

const RUNTIME_PREFERENCES = Object.freeze({ nativeSearchEnhancementsEnabled: false, subagentRuntimeConfigEnabled: false,
  memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true, modelContextBudgetStrategy: 'preflight-v1' });

// One process, session and turn for one company's QA pass. Never reuse this
// object: completion is published only after its OS process has closed. The
// ZCode app-server speaks bare JSON-RPC lines ({id,method,params}) over stdio;
// profile tools arrive through an inline MCP server whose loopback relay
// calls back into this process, so every call is validated and checkpointed
// by the backend before the tool call is acknowledged to the model.
class AppServer {
  constructor({ launch, profile = QA_PROFILE, env = process.env, root = dataRoot(env), spawnFn = spawn, netModule = net, requestTimeoutMs = 30000, shutdownGraceMs = 2000 } = {}) {
    if (!launch) throw new Error('AppServer requires a ZCode launch configuration');
    Object.assign(this, { launch, profile, env, root, spawnFn, netModule, requestTimeoutMs, shutdownGraceMs });
    this.pending = new Map(); this.sessions = new Set(); this.threads = new Map(); this.serial = 0;
  }
  async start() {
    if (this.closed) throw new Error('app-server is shutting down');
    if (this.starting) return this.starting;
    const starting = this.connect(); this.starting = starting;
    starting.catch(() => { if (this.starting === starting && !this.child) this.starting = null; });
    return starting;
  }
  async connect() {
    this.cwd = fs.mkdtempSync(path.join(dataSubdir('qa-servers', this.root), 'server-'));
    const tempDir = dataSubdir('tmp', this.root);
    let child;
    try { child = this.spawnFn(this.launch.node, [this.launch.script, ...buildArgs()], { cwd: this.cwd, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: qaEnvironment({ ...this.env, TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir }, this.launch.personalProviderFile, this.launch.builtinProviderConfig) }); }
    catch (error) { fs.rmSync(this.cwd, { recursive: true, force: true }); this.starting = null; throw error; }
    this.child = child; const cwd = this.cwd;
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('error', () => {});
    reader.on('line', line => { try { this.receive(JSON.parse(line)); } catch (error) { this.failTransport(error); } });
    child.stderr.on('data', data => { for (const session of this.sessions) session.onLog?.(String(data)); });
    child.stdin.on('error', error => this.failTransport(error));
    child.once('error', error => this.failTransport(error));
    child.once('close', () => {
      reader.close();
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('app-server connection closed')); }
      this.pending.clear();
      this.stopRelay();
      this.child = null; this.starting = null; this.closed = true;
      try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); }
      catch (error) { for (const session of this.sessions) session.cleanupError = error; }
      for (const session of [...this.sessions]) this.finish(session, session.resultCode ?? 1, 'app-server-closed');
    });
    try {
      // Publish ownership before any request that can run QA.
      for (const session of this.sessions) session.onIdentity({ appServerPid: child.pid });
      return child;
    } catch (error) { if (this.child === child) this.failTransport(error); throw error; }
  }
  startRelay(session) {
    const token = crypto.randomUUID();
    this.relay = this.netModule.createServer();
    this.relaySockets = new Set();
    this.relay.on('error', () => {});
    this.relay.on('connection', socket => {
      this.relaySockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => this.relaySockets.delete(socket));
      const wire = readline.createInterface({ input: socket });
      wire.on('error', () => {});
      wire.on('line', line => {
        let message; try { message = JSON.parse(line); } catch { return; }
        if (message.token !== token) { socket.write(JSON.stringify({ id: message.id, error: 'bad relay token' }) + '\n'); return; }
        const handler = this.profile.relay[message.kind];
        if (!handler || typeof session?.[handler] !== 'function') { socket.write(JSON.stringify({ id: message.id, error: 'unknown relay kind' }) + '\n'); return; }
        let answer;
        try {
          if (!session || session.exitCode !== null || session.ending || !session.turnId || this.threads.get(session.sessionId) !== session) throw new Error('Stale relay: unknown session or turn');
          answer = session[handler](message.arguments, { generation: session.generation, threadId: session.sessionId, turnId: session.turnId });
        } catch (error) { answer = { error: error.message }; }
        socket.write(JSON.stringify({ id: message.id, ...answer }) + '\n');
      });
    });
    return new Promise((resolve, reject) => {
      this.relay.once('error', reject);
      this.relay.listen(0, '127.0.0.1', () => resolve({ port: this.relay.address().port, token }));
    });
  }
  stopRelay() {
    const relay = this.relay; this.relay = null;
    for (const socket of this.relaySockets || []) try { socket.destroy(); } catch {}
    this.relaySockets = new Set();
    try { relay?.close(); } catch {}
  }
  send(value) {
    if (!this.child || this.child.exitCode !== null) throw new Error('app-server unavailable');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method, params) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`app-server ${method} timeout; awaiting transport close`));
        this.failTransport(new Error(`RPC timeout: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  failTransport(error) {
    this.closed = true;
    for (const session of this.sessions) { session.failure = session.failure ?? error; session.ending = true; session.resultCode = 1; }
    // Ambiguous RPC outcome cannot release any slot before actual process close.
    if (this.child) { this.child.stdin.destroy(); this.child.kill('SIGKILL'); }
  }
  receive(message) {
    if (!message.method && Object.hasOwn(message, 'id')) {
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error.message || JSON.stringify(message.error))) : request.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      // Server-to-client request; the QA session is fully autonomous (yolo +
      // tool allowlist), so anything interactive is refused deterministically.
      if (message.method === 'session/requestRuntimePreferences') this.send({ id: message.id, result: RUNTIME_PREFERENCES });
      else if (message.method === 'subagents/readRuntimeConfig') this.send({ id: message.id, result: { kind: 'built-in-fallback' } });
      else if (message.method === 'interaction/requestPermission') this.send({ id: message.id, result: { decision: 'deny', reason: 'ARM QA runs autonomously' } });
      else this.send({ id: message.id, error: { code: -32601, message: `Only ${this.profile.tools.join(', ')} is supported: ${message.method}` } });
      return;
    }
    if (message.method !== 'session/event') return;
    for (const event of message.params?.events || (message.params?.type ? [message.params] : [])) this.receiveEvent(event);
  }
  receiveEvent(event) {
    if (!event.type) return;
    const turnId = event.turnId || event.payload?.turnId;
    const session = this.threads.get(event.sessionId || (event.payload && event.payload.sessionId));
    if (event.type === 'tool.updated' && session?.onLog && event.toolName && event.kind) session.onLog(`${event.toolName} ${event.kind}\n`);
    if (!session) return;
    if (event.type === 'turn.started') { this.bindTurn(session, turnId); return; }
    if (event.type !== 'turn.completed' && event.type !== 'turn.failed') return;
    if (session.ending || (session.turnId && turnId && turnId !== session.turnId)) return;
    if (event.type === 'turn.failed') { const message = event.payload?.error?.message || event.payload?.error?.underlyingErrorMessage; if (message) session.failure = new Error(message); }
    session.ending = true; session.resultCode = event.type === 'turn.completed' ? 0 : 1;
    void this.shutdown();
  }
  bindTurn(session, id) {
    if (typeof id !== 'string' || !id || (session.turnId && session.turnId !== id)) throw new Error('Unexpected turn identity');
    if (session.turnId) return;
    session.turnId = id; session.onIdentity({ appServerPid: this.child.pid, threadId: session.threadId, turnId: id });
  }
  review({ generation, cwd, prompt, files, onIdentity, onReview, onLog }) {
    if (this.used || this.closed) throw new Error('AppServer supports exactly one QA pass; create a new instance');
    this.used = true;
    const session = new EventEmitter();
    Object.assign(session, { isQa: true, generation, exitCode: null, onIdentity, onReview, onLog });
    return this.dispatch(session, { cwd, prompt, files });
  }
  // Same one process/session/turn contract as review(), but for the page
  // builder: its tools are save_document and read_file, each relayed to the
  // session's onSave/onReadFile callbacks for validation before acknowledgement.
  assemble({ generation, cwd, prompt, files, onIdentity, onSave, onReadFile, onLog }) {
    if (this.used || this.closed) throw new Error('AppServer supports exactly one assembly pass; create a new instance');
    this.used = true;
    const session = new EventEmitter();
    Object.assign(session, { isBuilder: true, generation, exitCode: null, onIdentity, onSave, onReadFile, onLog });
    return this.dispatch(session, { cwd, prompt, files });
  }
  dispatch(session, { cwd, prompt, files }) {
    this.sessions.add(session);
    session.interrupt = async () => {
      session.cancelRequested = true; session.ending = true; session.resultCode = 1;
      if (session.exitCode !== null) return;
      // This process belongs only to this pass. Closing it also stops a hung
      // session/turn without depending on a stop acknowledgement.
      await this.shutdown();
      await session.ready;
    };
    // Let Queue install launch ownership and close listeners before spawning.
    session.ready = Promise.resolve().then(async () => {
      await this.start();
      if (session.exitCode !== null || session.ending) return;
      const relay = await this.startRelay(session);
      const model = { providerId: this.launch.provider, modelId: this.launch.model, options: { reasoningLevel: this.launch.reasoning } };
      const created = await this.request('session/create', {
        workspace: { workspacePath: cwd, workspaceKey: cwd },
        mode: 'yolo', persistence: 'deferred', titleGenerationEnabled: false, model,
        mcpServers: [{ name: this.profile.mcpName, command: this.launch.node, args: [this.launch.bridge, String(relay.port), relay.token], env: [], isolation: 'session' }],
        // MCP tools register under their qualified id; keep the bare name too
        // so a CLI change in either direction cannot widen the tool surface.
        toolAllowlist: this.profile.tools.flatMap(name => [`mcp__${this.profile.mcpName}__${name}`, name]),
      });
      session.sessionId = created?.session?.sessionId ?? created?.sessionId;
      if (!session.sessionId) throw new Error('session/create returned no session id');
      session.threadId = session.sessionId; this.threads.set(session.threadId, session);
      if (session.exitCode !== null || session.ending) return;
      session.onIdentity({ appServerPid: this.child.pid, threadId: session.threadId });
      await this.request('session/subscribe', { sessionId: session.sessionId, deliveryKind: 'desktop-continuous' });
      if (session.exitCode !== null || session.ending) return;
      const instructions = fs.readFileSync(this.profile.instructionsPath, 'utf8').replace(/\r\n/g, '\n');
      const turn = await this.request('session/send', { sessionId: session.sessionId, modelSelection: model,
        content: `${instructions}\n\n${prompt}`,
        attachments: files.map(file => ({ kind: 'image', filename: file.name, localPath: path.join(cwd, file.name), mimeType: 'image/png' })) });
      if (!turn?.accepted) throw new Error(`session/send not accepted: ${JSON.stringify(turn).slice(0, 200)}`);
      // A turn id normally arrives through the turn.started event before the
      // first relay call; bind defensively from the accepted turn as well.
      if (session.exitCode === null && !session.ending && typeof turn.turnId === 'string') this.bindTurn(session, turn.turnId);
    }).catch(error => {
      if (session.exitCode !== null) return;
      session.failure = error;
      // Errors after dispatch may be ambiguous: drain the transport before retry.
      if (this.child) this.failTransport(error);
      else this.finish(session, 1, 'no-app-server');
    });
    return session;
  }
  finish(session, code, proof) {
    if (session.exitCode !== null) return;
    session.exitCode = code; session.completionProof = proof;
    this.sessions.delete(session); if (session.threadId) this.threads.delete(session.threadId);
    session.emit('close', code, null);
  }
  async shutdown() {
    if (this.stopping) return this.stopping;
    this.closed = true;
    for (const session of this.sessions) session.ending = true;
    if (!this.child) {
      this.stopRelay();
      for (const session of [...this.sessions]) this.finish(session, 1, 'no-app-server');
      return;
    }
    const child = this.child, closed = new Promise(resolve => child.once('close', resolve));
    this.stopping = (async () => {
      // SIGKILL/TerminateProcess is scoped to this dedicated app-server. Never
      // release the queue slot merely because end/kill was requested.
      const timer = setTimeout(() => child.kill('SIGKILL'), this.shutdownGraceMs);
      try {
        try { child.stdin.end(); } catch (error) { this.failTransport(error); }
        await closed;
      } finally { clearTimeout(timer); this.stopRelay(); }
    })();
    return this.stopping;
  }
}
module.exports = { AppServer, RECORD_REVIEW, QA_PROFILE };
