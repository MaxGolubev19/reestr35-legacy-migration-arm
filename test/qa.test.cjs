'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { testTempRoot, testOutput, copyTree } = require('./support.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { AppServer } = require('../src/app-server.cjs');
const { BRIDGE } = require('../src/stages/capture-qa/qa/config.cjs');
const { Queue, createServer } = require('../src/server.cjs');
const { layout, captureInventory, captureCoverage, inspectArtifacts } = require('../src/lib.cjs');
const { atomicJson, paths, loadQa, hash, QA_POLICY, counts, checkManifest } = require('../src/qa.cjs');
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
    // This suite owns the capture/QA contract; html-media.test exercises composed transitions.
    stageFactory: (queue, config) => new (require('../src/stages/capture-qa/index.cjs').CaptureQaStage)(queue, config),
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
  const first = [{ group: 0, index: 0 }];
  const model = count === 1 ? { layout: 'plain', root: null, groups: [] } : { layout: 'tabs', root: 0, groups: [{ id: 0, labels: Array(count - 1).fill('tab'), children: Array.from({ length: count - 1 }, () => []), items: Array.from({ length: count - 1 }, () => ({ mode: 'pane', empty: false })) }] };
  const segments = Array.from({ length: count }, (_, i) => ({
    file: count === 1 ? '00_страница.png' : i === 0 ? '00_header.png' : `${String(i).padStart(2, '0')}_tab.png`,
    spec: count === 1 ? { kind: 'page' } : i === 0 ? { kind: 'header' } : { kind: 'tab', group: 0, index: i - 1 },
    chain: count === 1 ? [] : i === 0 ? first : [{ group: 0, index: i - 1 }],
    box: { x: 0, y: i, width: 1, height: 1 }, png: { width: 1, height: 1, strips: 1 },
    status: 'ok', resources: { giantPayload: 'NOT_IN_QA_PROMPT'.repeat(1000) },
  }));
  for (const segment of segments) fs.writeFileSync(path.join(p.hostDir, segment.file), PNG);
  if (count > 1) segments.push({ spec: { kind: 'footer' }, chain: first, status: 'absent', absent: true, meaningful: 0 });
  atomicJson(p.report, { url: job.url, finalUrl: job.url, model, status, errors: [], segments, ...(finished ? { finished: '2026-09-10T10:00:00Z' } : {}) });
  return { job, attempt, p };
}
function start(t, count = 11, options = {}) { const ctx = setup(t, options); ctx.queue.add('https://a.reestr35.ru'); ctx.queue.pump(); Object.assign(ctx, capture(ctx, count)); return ctx; }
function qa(ctx) { ctx.children[0].finish(0); const child = ctx.sessions.at(-1); child.bind(); return child; }
function pass(child, count = child.config.files.length) { for (const file of child.config.files.slice(0, count)) child.record(file); }

test('composed workflow pauses for missing HTML only after final QA process close and preserves capture result', t => {
  const ctx = start(t, 1, { stageFactory: require('../src/pipeline/registry.cjs').createStage });
  const child = qa(ctx); pass(child);
  assert.equal(ctx.attempt.phase, 'qa'); assert.equal(ctx.queue.snapshot('').jobs[0].isActive, true);
  child.finish();
  assert.equal(ctx.attempt.phase, 'html-media'); assert.equal(ctx.attempt.status, 'paused'); assert.equal(ctx.attempt.captureStatus, 'complete');
  assert.equal(ctx.attempt.htmlMedia.status, 'missing'); assert.equal(ctx.queue.active.size, 0); assert.equal(ctx.sessions.length, 1);
  const result = JSON.parse(fs.readFileSync(path.join(ctx.p.dir, 'result.json')));
  assert.equal(result.status, 'complete'); assert.equal(result.phase, 'qa');
});

test('QA pause preserves accepted checkpoints across restart and resumes only the unreviewed remainder', async t => {
  const ctx = start(t, 3), child = qa(ctx); pass(child, 1);
  assert.equal(ctx.attempt.status, 'validating'); assert.equal(ctx.queue.snapshot('').jobs[0].canPause, true);
  const accepted = fs.readFileSync(paths(ctx.root, ctx.job, ctx.attempt).progress);
  let finishPause;
  child.interrupt = () => new Promise(resolve => { finishPause = () => { child.finish(1); resolve(); }; });
  ctx.queue.pause(ctx.job.id);
  assert.equal(ctx.attempt.status, 'pausing'); assert.equal(ctx.queue.active.size, 1);
  assert.throws(() => child.record(child.config.files[1]), /Stale/);
  assert.throws(() => ctx.queue.resume(ctx.job.id), { statusCode: 409 });
  assert.deepEqual(fs.readFileSync(paths(ctx.root, ctx.job, ctx.attempt).progress), accepted);
  finishPause(); assert.equal(ctx.attempt.status, 'paused'); assert.equal(ctx.queue.active.size, 0);
  ctx.queue.autoStart = true; ctx.queue.pump(); assert.equal(ctx.sessions.length, 1, 'pause suppresses automatic retries');
  ctx.queue.closing = true;
  const recovered = setup(t, { root: ctx.root });
  const job = recovered.queue.jobs[0];
  assert.equal(job.attempts[0].status, 'paused'); assert.equal(job.attempts[0].qa.reviewed, 1);
  recovered.queue.resume(job.id); recovered.queue.pump();
  const next = recovered.sessions[0]; next.bind();
  assert.deepEqual(next.config.files.map(file => file.name), child.config.files.slice(1).map(file => file.name));
  assert.equal(job.attempts.length, 1); assert.equal(recovered.children.length, 0);
  pass(next); next.finish(); assert.equal(job.attempts[0].status, 'complete');
  assert.deepEqual(loadQa(ctx.root, job, job.attempts[0]).progress.checkpoints[0], JSON.parse(accepted).checkpoints[0]);
});

test('restart reconciles a durable pause request after process completion but before paused state save', t => {
  const ctx = start(t, 3), child = qa(ctx); pass(child, 1); ctx.queue.pause(ctx.job.id);
  assert.equal(ctx.attempt.status, 'paused');
  ctx.attempt.status = 'pausing'; ctx.queue.save(); ctx.queue.closing = true;
  const recovered = setup(t, { root: ctx.root }), attempt = recovered.queue.jobs[0].attempts[0];
  assert.equal(attempt.status, 'paused'); assert.equal(attempt.phase, 'qa');
  assert.equal(recovered.queue.snapshot('').jobs[0].canResume, true); assert.equal(attempt.qa.reviewed, 1);
});

// Count actual PNG buffers read through descriptors and then passed to SHA-256;
// report/manifest JSON hashing must not inflate the PNG counters.
function measurePngIO(run) {
  const original = { open: fs.openSync, close: fs.closeSync, read: fs.readFileSync, hash: crypto.createHash, readdir: fs.readdirSync };
  const descriptors = new Map(), buffers = new WeakSet();
  const result = { reads: [], bytes: 0, hashes: 0, hashBytes: 0, jsonReads: [], directories: 0 };
  fs.openSync = function(file, ...args) {
    const fd = original.open.call(this, file, ...args); descriptors.set(fd, String(file)); return fd;
  };
  fs.closeSync = function(fd) { try { return original.close.call(this, fd); } finally { descriptors.delete(fd); } };
  fs.readFileSync = function(file, ...args) {
    const data = original.read.call(this, file, ...args), name = typeof file === 'number' ? descriptors.get(file) : String(file);
    if (name?.endsWith('.png')) { result.reads.push(path.basename(name)); result.bytes += data.length; if (Buffer.isBuffer(data)) buffers.add(data); }
    if (name?.endsWith('.json')) result.jsonReads.push(path.basename(name));
    return data;
  };
  fs.readdirSync = function(...args) { result.directories++; return original.readdir.apply(this, args); };
  crypto.createHash = function(...args) {
    const digest = original.hash.apply(this, args), update = digest.update;
    digest.update = function(data, ...rest) {
      if (Buffer.isBuffer(data) && buffers.has(data)) { result.hashes++; result.hashBytes += data.length; }
      return update.call(this, data, ...rest);
    };
    return digest;
  };
  try { result.value = run(); return result; }
  finally { fs.openSync = original.open; fs.closeSync = original.close; fs.readFileSync = original.read; crypto.createHash = original.hash; fs.readdirSync = original.readdir; }
}

function completedCapture(t, count = 3) {
  const ctx = start(t, count), child = qa(ctx); pass(child); child.finish(); return ctx;
}

test('state snapshots read each PNG once cold and zero times warm while checking JSON and directory membership freshly', t => {
  const ctx = completedCapture(t);
  const cold = measurePngIO(() => ctx.queue.snapshot('token'));
  assert.equal(cold.reads.length, 3); assert.equal(cold.hashes, 3);
  assert.equal(cold.bytes, PNG.length * 3); assert.equal(cold.hashBytes, cold.bytes);
  assert.equal(cold.jsonReads.filter(name => name === 'capture-report.json').length, 1);
  assert.equal(cold.jsonReads.filter(name => name === 'capture-manifest.json').length, 1);
  assert.equal(cold.directories, 1); assert.equal(cold.value.jobs[0].status, 'complete');
  for (let i = 0; i < 3; i++) {
    const warm = measurePngIO(() => ctx.queue.snapshot('token'));
    assert.deepEqual(warm.value, cold.value);
    assert.equal(warm.reads.length, 0); assert.equal(warm.bytes, 0); assert.equal(warm.hashes, 0); assert.equal(warm.hashBytes, 0);
    assert.equal(warm.jsonReads.filter(name => name === 'capture-report.json').length, 1);
    assert.equal(warm.jsonReads.filter(name => name === 'capture-manifest.json').length, 1);
    assert.equal(warm.directories, 1);
  }
  ctx.queue.save();
  assert.doesNotMatch(JSON.stringify(cold.value), /snapshotPngCache|mtimeNs|ctimeNs|birthtimeNs/);
  assert.doesNotMatch(fs.readFileSync(ctx.queue.stateFile, 'utf8'), /snapshotPngCache|mtimeNs|ctimeNs|birthtimeNs/);
});

test('snapshot cache invalidates only changed PNG after same-size write with restored mtime and after atomic replacement', t => {
  for (const change of ['write', 'replace']) {
    const ctx = completedCapture(t), name = '01_tab.png', file = path.join(ctx.p.hostDir, name);
    const timestamp = new Date('2020-01-02T03:04:05.000Z');
    fs.utimesSync(file, timestamp, timestamp);
    ctx.queue.snapshot('');
    const before = fs.statSync(file, { bigint: true }), modified = Buffer.from(PNG); modified[modified.length - 1] ^= 1;
    if (change === 'write') { fs.writeFileSync(file, modified); fs.utimesSync(file, timestamp, timestamp); }
    else {
      const replacement = path.join(ctx.p.hostDir, 'replacement.tmp');
      fs.writeFileSync(replacement, modified); fs.utimesSync(replacement, timestamp, timestamp); fs.renameSync(replacement, file);
    }
    const after = fs.statSync(file, { bigint: true });
    assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs);
    if (change === 'write') assert.notEqual(after.ctimeNs, before.ctimeNs);
    else assert.ok(after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs);
    const changed = measurePngIO(() => ctx.queue.snapshot(''));
    assert.deepEqual(changed.reads, [name]); assert.equal(changed.hashes, 1); assert.equal(changed.value.jobs[0].status, 'incomplete');
    const pngs = changed.value.jobs[0].attempts[0].files.filter(item => item.kind === 'png');
    assert.equal(pngs.find(item => item.name === name).qaStatus, 'unreviewed');
    assert.equal(pngs.filter(item => item.name !== name).every(item => item.qaStatus === 'passed'), true);
    assert.equal(measurePngIO(() => ctx.queue.snapshot('')).reads.length, 0);
    fs.writeFileSync(file, PNG);
    const repaired = measurePngIO(() => ctx.queue.snapshot(''));
    assert.deepEqual(repaired.reads, [name]); assert.equal(repaired.value.jobs[0].status, 'complete');
  }
});

test('warm snapshot rejects missing/foreign/non-file PNG and fresh report or manifest corruption; repair recovers', t => {
  for (const change of ['missing', 'foreign', 'non-file', 'ihdr', 'report', 'report-json', 'manifest']) {
    const ctx = completedCapture(t), name = '01_tab.png', file = path.join(ctx.p.hostDir, name);
    const p = paths(ctx.root, ctx.job, ctx.attempt), report = fs.readFileSync(p.report), manifest = fs.readFileSync(p.manifest);
    ctx.queue.snapshot('');
    if (change === 'missing' || change === 'non-file') fs.unlinkSync(file);
    if (change === 'non-file') fs.mkdirSync(file);
    if (change === 'foreign') fs.writeFileSync(path.join(p.hostDir, 'foreign.png'), PNG);
    if (change === 'ihdr') { const broken = Buffer.from(PNG); broken.writeUInt32BE(0, 16); fs.writeFileSync(file, broken); }
    if (change === 'report') atomicJson(p.report, { ...JSON.parse(report), extra: true });
    if (change === 'report-json') fs.writeFileSync(p.report, '{');
    if (change === 'manifest') fs.writeFileSync(p.manifest, '{');
    const invalid = measurePngIO(() => ctx.queue.snapshot(''));
    assert.equal(invalid.value.jobs[0].status, 'incomplete', change);
    assert.equal(invalid.value.jobs[0].attempts[0].files.some(item => item.name === 'foreign.png'), false);
    assert.equal(invalid.reads.length, change === 'ihdr' ? 1 : 0, change);
    if (change === 'non-file') fs.rmdirSync(file);
    if (['missing', 'non-file', 'ihdr'].includes(change)) fs.writeFileSync(file, PNG);
    if (change === 'foreign') fs.unlinkSync(path.join(p.hostDir, 'foreign.png'));
    if (change.startsWith('report')) fs.writeFileSync(p.report, report);
    if (change === 'manifest') fs.writeFileSync(p.manifest, manifest);
    assert.equal(ctx.queue.snapshot('').jobs[0].status, 'complete', change);
  }
});

test('warm snapshot rechecks attempt containment after host directory is replaced by a junction', t => {
  const ctx = completedCapture(t), outside = path.join(ctx.root, 'outside-attempt');
  ctx.queue.snapshot('');
  fs.renameSync(ctx.p.hostDir, outside);
  fs.symlinkSync(outside, ctx.p.hostDir, process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = measurePngIO(() => ctx.queue.snapshot(''));
  assert.equal(escaped.value.jobs[0].status, 'incomplete'); assert.equal(escaped.reads.length, 0);
  fs.unlinkSync(ctx.p.hostDir); fs.renameSync(outside, ctx.p.hostDir);
  assert.equal(ctx.queue.snapshot('').jobs[0].status, 'complete');
});

test('strict manifest verification bypasses a warm snapshot cache and rejects changed bytes', t => {
  const ctx = completedCapture(t), manifest = ctx.queue.qaState(ctx.job, ctx.attempt).manifest;
  ctx.queue.snapshot('');
  const checked = measurePngIO(() => checkManifest(ctx.root, ctx.job, ctx.attempt, manifest));
  assert.equal(checked.reads.length, 3); assert.equal(checked.hashes, 3);
  const file = path.join(ctx.p.hostDir, '01_tab.png'), modified = Buffer.from(PNG); modified[modified.length - 1] ^= 1;
  fs.writeFileSync(file, modified);
  const rejected = measurePngIO(() => assert.throws(() => checkManifest(ctx.root, ctx.job, ctx.attempt, manifest), /Capture изменён/));
  assert.equal(rejected.reads.length, 3); assert.equal(rejected.hashes, 3);
});

test('stable PNG reads compare every identity field with the current path before accepting bytes', t => {
  const ctx = completedCapture(t), file = fs.realpathSync(path.join(ctx.p.hostDir, '01_tab.png'));
  const { stableReadWithIdentity } = require('../src/infrastructure/files.cjs');
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs']) {
    const original = fs.statSync;
    fs.statSync = function(target, options) {
      const stat = original.call(this, target, options);
      if (target === file && options?.bigint) stat[field] += 1n;
      return stat;
    };
    try { assert.throws(() => stableReadWithIdentity(file), /Файл изменяется/, field); }
    finally { fs.statSync = original; }
  }
});

test('capture completion queues QA after earlier captures and each pass holds its own FIFO slot until close', t => {
  const ctx = setup(t);
  ctx.queue.add('https://first.reestr35.ru/\nhttps://second.reestr35.ru/');
  const [first, second] = ctx.queue.jobs;
  ctx.queue.pump();
  capture(ctx, 1, true, 'complete', first);
  ctx.children[0].finish(0);
  assert.equal(ctx.children.length, 2);
  assert.equal(ctx.sessions.length, 0);
  assert.equal(first.attempts[0].phase, 'qa');
  assert.equal(first.attempts[0].status, 'queued');
  assert.ok(first.attempts[0].queueOrder > second.attempts[0].queueOrder);
  capture(ctx, 1, true, 'complete', second);
  ctx.children[1].finish(0);
  assert.equal(ctx.sessions.length, 1);
  assert.ok(ctx.queue.active.has(first.id));
  const firstQa = ctx.sessions[0]; firstQa.bind(); pass(firstQa);
  ctx.queue.pump();
  assert.equal(ctx.sessions.length, 1, 'accepted final checkpoint alone does not release the process slot');
  firstQa.finish();
  assert.equal(ctx.sessions.length, 2);
  assert.equal(first.attempts[0].status, 'complete');
  assert.ok(ctx.queue.active.has(second.id));
  const secondQa = ctx.sessions[1]; secondQa.bind(); pass(secondQa); secondQa.finish();
  assert.equal(second.attempts[0].status, 'complete');
  assert.equal(ctx.children.length, 2, 'QA never re-runs capture');
});

test('relocated history preserves manifest hashes and checkpoints and resumes only remaining QA', t => {
  const ctx = start(t, 2), child = qa(ctx); pass(child, 1); child.finish(1);
  const migrated = fs.mkdtempSync(path.join(testTempRoot(), 'migrated-history-'));
  t.after(() => fs.rmSync(migrated, { recursive: true, force: true }));
  copyTree(ctx.root, migrated);
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
  assert.ok(!child.config.prompt.includes('NOT_IN_QA_PROMPT')); assert.ok(!child.config.prompt.includes('capture-report.json'));
  assert.deepEqual(fs.readdirSync(child.config.cwd).filter(name => name !== 'AGENTS.md'), child.config.files.map(file => file.name));
  assert.ok(fs.readFileSync(path.join(child.config.cwd, 'AGENTS.md'), 'utf8').includes('QA staging'));
  let snapshot = ctx.queue.snapshot('').jobs[0].attempts[0];
  assert.deepEqual(snapshot.qa.segments.map(file => file.name), child.config.files.map(file => file.name));
  assert.deepEqual(snapshot.qa.segments.map(file => file.status), Array(11).fill('pending'));
  for (const [i, file] of child.config.files.entries()) {
    assert.equal(child.record(file).reviewed, i + 1); assert.equal(loadQa(ctx.root, ctx.job, ctx.attempt).progress.checkpoints.length, i + 1);
    assert.equal(ctx.attempt.files.filter(f => f.qaStatus === 'passed').length, i + 1); assert.equal(ctx.attempt.status, 'validating'); assert.equal(ctx.sessions.length, 1);
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

test('QA close cleanup failure is diagnostic and still commits result/state and continues FIFO', t => {
  const ctx = start(t, 1), child = qa(ctx); pass(child);
  ctx.queue.add('https://next.reestr35.ru');
  const original = fs.rmSync;
  fs.rmSync = function(file, ...args) {
    if (file === child.config.cwd) throw Object.assign(new Error('fixture cleanup EPERM'), { code: 'EPERM' });
    return original.call(this, file, ...args);
  };
  try { assert.doesNotThrow(() => child.finish()); } finally { fs.rmSync = original; }
  assert.equal(ctx.attempt.status, 'complete'); assert.match(ctx.attempt.qaCleanupError, /cleanup EPERM/);
  assert.equal(ctx.queue.pendingFinalizations.size, 0); assert.equal(ctx.children.length, 2);
  assert.equal(readLease(ctx.p.dir, readLaunch(ctx.p.dir)).status, 'finished');
  assert.equal(loadQa(ctx.root, ctx.job, ctx.attempt).progress.checkpoints.length, 1);
  const result = JSON.parse(fs.readFileSync(path.join(ctx.p.dir, 'result.json')));
  assert.equal(result.status, 'complete'); assert.match(result.qaCleanupError, /cleanup EPERM/);
  assert.equal(JSON.parse(fs.readFileSync(ctx.queue.stateFile)).jobs[0].attempts[0].status, 'complete');
});

test('QA close result/state failures retain completion and checkpoints and retry before dispatch', t => {
  for (const operation of ['result', 'state']) {
    const ctx = start(t, 1, { stageFactory: require('../src/pipeline/registry.cjs').createStage }), child = qa(ctx); pass(child);
    ctx.queue.add('https://next.reestr35.ru');
    const progress = fs.readFileSync(paths(ctx.root, ctx.job, ctx.attempt).progress);
    const target = operation === 'state' ? ctx.queue.stateFile : path.join(ctx.p.dir, 'result.json'), original = fs.renameSync;
    fs.renameSync = function(source, destination) {
      if (destination === target) throw new Error(`fixture ${operation} failure`);
      return original.call(this, source, destination);
    };
    try {
      assert.doesNotThrow(() => child.finish());
      assert.equal(ctx.attempt.status, 'interrupted'); assert.equal(ctx.attempt.finalizationError.operation, operation);
      assert.equal(ctx.queue.active.size, 0); assert.equal(ctx.queue.monitors.size, 0); assert.equal(ctx.queue.pendingFinalizations.size, 1);
      assert.equal(readLease(ctx.p.dir, readLaunch(ctx.p.dir)).status, 'finished');
      assert.deepEqual(fs.readFileSync(paths(ctx.root, ctx.job, ctx.attempt).progress), progress);
      assert.doesNotThrow(() => ctx.queue.pump()); assert.equal(ctx.children.length, 1);
      const projected = ctx.queue.snapshot('').jobs[0];
      assert.equal(projected.isActive, false); assert.equal(projected.canRecapture, false); assert.equal(projected.canResume, false);
      assert.throws(() => ctx.queue.retry(ctx.job.id), { statusCode: 409 });
      assert.throws(() => ctx.queue.resume(ctx.job.id), { statusCode: 409 });
    } finally { fs.renameSync = original; }
    ctx.queue.pump();
    assert.equal(ctx.queue.pendingFinalizations.size, 0); assert.equal(ctx.children.length, 2);
    assert.equal(ctx.attempt.phase, 'html-media'); assert.equal(ctx.attempt.status, 'paused');
    assert.equal(ctx.attempt.finalizationError, undefined);
    const result = JSON.parse(fs.readFileSync(path.join(ctx.p.dir, 'result.json')));
    assert.equal(result.status, 'complete'); assert.equal(result.phase, 'qa');
    assert.equal(JSON.parse(fs.readFileSync(ctx.queue.stateFile)).jobs[0].attempts[0].status, 'paused');
    assert.deepEqual(fs.readFileSync(paths(ctx.root, ctx.job, ctx.attempt).progress), progress);
  }
});

test('restart after QA result failure preserves diagnosis and resume reconstructs result without repeating reviews', t => {
  const stageFactory = require('../src/pipeline/registry.cjs').createStage;
  const ctx = start(t, 1, { stageFactory }), child = qa(ctx); pass(child);
  const target = path.join(ctx.p.dir, 'result.json'), original = fs.renameSync;
  fs.renameSync = function(source, destination) {
    if (destination === target) throw new Error('fixture result restart');
    return original.call(this, source, destination);
  };
  try { child.finish(); } finally { fs.renameSync = original; }
  ctx.queue.closing = true;
  const recovered = setup(t, { root: ctx.root, stageFactory }), job = recovered.queue.jobs[0], attempt = job.attempts[0];
  assert.equal(attempt.status, 'interrupted'); assert.equal(attempt.finalizationError.operation, 'result');
  assert.equal(attempt.phase, 'qa');
  recovered.queue.pump(); assert.equal(recovered.sessions.length, 0); assert.equal(attempt.status, 'interrupted');
  recovered.queue.resume(job.id); recovered.queue.pump();
  assert.equal(attempt.status, 'paused'); assert.equal(attempt.phase, 'html-media'); assert.equal(recovered.sessions.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(target)).status, 'complete');
  assert.equal(loadQa(ctx.root, job, attempt).progress.checkpoints.length, 1);
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
      assert.equal(ctx.queue.snapshot('').jobs[0].isActive, false);
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
    const snapshot = ctx.queue.snapshot('').jobs[0]; assert.equal(snapshot.isActive, false); assert.equal(snapshot.canContinueQa, false);
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
test('interrupt failure retains slot/isActive and blocks retry; late record rejected', async t => {
  const ctx = start(t, 2), child = qa(ctx); child.record(); child.interrupt = async () => { throw new Error('interrupt denied'); }; ctx.advance(101); await ctx.queue.tick(ctx.job, ctx.attempt, child);
  assert.equal(ctx.queue.active.size, 1); assert.equal(ctx.queue.snapshot('').jobs[0].isActive, true); assert.equal(fs.existsSync(child.config.cwd), true);
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
    const app = new AppServer({ launch: { node: process.execPath, script: 'zcode-fixture', bridge: BRIDGE, provider: 'custom:fixture', model: 'GLM-5.3', reasoning: 'low', personalProviderFile: 'provider-fixture.json' }, spawnFn(command, args, config) {
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
    const images = child.turnInput.attachments;
    assert.equal(images.length, 3);
    assert.ok(images.every(item => item.kind === 'image' && item.mimeType === 'image/png'));
    assert.ok(images.every(item => path.isAbsolute(item.localPath) && fs.existsSync(item.localPath)));
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
  assert.equal(processes[2].turnInput.attachments.length, 2);
  ctx.queue.pause(ctx.queue.jobs[1].id);
  await until(() => ctx.queue.jobs[1].attempts[0].status === 'paused');
  assert.equal(passes[1].app.child, null);
  assert.equal(passes[2].session.exitCode, null, 'stopping one company preserves the other process');
  assert.equal(ctx.queue.active.size, 1);
  ctx.queue.resume(ctx.queue.jobs[1].id); ctx.queue.pump();
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
test('legacy accepted batch checkpoint remains history; current policy starts all images', t => {
  const ctx = start(t, 6), child = qa(ctx); child.finish(1); const state = ctx.queue.qaState(ctx.job, ctx.attempt), files = state.manifest.files.slice(0, 5), batch = { batchId: crypto.randomUUID(), generation: 1, manifestHash: state.manifest.hash, files };
  atomicJson(paths(ctx.root, ctx.job, ctx.attempt).progress, { version: 2, generation: 1, manifestHash: state.manifest.hash, checkpoints: [{ batch, result: { ...batch, files: files.map(f => ({ name: f.name, sha256: f.sha256, status: 'passed', issues: [] })), summary: 'old' } }] });
  const resumed = setup(t, { root: ctx.root }); resumed.queue['continue-qa'](ctx.job.id); resumed.queue.pump(); const next = resumed.sessions[0]; next.bind(); assert.equal(next.config.files[0].name, '00_header.png'); assert.equal(next.config.files.length, 6); pass(next); next.finish(); assert.equal(resumed.queue.jobs[0].attempts[0].status, 'complete');
  const restored = loadQa(ctx.root, ctx.job, ctx.attempt); assert.equal(restored.progress.checkpoints.length, 7); assert.equal(counts(restored.manifest, restored.progress).historicalReviews, 5);
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

function nestedReport() {
  const pane = () => ({ mode: 'pane', empty: false });
  const root = [{ group: 0, index: 0 }], child = [...root, { group: 1, index: 0 }], leaf = [...child, { group: 2, index: 0 }];
  const saved = (file, spec, chain, extra = {}) => ({ file, spec, chain, status: 'ok', box: { x: 1, y: 1, width: 1, height: 1 }, png: { width: 1, height: 1, strips: 1 }, ...extra });
  return { model: { layout: 'tabs', root: 0, groups: [
    { id: 0, labels: ['Parent', 'Empty'], children: [[1], []], items: [pane(), { mode: 'empty', empty: true }] },
    { id: 1, labels: ['Child'], children: [[2]], items: [pane()] },
    { id: 2, labels: ['Leaf'], children: [[]], items: [pane()] },
  ] }, errors: [], segments: [
    saved('00_header.png', { kind: 'header' }, root),
    saved('01_parent.png', { kind: 'tab', group: 0, index: 0 }, root),
    saved('01.01_parent__child.png', { kind: 'tab', group: 1, index: 0 }, child),
    saved('01.01.01_parent__child__leaf.png', { kind: 'tab', group: 2, index: 0 }, leaf),
    { spec: { kind: 'tail', group: 1, index: 0 }, chain: child, status: 'absent', absent: true, meaningful: 0 },
    saved('01_parent__продолжение.png', { kind: 'tail', group: 0, index: 0 }, root),
    saved('02_empty.png', { kind: 'tab', group: 0, index: 1 }, [{ group: 0, index: 1 }], { empty: true }),
    { spec: { kind: 'footer' }, chain: root, status: 'absent', absent: true, meaningful: 0 },
  ] };
}
const reportFiles = report => report.segments.filter(segment => segment?.file).map(segment => ({ name: segment.file, kind: 'png' }));
test('coverage independently enumerates recursive tabs, tails, footer and empty PNG', () => {
  const report = nestedReport(), result = captureCoverage(captureInventory(report), reportFiles(report));
  assert.equal(result.valid, true, result.issues.join('; '));
  assert.deepEqual(result.expected.map(item => item.name), [
    '00_header.png', '01_parent.png', '01.01_parent__child.png', '01.01.01_parent__child__leaf.png',
    '01.01_parent__child__продолжение.png', '01_parent__продолжение.png', '02_empty.png', '99_footer.png',
  ]);
  assert.equal(result.expected[6].empty, true); assert.equal(result.expected[6].optional, false);
});
test('coverage rejects malformed model ownership, root, indices, shape and cycles', () => {
  const mutations = {
    noModel: report => { delete report.model; },
    noGroups: report => { delete report.model.groups; },
    noRoot: report => { delete report.model.root; },
    wrongRoot: report => { report.model.root = 99; },
    stringRoot: report => { report.model.root = '0'; },
    duplicateGroup: report => { report.model.groups[1].id = 0; },
    negativeGroup: report => { report.model.groups[1].id = -1; },
    reorderedGroups: report => { report.model.groups.reverse(); },
    labelsMismatch: report => { report.model.groups[0].labels.pop(); },
    childShape: report => { report.model.groups[0].children[0] = 1; },
    unknownChild: report => { report.model.groups[0].children[0] = [99]; },
    stringChild: report => { report.model.groups[0].children[0] = ['1']; },
    sharedChild: report => { report.model.groups[2].children[0] = [1]; },
    rootCycle: report => { report.model.groups[2].children[0] = [0]; },
    selfCycle: report => { report.model.groups[0].children[0] = []; report.model.groups[1].children[0] = [1]; },
    disconnectedCycle: report => { report.model.groups[0].children[0] = []; report.model.groups[2].children[0] = [1]; },
    unreachable: report => { report.model.groups[0].children[0] = []; },
    emptyOwnsChild: report => { report.model.groups[0].children[1] = [2]; },
    emptyMismatch: report => { report.model.groups[0].items[1].empty = false; },
    unsupportedMode: report => { report.model.groups[0].items[1].mode = 'guess'; },
    nonTrailingUnmatched: report => { report.model.groups[0].items.reverse(); },
    plainWithTabs: report => { report.model.layout = 'plain'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const report = nestedReport(); mutate(report);
    const result = captureCoverage(captureInventory(report), reportFiles(report));
    assert.equal(result.valid, false, name); assert.ok(result.issues.length, name);
  }
});
test('coverage rejects missing/duplicate/extra segments, wrong chains and illegal absent', () => {
  const mutations = {
    missingHeader: report => report.segments.shift(),
    missingTab: report => report.segments.splice(3, 1),
    missingTail: report => report.segments.splice(4, 1),
    missingFooter: report => report.segments.pop(),
    duplicateTab: report => report.segments.splice(3, 0, structuredClone(report.segments[2])),
    extraPage: report => report.segments.push({ ...report.segments[0], file: '00_страница.png', spec: { kind: 'page' }, chain: [] }),
    wrongIndex: report => { report.segments[2].spec.index = 1; },
    stringIndex: report => { report.segments[2].spec.index = '0'; },
    wrongChain: report => { report.segments[2].chain = [{ group: 1, index: 0 }]; },
    reordered: report => { [report.segments[1], report.segments[2]] = [report.segments[2], report.segments[1]]; },
    incorrectName: report => { report.segments[3].file = 'wrong.png'; },
    aliasName: report => { report.segments[3].file = report.segments[2].file; },
    missingPng: report => { delete report.segments[3].file; },
    absentHeader: report => { report.segments[0] = { spec: { kind: 'header' }, chain: [{ group: 0, index: 0 }], status: 'absent', absent: true }; },
    absentEmpty: report => { report.segments[6] = { spec: { kind: 'tab', group: 0, index: 1 }, chain: [{ group: 0, index: 1 }], status: 'absent', absent: true }; },
    contradictoryAbsent: report => { report.segments[7].file = '99_footer.png'; },
    notRequested: report => { report.segments[3].status = 'not-requested'; },
    unknownStatus: report => { report.segments[3].status = 'success'; },
    nullSegment: report => { report.segments[3] = null; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const report = nestedReport(); mutate(report);
    assert.equal(captureCoverage(captureInventory(report), reportFiles(report)).valid, false, name);
  }
  const report = nestedReport(), files = reportFiles(report);
  assert.equal(captureCoverage(captureInventory(report), files.slice(1)).valid, false, 'missing physical PNG');
  assert.equal(captureCoverage(captureInventory(report), [...files, { name: 'foreign.png', kind: 'png' }]).valid, false, 'foreign physical PNG');
});
test('absent tail/footer require proven zero content, no file/png and valid optional empty-space box', () => {
  for (const index of [4, 7]) {
    const report = nestedReport(), segment = report.segments[index];
    const inspect = value => captureCoverage(captureInventory(value), reportFiles(value));
    assert.equal(inspect(report).valid, true, 'zero geometry may omit box');
    segment.box = { x: 10, y: 20, width: 100, height: 40 };
    assert.equal(inspect(report).valid, true, 'positive empty-space rectangle is allowed by helper');
    for (const meaningful of [1, -1, '0', null, undefined, false]) {
      const changed = structuredClone(report); changed.segments[index].meaningful = meaningful;
      assert.equal(inspect(changed).valid, false, `meaningful=${String(meaningful)}`);
    }
    for (const field of ['file', 'png']) {
      const changed = structuredClone(report); changed.segments[index][field] = null;
      assert.equal(inspect(changed).valid, false, `${field} must be absent, not null`);
    }
    for (const box of [null, {}, { x: 0, y: 0, width: 0, height: 40 }, { x: 0, y: 0, width: 10, height: -1 }, { x: 0, y: 0, width: '100', height: 40 }]) {
      const changed = structuredClone(report); changed.segments[index].box = box;
      assert.equal(inspect(changed).valid, false, 'malformed absent rectangle');
    }
  }
});
test('plain needs exactly its one whole-page PNG and no tab model or absent exception', t => {
  const ctx = start(t, 1), report = JSON.parse(fs.readFileSync(ctx.p.report));
  const inspect = value => captureCoverage(captureInventory(value), reportFiles(value));
  assert.equal(inspect(report).valid, true);
  for (const mutate of [v => { v.model.root = 0; }, v => { delete v.model.root; }, v => { v.segments[0].status = 'absent'; delete v.segments[0].file; delete v.segments[0].png; }, v => { v.segments[0].chain = [{ group: 0, index: 0 }]; }, v => { v.segments.push({ ...v.segments[0], spec: { kind: 'footer' } }); }]) {
    const value = structuredClone(report); mutate(value); assert.equal(inspect(value).valid, false);
  }
});
test('full inventory and compact failed-resource diagnostics survive every remainder prompt', t => {
  const ctx = start(t, 3), report = JSON.parse(fs.readFileSync(ctx.p.report));
  report.segments[0].resources = { fonts: 'loading', images: [{ src: 'https://x/ok.png', ok: true, payload: 'DROP_OK_PAYLOAD' }, { src: 'https://x/bad.png', original: 'https://x/original.png', ok: false, naturalWidth: 0, complete: false }], frames: [{ src: 'https://x/frame', ok: false, reason: 'blank document', requiresVisualReview: true }] };
  report.segments[0].issues = Array.from({ length: 25 }, (_, i) => `issue ${i}`);
  report.segments[0].error = 'Segment error\n    at STACK_NOT_FOR_MODEL';
  report.errors = ['Capture problem\n    at STACK_NOT_FOR_MODEL']; report.status = 'incomplete';
  atomicJson(ctx.p.report, report);
  const child = qa(ctx), state = ctx.queue.qaState(ctx.job, ctx.attempt);
  assert.equal(state.manifest.version, 3); assert.equal(state.manifest.inventory.segments.length, 4);
  assert.equal(state.manifest.inventory.segments[3].status, 'absent');
  assert.equal(state.manifest.inventory.segments[0].diagnostics.issues.length, 25);
  child.record(); child.finish(1); ctx.queue['continue-qa'](ctx.job.id); ctx.queue.pump();
  const next = ctx.sessions[1]; next.bind();
  assert.equal(next.config.files.length, 2);
  for (const prompt of [child.config.prompt, next.config.prompt]) {
    for (const text of ['00_header.png', '99_footer', 'issue 24', 'https://x/original.png', 'blank document', 'Capture problem', 'Segment error', 'requiresVisualReview', '__продолжение', 'Image-only', 'стыках полос', 'нельзя осмотреть']) assert.ok(prompt.includes(text), text);
    assert.ok(!prompt.includes('DROP_OK_PAYLOAD')); assert.ok(!prompt.includes('STACK_NOT_FOR_MODEL')); assert.ok(!prompt.includes('NOT_IN_QA_PROMPT'));
  }
  pass(next); next.finish(); assert.equal(ctx.attempt.status, 'incomplete');
});
test('complete cannot bypass coverage or IHDR size gates with passed reviews', t => {
  const mutations = {
    missingTab: report => { report.model.groups[0].labels.push('missing'); report.model.groups[0].children.push([]); report.model.groups[0].items.push({ mode: 'pane', empty: false }); },
    illegalAbsent: report => { report.segments.at(-1).spec = { kind: 'tab', group: 0, index: 1 }; },
    wrongBoxWidth: report => { report.segments[0].box.width = 2; },
    wrongPngHeight: report => { report.segments[0].png.height = 2; },
    noDimensions: report => { delete report.segments[0].png; },
    fractionalDimensions: report => { report.segments[0].box.height = 1.5; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const ctx = start(t, 2), report = JSON.parse(fs.readFileSync(ctx.p.report)); mutate(report); atomicJson(ctx.p.report, report);
    const child = qa(ctx); pass(child); child.finish();
    assert.equal(ctx.attempt.qa.passed, 2); assert.equal(ctx.attempt.status, 'incomplete', name);
    assert.ok(ctx.attempt.issues.length, name);
    if (/Dimensions|Width|Height/.test(name)) assert.ok(inspectArtifacts(ctx.root, ctx.job, ctx.attempt).issues.some(issue => issue.includes('IHDR')));
  }
});
test('old-policy per-image history cannot pass; immutable legacy capture survives migration, restart and remainder', t => {
  for (const policy of [undefined, { version: 1, hash: '1'.repeat(64) }, { version: QA_POLICY.version, hash: '2'.repeat(64) }]) {
    const ctx = start(t, 3), child = qa(ctx); pass(child); child.finish();
    const p = paths(ctx.root, ctx.job, ctx.attempt), current = loadQa(ctx.root, ctx.job, ctx.attempt);
    // An actual v2 capture manifest, without richer inventory, remains immutable.
    const { hash: previousHash, inventory, ...data } = current.manifest;
    data.version = 2; const legacy = { ...data, hash: hash(data) };
    const progress = structuredClone(current.progress); progress.manifestHash = legacy.hash;
    if (policy) progress.policy = policy; else delete progress.policy;
    for (const checkpoint of progress.checkpoints) {
      checkpoint.manifestHash = legacy.hash;
      if (policy) checkpoint.policy = policy; else delete checkpoint.policy;
    }
    atomicJson(p.manifest, legacy); atomicJson(p.progress, progress);
    const manifestBytes = fs.readFileSync(p.manifest), originalHistory = structuredClone(progress.checkpoints);
    const firstRestart = setup(t, { root: ctx.root }), job = firstRestart.queue.get(ctx.job.id), attempt = job.attempts[0];
    assert.equal(attempt.status, 'needs_review'); assert.equal(attempt.qa.passed, 0); assert.equal(attempt.qa.historicalReviews, 3);
    assert.equal(checkManifest(ctx.root, job, attempt, legacy).coverage.valid, true);
    firstRestart.queue['continue-qa'](job.id); firstRestart.queue.pump(); const first = firstRestart.sessions[0]; first.bind();
    assert.equal(first.config.files.length, 3); assert.equal(first.config.generation, 2); assert.deepEqual(first.config.policy, QA_POLICY);
    first.record(); first.finish(1);
    const secondRestart = setup(t, { root: ctx.root }), resumedJob = secondRestart.queue.get(job.id);
    secondRestart.queue['continue-qa'](job.id); secondRestart.queue.pump(); const next = secondRestart.sessions[0]; next.bind();
    assert.deepEqual(next.config.files.map(file => file.name), ['01_tab.png', '02_tab.png']);
    assert.ok(next.config.prompt.includes('00_header.png')); assert.ok(next.config.prompt.includes('99_footer'));
    pass(next); next.finish(); assert.equal(resumedJob.attempts[0].status, 'complete');
    const restored = loadQa(ctx.root, resumedJob, resumedJob.attempts[0]);
    assert.deepEqual(restored.progress.checkpoints.slice(0, 3), originalHistory);
    assert.equal(restored.progress.checkpoints.length, 6); assert.equal(counts(restored.manifest, restored.progress).passed, 3);
    assert.deepEqual(fs.readFileSync(p.manifest), manifestBytes); assert.equal(secondRestart.children.length, 0);
  }
});
test('policy checkpoint corruption, duplicates and returning to a previous policy remain rejected', t => {
  const ctx = start(t, 2), child = qa(ctx); pass(child); child.finish(); const p = paths(ctx.root, ctx.job, ctx.attempt), original = JSON.parse(fs.readFileSync(p.progress));
  for (const mutate of [
    v => { v.policy = null; },
    v => { delete v.policy; },
    v => { v.policy = { version: 1, hash: '1'.repeat(64) }; },
    v => { v.checkpoints[0].policy.hash = 'bad'; },
    v => { v.checkpoints[1].policy = { version: 1, hash: '1'.repeat(64) }; },
    v => { v.checkpoints.push(structuredClone(v.checkpoints[0])); },
    v => { const old = { ...structuredClone(v.checkpoints[0]), policy: { version: 1, hash: '1'.repeat(64) }, generation: 2 }; const current = { ...structuredClone(v.checkpoints[0]), generation: 3 }; v.generation = 3; v.checkpoints.push(old, current); },
  ]) {
    const changed = structuredClone(original); mutate(changed); atomicJson(p.progress, changed); assert.throws(() => loadQa(ctx.root, ctx.job, ctx.attempt));
  }
  atomicJson(p.progress, original);
});

test('current policy prompt accepts source emptiness and image text quality without excusing capture defects', t => {
  const ctx = start(t, 2), report = JSON.parse(fs.readFileSync(ctx.p.report));
  // A normal pane may be visually empty without the helper's unmatched-tab flag.
  report.segments[1].empty = false; report.segments[1].resources = { images: [], frames: [], fonts: 'loaded' };
  report.segments[1].issues = []; atomicJson(ctx.p.report, report);
  const child = qa(ctx), prompt = child.config.prompt, instructions = fs.readFileSync(path.join(__dirname, '../src/qa-instructions.txt'), 'utf8');
  assert.equal(QA_POLICY.version, 5); assert.equal(ctx.queue.qaState(ctx.job, ctx.attempt).manifest.inventory.segments[1].empty, false);
  for (const text of [
    'оценивай только доказуемые дефекты захвата, не дизайн/UX/доступность', 'Пустая или визуально пустая вкладка',
    'segment.status=ok', 'корректном coverage', 'diagnostics unloaded/loader/failed iframe',
    'Не требуй inventory empty=true', 'Само отсутствие текста/картинок под панелью не issue',
    'Мелкий, бледный, низкоконтрастный или неразборчивый текст', 'чтение, распознавание и транскрипция текста на картинке не требуются',
    'Маленький масштаб просмотра сам по себе не запрещает passed', 'именно для оценки целостности и дефектов захвата',
    'missing/crop/placeholder/loading/corruption/seam/overlay/wrong boundary',
    'Технические ошибки ресурсов, iframe или coverage не списывай', 'Событие load и техническое ok не доказывают отрисовку',
  ]) assert.ok(prompt.includes(text), text);
  assert.ok(!prompt.includes('PNG: читаемость,'), 'no standalone source-legibility criterion');
  assert.match(instructions, /Reading or transcribing text embedded in source content images, scans,\s+certificates or banners is not required/);
  assert.match(instructions, /Read visible tab\s+labels, loading\/error messages and other UI cues when needed to verify capture/);
  assert.ok(!instructions.includes('Do not read or transcribe text inside images'));
  assert.match(instructions, /explicit empty flag is not required/);
  assert.match(instructions, /Never excuse placeholders, failed resources, blank\/error\/loading iframes/);
  pass(child); child.finish(); assert.equal(ctx.attempt.status, 'complete');
});

test('v2 false visual issues remain history while current policy reviews all immutable PNGs afresh', t => {
  const ctx = start(t, 2), child = qa(ctx), falseIssues = [
    'Активная вкладка «Аренда помещений» полностью пустая: под вкладками отображается только белая область без текста, изображений или иного содержимого.',
    'Несколько изображений сертификатов в нижней части страницы отображаются чрезмерно мелко и бледно: текст документов визуально не читается в представленном размере.',
  ];
  for (const [index, file] of child.config.files.entries()) child.record(file, { status: 'issues', issues: [falseIssues[index]] });
  child.finish(); assert.equal(ctx.attempt.status, 'incomplete');
  const p = paths(ctx.root, ctx.job, ctx.attempt), manifestBytes = fs.readFileSync(p.manifest), reportBytes = fs.readFileSync(p.report);
  const progress = JSON.parse(fs.readFileSync(p.progress)), oldPolicy = { version: 2, hash: hash('previous source-legibility policy') };
  progress.policy = oldPolicy; for (const checkpoint of progress.checkpoints) checkpoint.policy = oldPolicy;
  atomicJson(p.progress, progress);
  const history = structuredClone(progress.checkpoints), restarted = setup(t, { root: ctx.root }), job = restarted.queue.get(ctx.job.id), attempt = job.attempts[0];
  assert.equal(attempt.status, 'needs_review'); assert.equal(attempt.qa.issues, 0); assert.equal(attempt.qa.passed, 0);
  assert.equal(attempt.qa.historicalReviews, 2); assert.equal(attempt.qa.unreviewed, 2);
  restarted.queue['continue-qa'](job.id); restarted.queue.pump(); const next = restarted.sessions[0]; next.bind();
  assert.equal(next.config.files.length, 2); assert.equal(next.config.policy.version, 5);
  pass(next); next.finish(); assert.equal(attempt.status, 'complete');
  const updated = loadQa(ctx.root, job, attempt);
  assert.deepEqual(updated.progress.checkpoints.slice(0, 2), history); assert.equal(updated.progress.checkpoints.length, 4);
  assert.deepEqual(fs.readFileSync(p.manifest), manifestBytes); assert.deepEqual(fs.readFileSync(p.report), reportBytes);
  assert.equal(restarted.children.length, 0, 'policy migration never repeats capture');
});

test('current policy retains v4 rejection of edge-only crop reasoning and migrates exact v3 Promelteh issues without changing capture identity', t => {
  const ctx = start(t, 2), child = qa(ctx);
  // Exact edge-only claims from Promelteh attempt-007, generation 2, policy v3.
  const falseIssues = [
    'crop/wrong boundary: нижний баннер «Наша продукция и услуги» обрезан нижней границей PNG — видны только его верхняя часть и начало содержимого, а боковые рамки уходят в край без нижней границы.',
    'crop: в нижнем левом столбце начинается ещё один документ/сертификат, но он пересечён нижней границей PNG и виден лишь частично.',
  ];
  for (const [index, file] of child.config.files.entries()) child.record(file, { status: 'issues', issues: [falseIssues[index]] });
  child.finish();
  const p = paths(ctx.root, ctx.job, ctx.attempt), manifestBytes = fs.readFileSync(p.manifest), reportBytes = fs.readFileSync(p.report);
  const progress = JSON.parse(fs.readFileSync(p.progress));
  const previousPolicy = { version: 3, hash: 'd01671f99e16cccb99e77589e7dd835f71ed71b9fc49050029e2311e2dc295bd' };
  progress.policy = previousPolicy; for (const checkpoint of progress.checkpoints) checkpoint.policy = previousPolicy;
  atomicJson(p.progress, progress); const history = structuredClone(progress.checkpoints);
  const restarted = setup(t, { root: ctx.root }), job = restarted.queue.get(ctx.job.id), attempt = job.attempts[0];
  assert.equal(attempt.status, 'needs_review'); assert.equal(attempt.qa.issues, 0); assert.equal(attempt.qa.passed, 0);
  assert.equal(attempt.qa.historicalReviews, 2); assert.equal(attempt.qa.unreviewed, 2);
  restarted.queue['continue-qa'](job.id); restarted.queue.pump(); const next = restarted.sessions[0]; next.bind();
  assert.equal(next.config.policy.version, 5); assert.notEqual(next.config.policy.hash, previousPolicy.hash);
  assert.equal(next.config.files.length, 2);
  for (const prompt of [child.config.prompt, next.config.prompt]) {
    for (const required of [
      'касание или пересечение края PNG', 'рамкой, картинкой, документом или блоком',
      'отсутствие видимой нижней границы сами по себе НЕ доказывают crop/missing/wrong-boundary',
      'Не воображай продолжение за кадром', 'доверяй рассчитанной semantic box',
      'source clipping и странности исходной вёрстки допустимы',
      'только при подтверждающих inventory/report diagnostics (geometry changed, overflow, overlay, resource failure)',
      'явном внутреннем шве/повторе/разрыве сборки', 'фактически неверной панели/сегменте относительно полного inventory',
      'Реальные unloaded/placeholder/failed iframe', 'внутренний seam/duplicate и wrong active tab остаются issues',
      'Назови конкретное подтверждение, относящееся к заявленному дефекту, а не только внешний край',
    ]) assert.ok(prompt.includes(required), required);
  }
  const instructions = fs.readFileSync(path.join(__dirname, '../src/qa-instructions.txt'), 'utf8');
  assert.match(instructions, /touching\/crossing a PNG edge[\s\S]*is not evidence of crop/);
  assert.match(instructions, /Never imagine\s+continuation outside the frame/);
  assert.match(instructions, /requires relevant inventory\/report diagnostics/);
  assert.match(instructions, /wrong active tab remain defects even with\s+technical OK/);
  pass(next); next.finish(); assert.equal(attempt.status, 'complete');
  const updated = loadQa(ctx.root, job, attempt);
  assert.deepEqual(updated.progress.checkpoints.slice(0, 2), history);
  assert.deepEqual(updated.progress.checkpoints.slice(0, 2).map(c => c.review.issues[0]), falseIssues);
  assert.deepEqual(fs.readFileSync(p.manifest), manifestBytes); assert.deepEqual(fs.readFileSync(p.report), reportBytes);
  assert.equal(restarted.children.length, 0);
});

test('v5 rejects exact edge-chrome header claims and migrates v4 reviews without recapture', t => {
  // Exact v4 false issues for the unchanged TSK and Ivan-chay header PNGs.
  const falseIssues = [
    '00_header.png: wrong boundary: в нижней части 00_header.png уже видны верхняя рамка и заголовок следующей панели «Наша продукция и услуги», хотя header должен заканчиваться перед первой панелью.',
    '00_header.png: wrong boundary: внизу header захвачена верхняя часть первой панели «Наша продукция и услуги» (линия/заголовок панели и элементы со стрелкой), хотя сегмент должен заканчиваться перед первой панелью',
  ];
  for (const falseIssue of falseIssues) {
    const ctx = start(t, 2), child = qa(ctx);
    child.record(child.config.files[0], { status: 'issues', issues: [falseIssue] });
    child.record(child.config.files[1]); child.finish();
    const p = paths(ctx.root, ctx.job, ctx.attempt);
    const manifestBytes = fs.readFileSync(p.manifest), reportBytes = fs.readFileSync(p.report);
    const beforeFiles = child.config.files.map(file => ({ name: file.name, sha256: file.sha256 }));
    const progress = JSON.parse(fs.readFileSync(p.progress));
    const previousPolicy = { version: 4, hash: '5efc9bd55bedd2c91f001b446898901757ba18e939025607410455d682fec04d' };
    progress.policy = previousPolicy;
    for (const checkpoint of progress.checkpoints) checkpoint.policy = previousPolicy;
    atomicJson(p.progress, progress); const history = structuredClone(progress.checkpoints);
    const restarted = setup(t, { root: ctx.root }), job = restarted.queue.get(ctx.job.id), attempt = job.attempts[0];
    assert.equal(attempt.status, 'needs_review'); assert.equal(attempt.qa.issues, 0);
    assert.equal(attempt.qa.passed, 0); assert.equal(attempt.qa.historicalReviews, 2); assert.equal(attempt.qa.unreviewed, 2);
    restarted.queue['continue-qa'](job.id); restarted.queue.pump();
    const next = restarted.sessions[0]; next.bind();
    assert.equal(next.config.policy.version, 5); assert.notEqual(next.config.policy.hash, previousPolicy.hash);
    assert.deepEqual(next.config.files.map(file => ({ name: file.name, sha256: file.sha256 })), beforeFiles);
    for (const required of [
      'конец перед первой строкой/списком кнопок вкладок (ul.tabs)',
      'сама кнопочная панель и её содержимое не входят',
      'Предшествующие section title/chrome (заголовок секции, рамка, legend, стрелка) принадлежат header',
      'граница — начало ul.tabs, а не начало этого контейнера',
      'Видимые на краю header заголовок «Наша продукция и услуги», рамка или стрелка',
      'сами по себе не являются wrong boundary при segment.status=ok, корректном coverage и чистых diagnostics',
      'фактическая кнопочная панель или её содержимое в header',
      'фактически неверная содержательная панель или дублированный контент остаются issues',
      'Реальные unloaded/placeholder/failed iframe', 'внутренний seam/duplicate и wrong active tab остаются issues',
    ]) assert.ok(next.config.prompt.includes(required), required);
    pass(next); next.finish(); assert.equal(attempt.status, 'complete');
    const updated = loadQa(ctx.root, job, attempt);
    assert.deepEqual(updated.progress.checkpoints.slice(0, 2), history);
    assert.equal(updated.progress.checkpoints[0].review.issues[0], falseIssue);
    assert.deepEqual(fs.readFileSync(p.manifest), manifestBytes); assert.deepEqual(fs.readFileSync(p.report), reportBytes);
    assert.equal(restarted.children.length, 0); assert.equal(job.attempts.length, 1);
  }
  const instructions = fs.readFileSync(path.join(__dirname, '../src/qa-instructions.txt'), 'utf8');
  assert.match(instructions, /Header ends before the first row\/list of tab buttons \(ul.tabs\), not before the\s+enclosing main_block\/tbody container/);
  assert.match(instructions, /Preceding section title\/chrome[\s\S]*belongs to header/);
  assert.match(instructions, /segment.status=ok, coverage is valid and\s+diagnostics are clean/);
  assert.match(instructions, /actual tab-button panel and its content must not\s+enter header/i);
  assert.match(instructions, /Actual wrong substantive panels or duplicated\s+content remain defects/);
});
