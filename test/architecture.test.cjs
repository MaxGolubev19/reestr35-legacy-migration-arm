'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testTempRoot } = require('./support.cjs');
const { Queue } = require('../src/server.cjs');
const { PageQueue } = require('../src/pipeline/queue.cjs');
const sourceRoot = path.resolve(__dirname, '../src');
test('offline editor bundle is reproducible, licensed and current', async () => {
  await require('../build/bundle-editors.cjs').bundle(true);
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, '../public/vendor/editors/manifest.json')));
  for (const name of ['@codemirror/view','@codemirror/state','@codemirror/lang-html','prettier','vanilla-jsoneditor']) assert.ok(manifest.components.some(component => component.name === name));
});

test('module dependencies keep scheduler and infrastructure independent of the registered stage', () => {
  const graph = new Map();
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { inspect(file); continue; }
      if (!file.endsWith('.cjs')) continue;
      const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
      const dependencies = [...fs.readFileSync(file, 'utf8').matchAll(/require\(['"](\.[^'"]+)['"]\)/g)]
        .map(match => path.relative(sourceRoot, path.resolve(path.dirname(file), match[1])).replaceAll('\\', '/'));
      graph.set(relative, dependencies);
      if (relative.startsWith('infrastructure/')) assert.ok(dependencies.every(dependency => dependency.startsWith('infrastructure/') || dependency === 'data-dir.cjs'), relative);
      if (relative.startsWith('pipeline/') && relative !== 'pipeline/registry.cjs') assert.ok(dependencies.every(dependency => !dependency.startsWith('stages/') && !['lib.cjs', 'qa.cjs', 'server.cjs'].includes(dependency)), relative);
      if (relative.startsWith('stages/capture-qa/capture/')) assert.ok(dependencies.every(dependency => !dependency.startsWith('stages/capture-qa/qa/')), relative);
    }
  }
  inspect(sourceRoot);
  function visit(file, ancestors = []) {
    assert.ok(!ancestors.includes(file), `Circular dependency: ${[...ancestors, file].join(' -> ')}`);
    for (const dependency of graph.get(file) || []) visit(dependency, [...ancestors, file]);
  }
  for (const file of graph.keys()) visit(file);
  assert.ok(graph.get('pipeline/registry.cjs').includes('stages/workflow.cjs'));
  assert.ok(graph.get('stages/workflow.cjs').includes('stages/capture-qa/index.cjs'));
  assert.doesNotMatch(fs.readFileSync(path.join(sourceRoot, 'pipeline/queue.cjs'), 'utf8'), /\b(?:qa[A-Z_]\w*|reviewListeners|subscribeReviews|notifyReviewAccepted)\b/);
});

test('generic scheduler delegates readiness to its stage while preserving FIFO among eligible attempts', () => {
  const calls = [], launched = [];
  const jobs = [
    { id: 'delayed', attempts: [{ status: 'queued', queueOrder: 1, eligibleAt: 200 }] },
    { id: 'ready', attempts: [{ status: 'queued', queueOrder: 2, eligibleAt: 50 }] },
  ];
  const queue = { closing: false, concurrency: 1, jobs, active: new Map(), clock: () => 100,
    stage: { recoverPending() {}, recoverJob() {}, occupiedSlots: () => 0,
      isRunnable(attempt, timestamp) { calls.push([attempt.queueOrder, timestamp]); return attempt.eligibleAt <= timestamp; } },
    launch(job) { launched.push(job.id); this.active.set(job.id, {}); job.attempts[0].status = 'running'; },
  };
  PageQueue.prototype.pump.call(queue);
  assert.deepEqual(launched, ['ready']); assert.deepEqual(calls, [[1, 100], [2, 100]]);
  queue.active.clear(); queue.clock = () => 200;
  PageQueue.prototype.pump.call(queue);
  assert.deepEqual(launched, ['ready', 'delayed']);
});

test('generic events preserve legacy review subscriptions, listener isolation and unsubscribe', () => {
  const queue = Object.create(Queue.prototype); queue.listeners = new Map();
  const received = [], unrelated = [], event = { jobId: 'job', attempt: 1, name: 'page.png' };
  const unsubscribe = queue.subscribeReviews(value => received.push(value));
  const failedListener = () => { throw new Error('listener failure'); };
  queue.reviewListeners.add(failedListener);
  queue.subscribe('other', value => unrelated.push(value));
  queue.emit('qa-review', event);
  queue.notifyReviewAccepted(event);
  assert.deepEqual(received, [event, event]); assert.deepEqual(unrelated, []);
  assert.equal(queue.reviewListeners.size, 2);
  unsubscribe(); queue.notifyReviewAccepted(event);
  assert.equal(received.length, 2); assert.equal(queue.reviewListeners.size, 1);
  const replacement = new Set([value => received.push(value)]);
  queue.reviewListeners = replacement; queue.notifyReviewAccepted(event);
  assert.strictEqual(queue.reviewListeners, replacement); assert.equal(received.length, 3);
});

test('legacy CommonJS entrypoints retain their contract and QA policy identity', () => {
  const lib = require('../src/lib.cjs'), qa = require('../src/qa.cjs');
  assert.deepEqual(Object.keys(require('../src/server.cjs')).sort(), ['Queue', 'acquireLock', 'createServer', 'createShutdownController'].sort());
  assert.deepEqual(Object.keys(lib).sort(), ['ACTIVE', 'TERMINAL', 'normalizeUrl', 'safeFile', 'readJson', 'stableRead', 'layout', 'buildArgs', 'qaEnvironment', 'buildPrompt', 'resolveRuntime', 'captureInventory', 'captureCoverage', 'inspectArtifacts', 'validateResult', 'stopTree'].sort());
  assert.deepEqual(Object.keys(qa).sort(), ['hash', 'QA_POLICY', 'isCurrentPolicy', 'captureEvidence', 'atomicJson', 'paths', 'sealedManifest', 'validManifest', 'checkManifest', 'effectiveManifest', 'stageBatch', 'loadQa', 'reviews', 'segments', 'counts', 'nextReview', 'validateReview', 'buildQaPrompt'].sort());
  assert.strictEqual(qa.checkManifest, require('../src/stages/capture-qa/capture/manifest.cjs').checkManifest);
  assert.strictEqual(require('../src/capture.cjs'), require('../src/stages/capture-qa/capture/helper.cjs'));
  assert.strictEqual(require('../src/app-server.cjs'), require('../src/stages/capture-qa/qa/app-server.cjs'));
  assert.strictEqual(require('../src/launcher.cjs'), require('../src/infrastructure/launcher.cjs'));
  // Baseline from the released policy: code relocation must not invalidate accepted reviews.
  assert.deepEqual(qa.QA_POLICY, { version: 6, hash: '867ccae89ff8dbde6c53ba2c04fa46218f2ffc3aa31b2c18aa95dfb9656150a9' });
});

test('Queue supports a capture-only stage factory while an installed media stage must retain its deletion guard', async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'architecture-capture-only-'));
  const queue = new Queue({ root, autoStart: false, stageFactory: (queue, options) => new (require('../src/stages/capture-qa/index.cjs').CaptureQaStage)(queue, options) });
  t.after(async () => { await queue.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(queue.stage.media, undefined);
  queue.add('https://capture-only.reestr35.ru/'); const job = queue.jobs[0], stored = queue.pageBuilder.read(job.id);
  assert.equal(queue.pageBuilder.write(job.id, stored.revision, stored.document).revision, stored.revision + 1);
  job.attempts[0].status = 'paused'; queue.retry(job.id);
  assert.equal(job.attempts.length, 1, 'retry replaces the single attempt'); assert.equal(job.attempts[0].number, 2);
  // Skipping is allowed only for a stage with no media capability. A present
  // but broken capability must never silently bypass the publication fence.
  queue.stage.media = {};
  assert.throws(() => queue.pageBuilder.assertWritable(), TypeError);
  job.attempts[0].status = 'paused'; assert.throws(() => queue.retry(job.id), TypeError); assert.equal(job.attempts.length, 1);
});

test('existing state v2 keeps only the latest attempt without stage schema migration or altered flat API fields', async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'architecture-v2-'));
  const state = { version: 2, concurrency: 3, jobs: [{
    id: '12345678-1234-1234-1234-123456789abc', url: 'https://history.reestr35.ru/', createdAt: '2026-09-10T10:00:00Z',
    attempts: [{ workflow: 1, number: 1, status: 'complete', files: [], legacyNote: 'preserved' },
      { workflow: 2, phase: 'capture', number: 2, status: 'paused', queueOrder: 7, createdAt: '2026-09-10T11:00:00Z', issues: [], files: [] }],
  }] };
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state));
  const queue = new Queue({ root, autoStart: false, setTimer: () => 1, clearTimer() {} });
  t.after(async () => { await queue.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.ok(queue instanceof PageQueue);
  assert.equal(queue.stage.id, 'capture-qa');
  const expected = structuredClone(state);
  // Startup prune keeps only the latest attempt of every job before the first save.
  expected.jobs[0].attempts = [expected.jobs[0].attempts[1]];
  for (const attempt of expected.jobs[0].attempts) Object.assign(attempt, { activeDurationMs: 0, activeSince: null, durationIncomplete: attempt.status === 'complete' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))), expected);
  const snapshot = queue.snapshot('token'), job = snapshot.jobs[0];
  assert.equal(snapshot.csrfToken, 'token'); assert.equal(snapshot.concurrency, 3);
  assert.equal(job.status, 'paused'); assert.equal(job.canContinueQa, false); assert.equal(job.isActive, false);
  assert.deepEqual(job.attempts.map(({ pageBuilder, ...attempt }) => attempt), expected.jobs[0].attempts);
  assert.ok(job.attempts.every(attempt => attempt.pageBuilder.total === 0 && attempt.pageBuilder.revision === 0));
  assert.ok(!Object.hasOwn(job, 'stage') && !Object.hasOwn(job.attempts[0], 'stages'));
});
