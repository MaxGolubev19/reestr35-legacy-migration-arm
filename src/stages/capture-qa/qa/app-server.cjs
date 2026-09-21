'use strict';
const fs = require('node:fs');
const path = require('node:path');
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

// One process, ephemeral thread and turn for one company's QA pass. Never reuse
// this object: completion is published only after its OS process has closed.
class AppServer {
  constructor({ codex = 'codex', env = process.env, root = dataRoot(env), spawnFn = spawn, requestTimeoutMs = 30000, shutdownGraceMs = 2000 } = {}) {
    Object.assign(this, { codex, env, root, spawnFn, requestTimeoutMs, shutdownGraceMs });
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
    try { child = this.spawnFn(this.codex, buildArgs(this.cwd), { cwd: this.cwd, shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: qaEnvironment({ ...this.env, TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir }) }); }
    catch (error) { fs.rmSync(this.cwd, { recursive: true, force: true }); this.starting = null; throw error; }
    this.child = child; const cwd = this.cwd;
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => { try { this.receive(JSON.parse(line)); } catch (error) { this.failTransport(error); } });
    child.stderr.on('data', data => { for (const session of this.sessions) session.onLog?.(String(data)); });
    child.stdin.on('error', error => this.failTransport(error));
    child.once('error', error => this.failTransport(error));
    child.once('close', () => {
      reader.close();
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('app-server connection closed')); }
      this.pending.clear();
      this.child = null; this.starting = null; this.closed = true;
      try { fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); }
      catch (error) { for (const session of this.sessions) session.cleanupError = error; }
      for (const session of [...this.sessions]) this.finish(session, session.resultCode ?? 1, 'app-server-closed');
    });
    try {
      // Publish ownership before initialization or any request that can run QA.
      for (const session of this.sessions) session.onIdentity({ appServerPid: child.pid });
      await this.request('initialize', { clientInfo: { name: 'reestr35_capture_qa', version: '3.3.0' }, capabilities: { experimentalApi: true } });
      this.send({ method: 'initialized' });
      const configuration = await this.request('config/read', { includeLayers: false });
      if (!configuration.config || typeof configuration.config !== 'object') throw new Error('Cannot verify app-server configuration');
      // An empty TOML table merges with user config; it does not disable its MCPs.
      // Enumerate names through the protocol and explicitly disable every server.
      this.disabledMcp = Object.fromEntries(Object.keys(configuration.config.mcp_servers || {}).map(name => [name, { enabled: false }]));
      return child;
    } catch (error) { if (this.child === child) this.failTransport(error); throw error; }
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
    for (const session of this.sessions) { session.failure = error; session.ending = true; session.resultCode = 1; }
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
    const p = message.params || {}, session = this.threads.get(p.threadId);
    if (message.method === 'item/tool/call' && Object.hasOwn(message, 'id')) {
      let result;
      try {
        if (!session || session.exitCode !== null || session.ending || p.tool !== 'record_review' || p.namespace || p.turnId !== session.turnId) throw new Error('Unknown tool or stale thread/turn');
        result = session.onReview(p.arguments, { generation: session.generation, threadId: p.threadId, turnId: p.turnId, callId: p.callId });
        this.send({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } });
      } catch (error) {
        this.send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: error.message }] } });
      }
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      this.send({ id: message.id, error: { code: -32601, message: 'Only record_review is supported' } }); return;
    }
    if (!session) return;
    if (message.method === 'turn/started') this.bindTurn(session, p.turn?.id);
    if (message.method === 'turn/completed') {
      if (p.turn?.id !== session.turnId) return;
      if (session.ending) return;
      session.ending = true; session.resultCode = p.turn.status === 'completed' ? 0 : 1;
      void this.shutdown();
    }
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
    this.sessions.add(session);
    session.interrupt = async () => {
      session.cancelRequested = true; session.ending = true; session.resultCode = 1;
      if (session.exitCode !== null) return;
      // This process belongs only to this pass. Closing it also stops a hung
      // initialization/turn without depending on an interrupt acknowledgement.
      await this.shutdown();
      await session.ready;
    };
    // Let Queue install launch ownership and close listeners before spawning.
    session.ready = Promise.resolve().then(async () => {
      await this.start();
      if (session.exitCode !== null || session.ending) return;
      const started = await this.request('thread/start', { model: 'gpt-5.6-sol', cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
        baseInstructions: fs.readFileSync(path.join(APP_ROOT, 'src', 'qa-instructions.txt'), 'utf8'),
        config: { 'project_doc_max_bytes': 0, 'skills.include_instructions': false, 'skills.bundled.enabled': false, 'web_search': 'disabled', 'mcp_servers': this.disabledMcp },
        dynamicTools: [RECORD_REVIEW] });
      session.threadId = started.thread.id; this.threads.set(session.threadId, session);
      if (session.exitCode !== null || session.ending) return;
      onIdentity({ appServerPid: this.child.pid, threadId: session.threadId });
      const turn = await this.request('turn/start', { threadId: session.threadId,
        input: [{ type: 'text', text: prompt }, ...files.map(file => ({ type: 'localImage', path: path.join(cwd, file.name), detail: 'original' }))] });
      if (session.exitCode === null && !session.ending) this.bindTurn(session, turn.turn.id);
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
      } finally { clearTimeout(timer); }
    })();
    return this.stopping;
  }
}
module.exports = { AppServer, RECORD_REVIEW };
