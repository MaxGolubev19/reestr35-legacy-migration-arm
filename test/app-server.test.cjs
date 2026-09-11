'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { AppServer, RECORD_REVIEW } = require('../src/app-server.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const frames = [], requests = [], children = []; let number = 0;
  const app = new AppServer({ requestTimeoutMs: 100, shutdownGraceMs: 20, spawnFn(command, args, options) {
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
          if (frame.method === 'initialize') child.send({ id: frame.id, result: {} });
          if (frame.method === 'config/read') child.send({ id: frame.id, result: { config: { mcp_servers: { dangerous: { command: 'do-not-run' } } } } });
          if (frame.method === 'thread/start') child.send({ id: frame.id, result: { thread: { id: `thread-${++number}` } } });
          if (frame.method === 'turn/start') {
            const id = `turn-${number}`; child.send({ method: 'turn/started', params: { threadId: frame.params.threadId, turn: { id } } });
            child.send({ id: frame.id, result: { turn: { id } } });
          }
          if (frame.method === 'turn/interrupt') child.send({ id: frame.id, result: {} });
        });
      }
      callback();
    }, final(callback) { callback(); if (!overrides.ignoreEof) setImmediate(() => child.close()); } });
    children.push(child); return child;
  } });
  t.after(() => app.shutdown());
  return { app, frames, requests, children };
}
function review(ctx, onReview = () => ({ accepted: true })) {
  return ctx.app.review({ generation: 1, cwd: __dirname, prompt: 'review all', files: Array.from({ length: 11 }, (_, i) => ({ name: `${i}.png` })), onIdentity() {}, onReview });
}
test('one-shot server sends every original localImage and waits for process close', async t => {
  const ctx = fixture(t), first = review(ctx); await first.ready;
  assert.throws(() => review(ctx), /exactly one QA pass/);
  assert.equal(ctx.children.length, 1); assert.equal(ctx.requests.filter(f => f.method === 'initialize').length, 1);
  for (const frame of ctx.requests.filter(f => f.method === 'thread/start')) {
    assert.equal(frame.params.ephemeral, true); assert.equal(frame.params.approvalPolicy, 'never'); assert.equal(frame.params.sandbox, 'read-only');
    assert.deepEqual(frame.params.dynamicTools, [RECORD_REVIEW]);
    assert.deepEqual(frame.params.config.mcp_servers, { dangerous: { enabled: false } });
  }
  for (const frame of ctx.requests.filter(f => f.method === 'turn/start')) {
    assert.equal(frame.params.input.length, 12); assert.ok(frame.params.input.slice(1).every(i => i.type === 'localImage' && i.detail === 'original' && path.isAbsolute(i.path)));
  }
  ctx.children[0].send({ method: 'turn/completed', params: { threadId: first.threadId, turn: { id: first.turnId, status: 'completed' } } });
  assert.equal(first.exitCode, null); assert.equal(ctx.children[0].exitCode, null);
  await flush(); assert.equal(first.exitCode, 0); assert.notEqual(ctx.children[0].exitCode, null);
  assert.equal(first.completionProof, 'app-server-closed');
  assert.throws(() => review(ctx), /exactly one QA pass/);
});
test('dynamic request returns result under RPC id only after callback; foreign tools/thread/turn rejected', async t => {
  let accepted = 0;
  const ctx = fixture(t), session = review(ctx, args => { assert.deepEqual(args, { name: 'a' }); accepted++; return { reviewed: accepted }; }); await session.ready;
  const call = (id, changes = {}) => ctx.children[0].send({ id, method: 'item/tool/call', params: { threadId: session.threadId, turnId: session.turnId, callId: 'call', tool: 'record_review', arguments: { name: 'a' }, ...changes } });
  call(101); assert.equal(accepted, 1); assert.deepEqual(ctx.frames.at(-1), { id: 101, result: { success: true, contentItems: [{ type: 'inputText', text: '{"reviewed":1}' }] } });
  for (const changes of [{ tool: 'shell' }, { namespace: 'unexpected' }, { threadId: 'other' }, { turnId: 'old' }]) { call(102, changes); assert.equal(ctx.frames.at(-1).result.success, false); }
  assert.equal(accepted, 1);
  ctx.children[0].send({ id: 103, method: 'item/commandExecution/requestApproval', params: { threadId: session.threadId } }); assert.equal(ctx.frames.at(-1).error.code, -32601);
});
test('stop closes dedicated process without waiting for turn acknowledgement', async t => {
  const ctx = fixture(t), session = review(ctx); await session.ready;
  const stopped = session.interrupt(); assert.equal(session.exitCode, null);
  ctx.children[0].send({ method: 'turn/completed', params: { threadId: session.threadId, turn: { id: 'foreign', status: 'interrupted' } } }); assert.equal(session.exitCode, null);
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
  const ctx = fixture(t, { ignore: 'turn/start', delayKill: true }), session = review(ctx); await session.ready;
  assert.equal(session.exitCode, null); ctx.children[0].close(); assert.equal(session.exitCode, 1);
});

test('completed turn retains slot until forced shutdown closes an EOF-resistant process', async t => {
  const ctx = fixture(t, { ignoreEof: true, delayKill: true }), session = review(ctx); await session.ready;
  ctx.children[0].send({ method: 'turn/completed', params: { threadId: session.threadId, turn: { id: session.turnId, status: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(ctx.children[0].killSignal, 'SIGKILL'); assert.equal(session.exitCode, null);
  ctx.children[0].close(); assert.equal(session.exitCode, 0);
});

test('stop during initialization closes process before any QA request; PID is published before initialize', async t => {
  const ctx = fixture(t, { ignore: 'initialize' }); let pid;
  const session = ctx.app.review({ generation: 1, cwd: __dirname, prompt: 'unused', files: [],
    onIdentity(fields) { pid = fields.appServerPid; assert.equal(ctx.requests.length, 0); }, onReview() {} });
  await flush(); assert.equal(pid, ctx.children[0].pid);
  await session.interrupt(); assert.equal(session.exitCode, 1);
  assert.deepEqual(ctx.requests.map(frame => frame.method), ['initialize']);
});
