'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { testTempRoot, testOutput } = require('./support.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { AppServer } = require('../src/app-server.cjs');
const { Queue, createServer } = require('../src/server.cjs');
const { layout } = require('../src/lib.cjs');
const { atomicJson, paths, loadQa } = require('../src/qa.cjs');
const { publishLease, readLaunch, readLease, recoverLease, launchWorker } = require('../src/launcher.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=', 'base64');
function setup(t, options = {}) {
  const root = options.root || fs.mkdtempSync(path.join(testTempRoot(), 'arm-qa-'));
  const children = [], sessions = [], calls = []; let time = 0;
  const appServers = [];
  const appServerFactory = () => { const appServer = { async shutdown() {}, review(config) {
    const child = new EventEmitter();
    Object.assign(child, { isQa: true, exitCode: null, config, threadId: crypto.randomUUID(), turnId: crypto.randomUUID() });
    child.bind = () => config.onIdentity({ appServerPid: 900000 + appServers.indexOf(appServer), threadId: child.threadId, turnId: child.turnId });
    child.record = (file = config.files[0], overrides = {}, identity = {}) => config.onReview({ name: file.name, sha256: file.sha256, status: 'passed', issues: [], ...overrides }, { generation: config.generation, threadId: child.threadId, turnId: child.turnId, ...identity });
    child.finish = (code = 0) => { child.exitCode = code; child.completionProof = 'app-server-closed'; child.emit('close', code, null); };
    child.interrupt = async () => child.finish(1);
    sessions.push(child); return child;
  } }; appServers.push(appServer); return appServer; };
  const queue = new Queue({ root, autoStart: false, concurrency: 1, qaAutoRetryLimit: 0, clock: () => time, idleTimeoutMs: 100,
    setTimer: () => 1, clearTimer() {}, isPidAlive: () => false, appServerFactory,
    spawnFn(command, args, config) {
      const child = new EventEmitter(); child.pid = 990000 + children.length; child.exitCode = null;
      child.stdin = new Writable({ write(data, encoding, callback) { callback(); } });
      child.finish = code => { if (readLaunch(config.armLaunch.dir)?.token === config.armLaunch.token) publishLease(config.armLaunch.dir, config.armLaunch, { status: 'finished', pid: child.pid, exitCode: code }); child.exitCode = code; child.emit('close', code, null); };
      children.push(child); calls.push({ command, args, config }); return child;
    }, stopFn: async child => child.finish(1), ...options });
  t.after(async () => { queue.closing = true; for (const child of [...children, ...sessions]) if (child.exitCode === null) child.finish(1); await queue.shutdown(); if (!options.root) fs.rmSync(root, { recursive: true, force: true }); });
  return { root, queue, children, calls, sessions, appServers, advance: value => { time += value; } };
}
function capture(ctx, count, finished = true, status = 'complete', job = ctx.queue.jobs[0]) {
  const attempt = job.attempts[0], p = layout(ctx.root, job, attempt);
  fs.mkdirSync(p.hostDir, { recursive: true });
  const segments = Array.from({ length: count }, (_, i) => ({ file: `${String(i).padStart(2, '0')}_tab.png`, status: 'ok', resources: { giantPayload: 'NOT_IN_QA_PROMPT'.repeat(1000) } }));
  for (const segment of segments) fs.writeFileSync(path.join(p.hostDir, segment.file), PNG);
  atomicJson(p.report, { url: job.url, finalUrl: job.url, status, errors: [], segments, ...(finished ? { finished: '2026-09-10T10:00:00Z' } : {}) });
  return { job, attempt, p };
}
function start(t, count = 11, options = {}) { const ctx = setup(t, options); ctx.queue.add('https://a.reestr35.ru'); ctx.queue.pump(); Object.assign(ctx, capture(ctx, count)); return ctx; }
function qa(ctx) { ctx.children[0].finish(0); const child = ctx.sessions.at(-1); child.bind(); return child; }
function pass(child, count = child.config.files.length) { for (const file of child.config.files.slice(0, count)) child.record(file); }

test('relocated history preserves manifest hashes and checkpoints and resumes only remaining QA', t => {
  const ctx = start(t, 2), child = qa(ctx); pass(child, 1); child.finish(1);
  const migrated = fs.mkdtempSync(path.join(testTempRoot(), 'migrated-history-'));
  t.after(() => fs.rmSync(migrated, { recursive: true, force: true }));
  fs.cpSync(ctx.root, migrated, { recursive: true });
  const source = paths(ctx.root, ctx.job, ctx.attempt), target = paths(migrated, ctx.job, ctx.attempt);
  const manifest = fs.readFileSync(source.manifest), progress = fs.readFileSync(source.progress);
  const resumed = setup(t, { root: migrated });
  assert.deepEqual(fs.readFileSync(target.manifest), manifest);
  assert.deepEqual(fs.readFileSync(target.progress), progress);
  resumed.queue['continue-qa'](ctx.job.id); resumed.queue.pump();
  const next = resumed.sessions[0]; next.bind();
  assert.equal(next.config.cwd.startsWith(path.join(migrated, 'qa-staging') + path.sep), true);
  assert.equal(next.config.files.length, 1); assert.equal(next.config.files[0].name, '01_tab.png');
  pass(next); next.finish();
  assert.equal(resumed.children.length, 0);
  assert.equal(resumed.queue.jobs[0].attempts[0].status, 'complete');
  assert.deepEqual(fs.readFileSync(target.manifest), manifest);
});

test('early PNG discovery, transient JSON and unlisted file privacy survive', t => {
  const ctx = start(t, 2); capture(ctx, 2, false); fs.writeFileSync(path.join(ctx.p.hostDir, 'foreign.png'), PNG);
  const snap = ctx.queue.snapshot('').jobs[0].attempts[0]; assert.equal(snap.files.filter(f => f.kind === 'png').length, 2); assert.equal(snap.qa.reviewed, 0); assert.equal(ctx.attempt.captureSealed, undefined);
  fs.writeFileSync(ctx.p.report, '{'); assert.deepEqual(ctx.queue.snapshot('').jobs[0].attempts[0].files, snap.files);
});
test('one capture and one QA turn receive all 11 PNG; each call commits and updates UI before completion', t => {
  const ctx = start(t), child = qa(ctx); assert.equal(ctx.sessions.length, 1); assert.equal(child.config.files.length, 11);
  assert.ok(!child.config.prompt.includes('NOT_IN_QA_PROMPT')); assert.ok(!child.config.prompt.includes('capture-report.json')); assert.equal(fs.readdirSync(child.config.cwd).length, 11);
  let snapshot = ctx.queue.snapshot('').jobs[0].attempts[0];
  assert.deepEqual(snapshot.qa.segments.map(file => file.name), child.config.files.map(file => file.name));
  assert.deepEqual(snapshot.qa.segments.map(file => file.status), Array(11).fill('pending'));
  for (const [i, file] of child.config.files.entries()) {
    assert.equal(child.record(file).reviewed, i + 1); assert.equal(loadQa(ctx.root, ctx.job, ctx.attempt).progress.checkpoints.length, i + 1);
    assert.equal(ctx.attempt.files.filter(f => f.qaStatus === 'passed').length, i + 1); assert.equal(ctx.attempt.status, 'running'); assert.equal(ctx.sessions.length, 1);
    snapshot = ctx.queue.snapshot('').jobs[0].attempts[0];
    assert.deepEqual(snapshot.qa.segments.map(item => item.name), child.config.files.map(item => item.name));
    assert.deepEqual(snapshot.qa.segments.map(item => item.status), [...Array(i + 1).fill('passed'), ...Array(10 - i).fill('pending')]);
  }
  child.finish(); assert.equal(ctx.attempt.status, 'complete'); assert.equal(ctx.children.length, 1); assert.equal(fs.existsSync(child.config.cwd), false); assert.equal(ctx.queue.active.size, 0);
});
test('partial failure resumes only remaining six PNG, preserving five checkpoints across restart', t => {
  const ctx = start(t), child = qa(ctx); pass(child, 5); child.finish(1); assert.equal(ctx.attempt.status, 'needs_review');
  const resumed = setup(t, { root: ctx.root }), job = resumed.queue.jobs[0]; resumed.queue['continue-qa'](job.id); resumed.queue.pump();
  const next = resumed.sessions[0]; next.bind(); assert.equal(next.config.files.length, 6); assert.equal(next.config.files[0].name, '05_tab.png'); assert.equal(next.config.generation, 2); pass(next); next.finish();
  assert.equal(job.attempts[0].status, 'complete'); assert.equal(job.attempts.length, 1); assert.equal(resumed.children.length, 0);
});
test('checkpoint rename before state save survives; live previous server blocks retry and late calls stay fenced', t => {
  const ctx = start(t, 6), child = qa(ctx), oldState = fs.readFileSync(ctx.queue.stateFile); pass(child, 5); fs.writeFileSync(ctx.queue.stateFile, oldState);
  const resumed = setup(t, { root: ctx.root, isPidAlive: () => true }); assert.equal(resumed.queue.jobs[0].attempts[0].qa.reviewed, 5);
  assert.throws(() => resumed.queue['continue-qa'](ctx.job.id), { statusCode: 409 }); resumed.advance(6000); assert.throws(() => resumed.queue['continue-qa'](ctx.job.id), { statusCode: 409 });
  resumed.queue.isPidAlive = () => false; resumed.queue['continue-qa'](ctx.job.id); resumed.queue.pump(); const next = resumed.sessions[0]; next.bind(); assert.equal(next.config.files.length, 1);
  assert.throws(() => child.record(child.config.files[5]), /Stale/); child.finish(); assert.equal(resumed.queue.active.size, 1); pass(next); next.finish(); assert.equal(resumed.queue.jobs[0].attempts[0].status, 'complete');
});
test('generation reserved before review; pending QA restart needs owner death and grace', t => {
  const ctx = start(t, 1); ctx.children[0].finish(0); const pending = readLaunch(ctx.p.dir); assert.equal(pending.leaseProtocol, 3); assert.equal(pending.qaGeneration, 1);
  assert.equal(loadQa(ctx.root, ctx.job, ctx.attempt).progress.generation, 1); assert.equal(ctx.attempt.pid, undefined);
  const resumed = setup(t, { root: ctx.root }); assert.equal(resumed.queue.canContinueQa(resumed.queue.jobs[0]), false); resumed.advance(6000); assert.equal(resumed.queue.canContinueQa(resumed.queue.jobs[0]), true);
});

test('restart reserves global concurrency for unfinished QA lease until finished proof or both PID deaths after grace', t => {
  for (const completion of ['finished', 'dead']) {
    const ctx = start(t, 2), oldSession = qa(ctx); oldSession.record(); ctx.queue.closing = true;
    const launch = readLaunch(ctx.p.dir), lease = readLease(ctx.p.dir, launch);
    let serverAlive = true, backendAlive = false, stopCalls = 0;
    const resumed = setup(t, { root: ctx.root, concurrency: 1,
      isPidAlive: pid => pid === lease.appServerPid ? serverAlive : pid === launch.backendPid && backendAlive,
      stopFn: async () => { stopCalls++; throw new Error('Recovery must not stop a foreign process'); } });
    resumed.queue.add('https://b.reestr35.ru');
    assert.equal(resumed.queue.active.size, 0); assert.equal(resumed.queue.recoveredQa.size, 1);
    resumed.queue.pump(); assert.equal(resumed.children.length, 0, 'live old QA reserves the only slot');
    assert.equal(resumed.queue.jobs[1].attempts[0].status, 'queued');
    assert.equal(resumed.queue.jobs[0].attempts[0].qa.reviewed, 1);
    if (completion === 'finished') {
      oldSession.finish(1);
      assert.equal(readLease(ctx.p.dir, launch).status, 'finished');
    } else {
      serverAlive = false;
      resumed.queue.pump(); assert.equal(resumed.children.length, 0, 'PID absence before grace is insufficient');
      resumed.advance(6000); serverAlive = true;
      resumed.queue.pump(); assert.equal(resumed.children.length, 0, 'living app-server reserves capacity after grace');
      serverAlive = false; backendAlive = true;
      resumed.queue.pump(); assert.equal(resumed.children.length, 0, 'living backend still blocks recovery');
      backendAlive = false;
    }
    resumed.queue.pump();
    assert.equal(resumed.queue.recoveredQa.size, 0); assert.equal(resumed.children.length, 1);
    assert.equal(resumed.queue.jobs[1].attempts[0].status, 'running');
    assert.equal(readLease(ctx.p.dir, launch).status, 'finished');
    if (completion === 'dead') assert.equal(readLease(ctx.p.dir, launch).proof, 'qa-owner-and-server-dead');
    assert.equal(resumed.queue.jobs[0].attempts[0].qa.reviewed, 1);
    assert.equal(stopCalls, 0);
  }
});
test('invalid shape/status/issues/hash/order/duplicate and stale identities never change checkpoints', t => {
  const ctx = start(t, 2), child = qa(ctx), file = child.config.files[0];
  const acceptedEvents = [], unsubscribe = ctx.queue.subscribeReviews(event => acceptedEvents.push({ ...event, checkpoints: loadQa(ctx.root, ctx.job, ctx.attempt).progress.checkpoints.length })); t.after(unsubscribe);
  for (const overrides of [{ extra: true }, { name: 'foreign.png' }, { sha256: '0'.repeat(64) }, { status: 'unreviewed' }, { status: 'issues', issues: [] }, { issues: ['problem'] }, { status: 'issues', issues: [''] }, { status: 'issues', issues: [1] }, { issues: null }]) { assert.throws(() => child.record(file, overrides)); assert.equal(ctx.attempt.qa.reviewed, 0); assert.equal(acceptedEvents.length, 0); }
  for (const identity of [{ generation: 0 }, { generation: 99 }, { threadId: 'foreign' }, { turnId: 'foreign' }]) assert.throws(() => child.record(file, {}, identity));
  assert.throws(() => child.record(child.config.files[1]), /order/); child.record(file); assert.throws(() => child.record(file), /duplicate/); assert.equal(ctx.attempt.qa.reviewed, 1);
  assert.deepEqual(acceptedEvents, [{ jobId: ctx.job.id, attempt: 1, name: file.name, checkpoints: 1 }]);
});
test('accepted defects persist across retry; final text or successful exit alone cannot pass', t => {
  const ctx = start(t, 2), child = qa(ctx); child.record(child.config.files[0], { status: 'issues', issues: ['Текст обрезан'] });
  assert.deepEqual(ctx.queue.snapshot('').jobs[0].attempts[0].qa.segments.map(file => file.status), ['issues', 'pending']);
  child.finish(); assert.equal(ctx.attempt.status, 'incomplete');
  ctx.queue['continue-qa'](ctx.job.id); ctx.queue.pump(); const next = ctx.sessions[1]; next.bind(); pass(next); next.finish(); assert.equal(ctx.attempt.status, 'incomplete'); assert.equal(ctx.attempt.qa.issues, 1);
  const empty = start(t, 1), emptyQa = qa(empty); emptyQa.finish(); assert.equal(empty.attempt.status, 'needs_review');
});
test('technically incomplete capture exit 2 still receives visual QA and never becomes complete', t => {
  const ctx = start(t, 1); capture(ctx, 1, true, 'incomplete'); ctx.children[0].finish(2); const child = ctx.sessions[0]; child.bind(); pass(child); child.finish(); assert.equal(ctx.attempt.status, 'incomplete'); assert.equal(ctx.attempt.qa.reviewed, 1);
});
test('state projection failure after commit still acknowledges accepted durable checkpoint', t => {
  const ctx = start(t, 1), child = qa(ctx), save = ctx.queue.save;
  ctx.queue.save = () => { throw new Error('disk failure'); };
  assert.equal(child.record().reviewed, 1); assert.equal(loadQa(ctx.root, ctx.job, ctx.attempt).progress.checkpoints.length, 1); assert.equal(ctx.attempt.files.find(f => f.kind === 'png').qaStatus, 'passed');
  ctx.queue.save = save; child.finish(); assert.equal(ctx.attempt.status, 'complete');
});
test('finished QA lease write/rename failure releases only proven completion, preserves checkpoints and retries publication', t => {
  for (const operation of ['writeFileSync', 'renameSync']) {
    for (const proof of ['app-server-closed', 'no-app-server']) {
      const ctx = start(t, 2, { isPidAlive: () => true }), child = qa(ctx); child.record();
      const launch = readLaunch(ctx.p.dir), leasePath = path.join(ctx.p.dir, `launch-${launch.token}-lease.json`);
      const original = fs[operation]; let failures = 0;
      fs[operation] = function (...args) {
        const isFinishedLease = operation === 'renameSync'
          ? String(args[1]) === leasePath
          : String(args[0]).startsWith(leasePath + '.') && typeof args[1] === 'string' && JSON.parse(args[1]).status === 'finished';
        if (isFinishedLease && failures++ === 0) throw Object.assign(new Error('fixture EPERM finished lease'), { code: 'EPERM' });
        return original.apply(this, args);
      };
      try {
        assert.doesNotThrow(() => { child.exitCode = 1; child.completionProof = proof; child.emit('close', 1, null); });
      } finally { fs[operation] = original; }
      assert.equal(failures, 1); assert.equal(ctx.queue.active.size, 0); assert.equal(ctx.queue.monitors.size, 0);
      assert.equal(ctx.attempt.status, 'needs_review'); assert.equal(ctx.attempt.qa.reviewed, 1); assert.match(ctx.attempt.error, /EPERM finished lease/);
      assert.equal(readLease(ctx.p.dir, launch).status, 'running');
      assert.equal(loadQa(ctx.root, ctx.job, ctx.attempt).progress.checkpoints.length, 1);
      assert.equal(JSON.parse(fs.readFileSync(ctx.queue.stateFile)).jobs[0].attempts[0].status, 'needs_review');
      assert.equal(ctx.queue.snapshot('').jobs[0].canStop, false);
      assert.equal(readLease(ctx.p.dir, launch).status, 'finished'); assert.equal(readLease(ctx.p.dir, launch).proof, proof);
      ctx.queue['continue-qa'](ctx.job.id); ctx.queue.pump(); const next = ctx.sessions[1]; next.bind();
      assert.equal(next.config.files.length, 1); assert.equal(next.config.files[0].name, '01_tab.png');
      assert.throws(() => child.record(child.config.files[1]), /Stale/); child.emit('close', 0, null);
      assert.equal(ctx.queue.active.get(ctx.job.id), next); pass(next); next.finish();
      assert.equal(ctx.attempt.status, 'complete'); assert.equal(ctx.queue.qaCompletions.size, 0);
    }
  }
});
test('persistent finished-lease failure blocks continuation without retaining a dead QA slot', t => {
  const ctx = start(t, 2, { isPidAlive: () => true }), child = qa(ctx); child.record();
  const leasePath = path.join(ctx.p.dir, `launch-${readLaunch(ctx.p.dir).token}-lease.json`), original = fs.renameSync;
  fs.renameSync = function (...args) { if (String(args[1]) === leasePath) throw Object.assign(new Error('fixture EPERM persistent'), { code: 'EPERM' }); return original.apply(this, args); };
  try {
    child.finish(1); assert.equal(ctx.queue.active.size, 0);
    const snapshot = ctx.queue.snapshot('').jobs[0]; assert.equal(snapshot.canStop, false); assert.equal(snapshot.canContinueQa, false);
    assert.throws(() => ctx.queue['continue-qa'](ctx.job.id), { statusCode: 409 }); assert.throws(() => ctx.queue.retry(ctx.job.id), { statusCode: 409 });
  } finally { fs.renameSync = original; }
  ctx.queue['continue-qa'](ctx.job.id); ctx.queue.pump(); const next = ctx.sessions[1]; next.bind(); pass(next); next.finish();
  assert.equal(ctx.attempt.status, 'complete');
});
test('manifest/report/missing/foreign/changed PNG reject next review and full result', t => {
  for (const change of ['manifest', 'report', 'missing', 'foreign', 'bytes']) {
    const ctx = start(t, 2), child = qa(ctx); child.record();
    if (change === 'manifest') fs.appendFileSync(paths(ctx.root, ctx.job, ctx.attempt).manifest, 'broken');
    if (change === 'report') { const report = JSON.parse(fs.readFileSync(ctx.p.report)); report.extra = true; atomicJson(ctx.p.report, report); }
    if (change === 'missing') fs.unlinkSync(path.join(ctx.p.hostDir, child.config.files[1].name));
    if (change === 'foreign') fs.writeFileSync(path.join(ctx.p.hostDir, 'foreign.png'), PNG);
    if (change === 'bytes') fs.appendFileSync(path.join(ctx.p.hostDir, child.config.files[1].name), 'bad');
    assert.throws(() => child.record(child.config.files[1])); child.finish(); assert.equal(ctx.attempt.status, 'incomplete'); assert.equal(ctx.attempt.qa.reviewed, 1); assert.throws(() => ctx.queue['continue-qa'](ctx.job.id), { statusCode: 409 });
  }
});
test('checkpoint persistence failure cannot acknowledge or update accepted state', t => {
  const ctx = start(t, 1), child = qa(ctx), progress = paths(ctx.root, ctx.job, ctx.attempt).progress; fs.unlinkSync(progress); fs.mkdirSync(progress);
  assert.throws(() => child.record()); assert.equal(ctx.attempt.qa.reviewed, 0); fs.rmdirSync(progress); atomicJson(progress, ctx.queue.qaState(ctx.job, ctx.attempt).progress); child.record(); child.finish(); assert.equal(ctx.attempt.status, 'complete');
});
test('persisted checkpoint order, generation, duplicate and shape are validated', t => {
  const ctx = start(t, 2), child = qa(ctx); pass(child); child.finish(); const p = paths(ctx.root, ctx.job, ctx.attempt).progress, original = JSON.parse(fs.readFileSync(p));
  for (const mutate of [v => v.checkpoints.reverse(), v => v.checkpoints.push(v.checkpoints[0]), v => { v.checkpoints[1].generation = 99; }, v => { v.checkpoints[0].review.extra = true; }]) { const changed = structuredClone(original); mutate(changed); atomicJson(p, changed); assert.throws(() => loadQa(ctx.root, ctx.job, ctx.attempt)); } atomicJson(p, original);
});
test('idle timeout starts after report sealed and resets on each checkpoint; stderr does not reset it', async t => {
  const ctx = start(t, 2); capture(ctx, 2, false); ctx.advance(1000); await ctx.queue.tick(ctx.job, ctx.attempt, ctx.children[0]); assert.equal(ctx.children[0].exitCode, null);
  capture(ctx, 2); const child = qa(ctx); ctx.advance(99); child.record(); ctx.advance(99); await ctx.queue.tick(ctx.job, ctx.attempt, child); assert.equal(child.exitCode, null);
  child.config.onLog('endless logs'); ctx.advance(2); await ctx.queue.tick(ctx.job, ctx.attempt, child); assert.equal(ctx.attempt.timeoutReason, 'idle_timeout'); assert.equal(ctx.attempt.status, 'needs_review'); assert.equal(ctx.attempt.qa.reviewed, 1);
});
test('interrupt failure retains slot/canStop and blocks retry; late record rejected', async t => {
  const ctx = start(t, 2), child = qa(ctx); child.record(); child.interrupt = async () => { throw new Error('interrupt denied'); }; ctx.advance(101); await ctx.queue.tick(ctx.job, ctx.attempt, child);
  assert.equal(ctx.queue.active.size, 1); assert.equal(ctx.queue.snapshot('').jobs[0].canStop, true); assert.equal(fs.existsSync(child.config.cwd), true);
  assert.throws(() => ctx.queue['continue-qa'](ctx.job.id), { statusCode: 409 }); assert.throws(() => ctx.queue.retry(ctx.job.id), { statusCode: 409 }); assert.throws(() => child.record(child.config.files[1]), /Stale/); await assert.rejects(ctx.queue.stop(ctx.job.id), /denied/);
  assert.equal(ctx.attempt.cancellationRequested, undefined); child.finish(1); assert.equal(ctx.queue.active.size, 0);
});
test('user cancellation prevents automatic continuation and rejects late review', async t => {
  const ctx = start(t, 2, { qaAutoRetryLimit: 3 }), child = qa(ctx); child.record(); await ctx.queue.stop(ctx.job.id); assert.equal(ctx.attempt.status, 'cancelled'); ctx.advance(10000); ctx.queue.pump(); assert.equal(ctx.sessions.length, 1); assert.throws(() => child.record(child.config.files[1]), /Stale/);
});
test('automatic retry only remainder, at most three delayed failures; manual continue resets budget', t => {
  const ctx = start(t, 6, { qaAutoRetryLimit: 3, qaRetryDelayMs: 50 }), child = qa(ctx); pass(child, 5); child.finish(1); assert.equal(ctx.attempt.status, 'queued'); assert.equal(ctx.attempt.qaAutoRetries, 1);
  for (let i = 0; i < 3; i++) { const before = ctx.sessions.length; ctx.queue.pump(); assert.equal(ctx.sessions.length, before); ctx.advance(50); ctx.queue.pump(); const next = ctx.sessions.at(-1); next.bind(); assert.equal(next.config.files.length, 1); next.finish(1); }
  assert.equal(ctx.attempt.status, 'needs_review'); assert.equal(ctx.attempt.qaAutoRetries, 3); ctx.queue['continue-qa'](ctx.job.id); ctx.queue.pump(); const next = ctx.sessions.at(-1); next.bind(); pass(next); assert.equal(ctx.attempt.qaAutoRetries, 0); next.finish(); assert.equal(ctx.attempt.status, 'complete');
});
test('concurrency counts captures and QA turns; reducing limit preserves both', t => {
  const ctx = start(t, 1, { concurrency: 2 }), child = qa(ctx); ctx.queue.add('https://b.reestr35.ru\nhttps://c.reestr35.ru'); ctx.queue.pump(); assert.equal(ctx.queue.active.size, 2); assert.equal(ctx.children.length, 2); ctx.queue.setConcurrency(1); assert.equal(ctx.queue.active.size, 2);
  child.record(); child.finish(); assert.equal(ctx.children.length, 2); ctx.children[1].finish(1); assert.equal(ctx.children.length, 3);
});

test('two companies use separate app-server processes; failure and stop retry only missing checkpoints in fresh processes', { timeout: 15000 }, async t => {
  const processes = [], passes = [];
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > deadline) assert.fail('Process fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const ctx = setup(t, { concurrency: 2, appServerFactory() {
    const app = new AppServer({ spawnFn(command, args, config) {
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/qa-app-server.cjs')], { ...config, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
      child.on('message', message => { if (message.type === 'turn') child.turnInput = message.input; });
      processes.push(child); return child;
    } });
    const review = app.review.bind(app);
    app.review = config => { const session = review(config); passes.push({ app, session, config }); return session; };
    return app;
  } });
  assert.equal(processes.length, 0, 'idle backend has no app-server');
  ctx.queue.add('https://a.reestr35.ru\nhttps://b.reestr35.ru'); ctx.queue.pump();
  for (const job of ctx.queue.jobs) capture(ctx, 3, true, 'complete', job);
  for (const child of [...ctx.children]) child.finish(0);
  await Promise.all(passes.map(pass => pass.session.ready));
  await until(() => processes.length === 2 && processes.every(child => child.turnInput));
  assert.notEqual(processes[0].pid, processes[1].pid);
  assert.equal(ctx.queue.active.size, 2); assert.equal(ctx.queue.qaServers.size, 2);
  for (const [index, child] of processes.entries()) {
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    const images = child.turnInput.filter(item => item.type === 'localImage');
    assert.equal(images.length, 3); assert.ok(images.every(item => item.detail === 'original'));
    const job = ctx.queue.jobs[index], lease = readLease(layout(ctx.root, job, job.attempts[0]).dir, job.attempts[0].launch);
    assert.equal(lease.appServerPid, child.pid);
  }
  const result = file => ({ name: file.name, sha256: file.sha256, status: 'passed', issues: [] });
  processes[0].send({ reviews: [result(passes[0].config.files[0])], status: 'failed' });
  await until(() => passes[0].session.exitCode !== null);
  assert.equal(passes[0].app.child, null); assert.equal(ctx.queue.active.size, 1);
  assert.equal(ctx.queue.jobs[0].attempts[0].qa.reviewed, 1);
  assert.equal(passes[1].session.exitCode, null, 'other company survives process completion');
  ctx.queue['continue-qa'](ctx.queue.jobs[0].id); ctx.queue.pump();
  await passes[2].session.ready; await until(() => processes[2].turnInput);
  assert.equal(new Set(processes.map(child => child.pid)).size, 3);
  assert.equal(ctx.queue.active.size, 2);
  assert.deepEqual(passes[2].config.files.map(file => file.name), ['01_tab.png', '02_tab.png']);
  assert.equal(processes[2].turnInput.filter(item => item.type === 'localImage').length, 2);
  await ctx.queue.stop(ctx.queue.jobs[1].id);
  assert.equal(ctx.queue.jobs[1].attempts[0].status, 'cancelled'); assert.equal(passes[1].app.child, null);
  assert.equal(passes[2].session.exitCode, null, 'stopping one company preserves the other process');
  assert.equal(ctx.queue.active.size, 1);
  ctx.queue['continue-qa'](ctx.queue.jobs[1].id); ctx.queue.pump();
  await passes[3].session.ready; await until(() => processes[3].turnInput);
  assert.equal(new Set(processes.map(child => child.pid)).size, 4);
  assert.equal(passes[3].config.files.length, 3, 'stopped company has no accepted checkpoints');
  for (const index of [2, 3]) processes[index].send({ reviews: passes[index].config.files.map(result), status: 'completed' });
  await until(() => ctx.queue.active.size === 0);
  assert.equal(ctx.queue.qaServers.size, 0); assert.equal(ctx.children.length, 2, 'capture was not repeated');
  for (const child of processes) assert.ok(child.exitCode !== null || child.signalCode !== null);
  for (const job of ctx.queue.jobs) {
    assert.equal(job.attempts[0].status, 'complete');
    assert.equal(loadQa(ctx.root, job, job.attempts[0]).progress.checkpoints.length, 3);
  }
});
test('continue API strict empty body, CSRF/Origin and conflicts', async t => {
  const ctx = start(t, 1), child = qa(ctx); child.finish(1); const server = createServer(ctx.queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`, state = await (await fetch(base + '/api/state')).json();
  const post = (body = {}, headers = {}) => fetch(`${base}/api/jobs/${ctx.job.id}/continue-qa`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.csrfToken, ...headers }, body: JSON.stringify(body) });
  for (const body of [[], null, { force: true }]) assert.equal((await post(body)).status, 400); assert.equal((await post({}, { Origin: 'https://evil.test' })).status, 403); assert.equal((await post({}, { 'x-csrf-token': 'bad' })).status, 403); assert.equal((await post()).status, 200); assert.equal((await post()).status, 409);
});
test('SSE review subscription disconnects cleanly; polling state remains independently available', async t => {
  const ctx = setup(t), server = createServer(ctx.queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`, controller = new AbortController();
  const events = await fetch(base + '/api/events', { signal: controller.signal });
  assert.equal(events.status, 200); assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  const reader = events.body.getReader(); await reader.read(); assert.equal(ctx.queue.reviewListeners.size, 1);
  await reader.cancel(); controller.abort();
  for (let i = 0; i < 50 && ctx.queue.reviewListeners.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ctx.queue.reviewListeners.size, 0);
  assert.equal((await fetch(base + '/api/state')).status, 200, 'polling fallback does not depend on SSE');
});
test('legacy accepted batch checkpoint remains readable; new turn gets only remainder', t => {
  const ctx = start(t, 6), child = qa(ctx); child.finish(1); const state = ctx.queue.qaState(ctx.job, ctx.attempt), files = state.manifest.files.slice(0, 5), batch = { batchId: crypto.randomUUID(), generation: 1, manifestHash: state.manifest.hash, files };
  atomicJson(paths(ctx.root, ctx.job, ctx.attempt).progress, { version: 2, generation: 1, manifestHash: state.manifest.hash, checkpoints: [{ batch, result: { ...batch, files: files.map(f => ({ name: f.name, sha256: f.sha256, status: 'passed', issues: [] })), summary: 'old' } }] });
  const resumed = setup(t, { root: ctx.root }); resumed.queue['continue-qa'](ctx.job.id); resumed.queue.pump(); const next = resumed.sessions[0]; next.bind(); assert.equal(next.config.files[0].name, '05_tab.png'); pass(next); next.finish(); assert.equal(resumed.queue.jobs[0].attempts[0].status, 'complete');
});
test('trusted capture launcher identity and completion; recovery never trusts heartbeat alone', async t => {
  const ctx = setup(t), dir = ctx.root, launch = { token: crypto.randomUUID(), generation: 1, phase: 'capture', status: 'launch-pending', leaseProtocol: 2, createdAtMs: 0 }, descriptor = path.join(dir, `launch-${launch.token}.json`);
  atomicJson(path.join(dir, 'launch-current.json'), launch); atomicJson(descriptor, { ...launch, command: process.execPath, args: ['-e', "process.stdin.resume();console.log('ready');process.stdin.on('end',()=>{process.exitCode=2;});"], cwd: dir });
  const child = launchWorker('', [], { cwd: dir, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], armLaunch: { ...launch, descriptor } }), closed = new Promise(resolve => child.once('close', resolve));
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); }); const running = readLease(dir, launch); assert.equal(running.wrapperPid, child.pid); assert.ok(running.childPid > 0); assert.equal(recoverLease(dir, launch, { timestamp: 10000, graceMs: 5000, isPidAlive: () => true }), false); child.stdin.end(); assert.equal(await closed, 2); assert.equal(readLease(dir, launch).status, 'finished');
});
test('capture recovery exclusive claim, foreign/corrupt lease and both PID guards', t => {
  for (const kind of ['missing', 'live', 'one-live', 'dead', 'foreign', 'corrupt']) {
    const ctx = setup(t), dir = ctx.root, launch = { token: crypto.randomUUID(), generation: 1, phase: 'capture', leaseProtocol: 2, createdAtMs: 0 }; atomicJson(path.join(dir, 'launch-current.json'), launch);
    if (kind !== 'missing') publishLease(dir, launch, { status: 'running', wrapperPid: 1, childPid: 2 });
    if (kind === 'foreign') atomicJson(path.join(dir, `launch-${launch.token}-lease.json`), { token: 'foreign', generation: 1, status: 'finished' }); if (kind === 'corrupt') fs.writeFileSync(path.join(dir, `launch-${launch.token}-lease.json`), '{');
    const recover = () => recoverLease(dir, launch, { timestamp: 10000, graceMs: 5000, isPidAlive: pid => kind === 'live' || (kind === 'one-live' && pid === 2) }); if (['foreign', 'corrupt'].includes(kind)) assert.throws(recover); else assert.equal(recover(), ['missing', 'dead'].includes(kind));
  }
});
