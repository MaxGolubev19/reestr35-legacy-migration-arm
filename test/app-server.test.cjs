'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { AppServer } = require('../src/app-server.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
const LAUNCH = Object.freeze({ node: 'node-fixture', script: 'zcode-fixture.cjs', bridge: path.join(__dirname, '..', 'src', 'stages', 'capture-qa', 'qa', 'zcode-bridge.cjs'),
  provider: 'custom:test-provider', model: 'GLM-5.3', reasoning: 'low', apiBase: 'http://127.0.0.1:9', apiKey: 'test-key', personalProviderFile: 'provider-fixture.json' });
function fixture(t, overrides = {}) {
  const frames = [], requests = [], children = []; let number = 0;
  const app = new AppServer({ launch: LAUNCH, requestTimeoutMs: 100, shutdownGraceMs: 20, spawnFn(command, args, options) {
    assert.equal(command, LAUNCH.node); assert.deepEqual(args, [LAUNCH.script, 'app-server']);
    const child = new EventEmitter(); child.pid = 900000 + children.length; child.exitCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.send = frame => child.stdout.write(JSON.stringify(frame) + '\n');
    child.close = () => { child.exitCode = 1; child.stdout.end(); child.emit('close', 1); };
    child.kill = signal => { child.killSignal = signal; if (!overrides.delayKill) setImmediate(() => child.close()); };
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const frame = JSON.parse(String(chunk)); frames.push(frame);
      if (frame.method && frame.id) {
        requests.push(frame);
        queueMicrotask(() => {
          if (overrides.ignore === frame.method) return;
          if (frame.method === 'session/create') child.send({ id: frame.id, result: { session: { sessionId: `sess-${++number}` } } });
          if (frame.method === 'session/subscribe') child.send({ id: frame.id, result: { sessionId: `sess-${number}`, eventSeq: 0 } });
          if (frame.method === 'session/send') {
            child.send({ id: frame.id, result: { accepted: true, sessionId: `sess-${number}`, stateRevision: 2 } });
            if (!overrides.noTurnStart) child.send({ method: 'session/event', params: { sessionId: `sess-${number}`, type: 'turn.started', turnId: `turn-${number}` } });
          }
        });
      }
      callback();
    }, final(callback) { callback(); if (!overrides.ignoreEof) setImmediate(() => child.close()); } });
    children.push(child); return child;
  } });
  t.after(() => app.shutdown());
  return { app, frames, requests, children };
}
function relayOf(ctx, index = 0) {
  const create = ctx.requests.filter(frame => frame.method === 'session/create')[index];
  const [port, token] = create.params.mcpServers[0].args.slice(-2);
  return { port: Number(port), token };
}
function relayCall(context, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: context.port, host: '127.0.0.1' });
    socket.on('error', reject);
    const wire = readline.createInterface({ input: socket });
    wire.on('line', line => { socket.destroy(); resolve(JSON.parse(line)); });
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
  });
}
function review(ctx, onReview = () => ({ accepted: true })) {
  return ctx.app.review({ generation: 1, cwd: __dirname, prompt: 'review all', files: Array.from({ length: 11 }, (_, i) => ({ name: `${i}.png` })), onIdentity() {}, onReview });
}
test('one-shot server restricts the session to record_review and stages every PNG attachment', async t => {
  const ctx = fixture(t), first = review(ctx); await first.ready;
  assert.throws(() => review(ctx), /exactly one QA pass/);
  assert.equal(ctx.children.length, 1);
  for (const frame of ctx.requests.filter(f => f.method === 'session/create')) {
    assert.equal(frame.params.mode, 'yolo'); assert.equal(frame.params.persistence, 'deferred'); assert.equal(frame.params.titleGenerationEnabled, false);
    assert.deepEqual(frame.params.toolAllowlist, ['mcp__reestr35-qa__record_review', 'record_review']);
    assert.equal(frame.params.workspace.workspacePath, __dirname); assert.equal(frame.params.workspace.workspaceKey, __dirname);
    assert.equal(frame.params.model.providerId, LAUNCH.provider); assert.equal(frame.params.model.modelId, LAUNCH.model);
    assert.equal(frame.params.model.options.reasoningLevel, LAUNCH.reasoning);
    const [server] = frame.params.mcpServers;
    assert.equal(server.command, LAUNCH.node); assert.equal(server.args[0], LAUNCH.bridge); assert.equal(server.isolation, 'session');
  }
  for (const frame of ctx.requests.filter(f => f.method === 'session/send')) {
    assert.equal(frame.params.attachments.length, 11);
    assert.ok(frame.params.attachments.every(a => a.kind === 'image' && a.mimeType === 'image/png' && path.isAbsolute(a.localPath)));
    assert.deepEqual(frame.params.attachments.map(a => a.filename), Array.from({ length: 11 }, (_, i) => `${i}.png`));
    assert.ok(frame.params.content.endsWith('review all'));
    assert.ok(frame.params.content.includes('record_review'));
    assert.equal(frame.params.modelSelection.modelId, LAUNCH.model);
  }
  ctx.children[0].send({ method: 'session/event', params: { sessionId: first.threadId, type: 'turn.completed', turnId: first.turnId, payload: { response: 'done' } } });
  assert.equal(first.exitCode, null); assert.equal(ctx.children[0].exitCode, null);
  await flush(); assert.equal(first.exitCode, 0); assert.notEqual(ctx.children[0].exitCode, null);
  assert.equal(first.completionProof, 'app-server-closed');
  assert.throws(() => review(ctx), /exactly one QA pass/);
});
test('relay reviews answer under call id only after callback; stale turn, bad token and foreign kinds rejected', async t => {
  let accepted = 0;
  const ctx = fixture(t), session = review(ctx, args => { assert.deepEqual(args, { name: 'a' }); accepted++; return { reviewed: accepted }; });
  await session.ready;
  const relay = relayOf(ctx);
  const answer = await relayCall(relay, { id: 'r1', token: relay.token, kind: 'record_review', arguments: { name: 'a' } });
  assert.deepEqual(answer, { id: 'r1', reviewed: 1 }); assert.equal(accepted, 1);
  assert.equal((await relayCall(relay, { id: 'r2', token: 'wrong', kind: 'record_review', arguments: { name: 'a' } })).error, 'bad relay token');
  assert.equal((await relayCall(relay, { id: 'r3', token: relay.token, kind: 'shell', arguments: {} })).error, 'unknown relay kind');
  assert.equal((await relayCall(relay, { id: 'r4', token: relay.token, kind: 'record_review', arguments: { name: 'a' } })).reviewed, 2);
  assert.equal(accepted, 2);
  ctx.children[0].send({ id: 103, method: 'session/requestRuntimePreferences', params: { sessionId: session.threadId, scope: 'runtime-materialization' } });
  const preferences = ctx.frames.at(-1);
  assert.equal(preferences.id, 103); assert.equal(preferences.result.memoryEnabled, false); assert.equal(preferences.result.modelContextBudgetStrategy, 'preflight-v1');
  ctx.children[0].send({ id: 104, method: 'subagents/readRuntimeConfig', params: { sessionId: session.threadId } });
  assert.deepEqual(ctx.frames.at(-1), { id: 104, result: { kind: 'built-in-fallback' } });
  ctx.children[0].send({ id: 105, method: 'elicitation/create', params: { sessionId: session.threadId } });
  assert.equal(ctx.frames.at(-1).error.code, -32601);
});
test('review before turn identity is stale; late turn.started binds identity', async t => {
  const ctx = fixture(t, { noTurnStart: true });
  let lateReviews = 0;
  const session = review(ctx, () => { lateReviews++; return {}; });
  await session.ready;
  assert.equal(session.turnId, undefined);
  const relay = relayOf(ctx);
  const answer = await relayCall(relay, { id: 'x', token: relay.token, kind: 'record_review', arguments: { name: 'a' } });
  assert.match(String(answer.error), /Stale relay/); assert.equal(lateReviews, 0);
  ctx.children[0].send({ method: 'session/event', params: { sessionId: session.threadId, type: 'turn.started', turnId: 'turn-late' } });
  await flush();
  assert.equal(session.turnId, 'turn-late');
});
test('reasoning deltas stream to onReasoning; text and empty deltas stay out', async t => {
  const seen = [];
  const ctx = fixture(t);
  const session = ctx.app.review({ generation: 1, cwd: __dirname, prompt: 'think', files: [], onIdentity() {}, onReview() {}, onReasoning: text => seen.push(text) });
  await session.ready;
  const child = ctx.children[0], id = session.threadId;
  child.send({ method: 'session/event', params: { sessionId: id, type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: 'Думаю' } } });
  child.send({ method: 'session/event', params: { events: [
    { sessionId: id, type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: ' пошагово' } },
    { sessionId: id, type: 'model.streaming', payload: { kind: 'text_delta', delta: 'ответ' } },
    { sessionId: id, type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: '' } }
  ] } });
  await flush();
  assert.deepEqual(seen.join(''), 'Думаю пошагово');
  child.send({ method: 'session/event', params: { sessionId: id, type: 'turn.completed', turnId: session.turnId, payload: {} } });
});
test('stop closes dedicated process without waiting for turn acknowledgement', async t => {
  const ctx = fixture(t), session = review(ctx); await session.ready;
  const stopped = session.interrupt(); assert.equal(session.exitCode, null);
  ctx.children[0].send({ method: 'session/event', params: { sessionId: session.threadId, type: 'turn.completed', turnId: 'foreign', payload: {} } });
  assert.equal(session.exitCode, null);
  await stopped; assert.equal(session.exitCode, 1); assert.notEqual(ctx.children[0].exitCode, null);
});
test('transport failure affects only its company; retry requires a fresh server', async t => {
  const ctx = fixture(t), other = fixture(t), a = review(ctx), b = review(other); await Promise.all([a.ready, b.ready]); ctx.children[0].close();
  assert.equal(a.exitCode, 1); assert.equal(b.exitCode, null); assert.equal(a.completionProof, 'app-server-closed');
  assert.throws(() => review(ctx), /exactly one QA pass/);
  const retry = fixture(t), c = review(retry); await c.ready; assert.equal(c.exitCode, null);
});
test('stop before startup never spawns or dispatches QA', async t => {
  const ctx = fixture(t), session = review(ctx); await session.interrupt();
  assert.equal(ctx.children.length, 0); assert.equal(session.exitCode, 1); assert.equal(session.completionProof, 'no-app-server');
});
test('ambiguous RPC timeout does not release a turn until app-server actually closes', async t => {
  const ctx = fixture(t, { ignore: 'session/send', delayKill: true }), session = review(ctx); await session.ready;
  assert.equal(session.exitCode, null); ctx.children[0].close(); assert.equal(session.exitCode, 1);
});
test('completed turn retains slot until forced shutdown closes an EOF-resistant process', async t => {
  const ctx = fixture(t, { ignoreEof: true, delayKill: true }), session = review(ctx); await session.ready;
  ctx.children[0].send({ method: 'session/event', params: { sessionId: session.threadId, type: 'turn.completed', turnId: session.turnId, payload: {} } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(ctx.children[0].killSignal, 'SIGKILL'); assert.equal(session.exitCode, null);
  ctx.children[0].close(); assert.equal(session.exitCode, 0);
});
test('stop during initialization closes process before any QA request; PID is published before create', async t => {
  const ctx = fixture(t, { ignore: 'session/create' }); let pid;
  const session = ctx.app.review({ generation: 1, cwd: __dirname, prompt: 'unused', files: [],
    onIdentity(fields) { pid = fields.appServerPid; assert.equal(ctx.requests.length, 0); }, onReview() {} });
  await flush(); assert.equal(pid, ctx.children[0].pid);
  await session.interrupt(); assert.equal(session.exitCode, 1);
  assert.deepEqual(ctx.requests.map(frame => frame.method), ['session/create']);
});
test('zcode bridge serves MCP record_review through the relay', { timeout: 15000 }, async t => {
  const { spawn } = require('node:child_process');
  let serial = 0; const reviews = [];
  const answers = new Map();
  const relay = net.createServer();
  relay.on('connection', socket => {
    socket.on('error', () => {});
    const wire = readline.createInterface({ input: socket });
    wire.on('error', () => {});
    wire.on('line', line => {
      const message = JSON.parse(line);
      reviews.push(message.arguments);
      if (message.arguments.name === 'b.png') { socket.write(JSON.stringify({ id: message.id, error: 'record_review outside manifest/order or duplicate/hash mismatch' }) + '\n'); return; }
      socket.write(JSON.stringify({ id: message.id, accepted: message.arguments.name }) + '\n');
    });
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(() => relay.close());
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'stages', 'capture-qa', 'qa', 'zcode-bridge.cjs'),
    String(relay.address().port), 'bridge-token'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.on('data', () => {});
  t.after(() => child.kill('SIGKILL'));
  const ask = frame => child.stdin.write(JSON.stringify(frame) + '\n');
  const seen = [];
  const reader = readline.createInterface({ input: child.stdout });
  reader.on('error', () => {});
  reader.on('line', line => seen.push(JSON.parse(line)));
  await new Promise(resolve => setTimeout(resolve, 1500)); // bridge connects its relay socket first
  ask({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  ask({ id: 2, method: 'tools/list' });
  ask({ id: 3, method: 'tools/call', params: { name: 'record_review', arguments: { name: 'a.png', sha256: 'a'.repeat(64), status: 'passed', issues: [] } } });
  ask({ id: 4, method: 'tools/call', params: { name: 'record_review', arguments: { name: 'b.png' } } });
  ask({ id: 5, method: 'unknown/method' });
  await new Promise(resolve => setTimeout(resolve, 500));
  const byId = Object.fromEntries(seen.filter(frame => frame.id !== undefined && frame.result !== undefined || frame.error).map(frame => [frame.id, frame]));
  assert.equal(byId[1].result.protocolVersion, '2025-06-18');
  const tools = byId[2].result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['record_review']);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties).sort(), ['issues', 'name', 'sha256', 'status']);
  assert.equal(JSON.parse(byId[3].result.content[0].text).accepted, 'a.png');
  assert.equal(byId[4].result.isError, true);
  assert.equal(byId[5].error.code, -32601);
  assert.deepEqual(reviews.map(review => review.name), ['a.png', 'b.png']);
});
