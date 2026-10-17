'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { PageQueue } = require('../src/pipeline/queue.cjs');
const { testTempRoot } = require('./support.cjs');
const { loadFormatDuration } = require('./duration-format.cjs');

function setup(t, root, timestamp = 1000) {
  root ||= fs.mkdtempSync(path.join(testTempRoot(), 'duration-'));
  let clock = timestamp, heartbeat;
  const queue = new PageQueue({ root, autoStart: false, clock: () => clock, setTimer: callback => { heartbeat = callback; return 1; }, clearTimer() {},
    stageFactory: owner => ({
      attemptFields: () => ({ phase: 'capture' }), prepareAttempt() {}, shutdown: async () => {}, recoverPending() {}, recoverJob() {},
      occupiedSlots: () => 0, isRunnable: () => true, launchFinished: () => true, validateResume() {}, prepareResume() {},
      restoreAttempt(attemptJob, attempt) { if (['running', 'validating', 'pausing'].includes(attempt.status)) attempt.status = 'interrupted'; },
      start(job, attempt) { attempt.status = attempt.phase === 'qa' ? 'validating' : 'running'; attempt.startedAt ||= new Date(clock).toISOString(); owner.active.set(job.id, { exitCode: null }); owner.save(); },
      pause(job, attempt) { attempt.status = 'paused'; owner.active.delete(job.id); owner.save(); },
      refreshSnapshot() {}, jobProjection: () => ({})
    }) });
  t.after(() => { queue.closing = true; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, queue, advance: amount => { clock += amount; }, heartbeat: () => heartbeat() };
}

test('active duration accumulates work across pause, queue, capture, QA, media and clean restoration', t => {
  const ctx = setup(t), { queue } = ctx;
  queue.add('https://time.reestr35.ru/'); const job = queue.jobs[0], attempt = job.attempts[0];
  ctx.advance(20000); queue.save(); assert.equal(attempt.activeDurationMs, 0);
  queue.pump(); ctx.advance(3000); ctx.heartbeat(); assert.equal(attempt.activeDurationMs, 3000);
  ctx.advance(2000); queue.pause(job.id); assert.equal(attempt.activeDurationMs, 5000); assert.equal(attempt.activeSince, null);
  ctx.advance(60000); queue.resume(job.id); ctx.advance(40000); queue.save(); assert.equal(attempt.activeDurationMs, 5000);
  attempt.phase = 'qa'; queue.pump(); ctx.advance(7000); queue.pause(job.id); assert.equal(attempt.activeDurationMs, 12000);
  const restored = setup(t, ctx.root, 1000000), resumedJob = restored.queue.jobs[0], resumed = resumedJob.attempts[0];
  assert.equal(resumed.activeDurationMs, 12000); assert.equal(resumed.durationIncomplete, false);
  resumed.phase = 'html-media'; restored.queue.resume(resumedJob.id); restored.advance(90000); restored.queue.pump(); restored.advance(4000);
  resumed.status = 'complete'; restored.queue.active.delete(resumedJob.id); restored.queue.save();
  assert.equal(resumed.activeDurationMs, 16000); assert.equal(resumed.activeSince, null);
  restored.advance(100000); restored.queue.save(); assert.equal(resumed.activeDurationMs, 16000);
});

test('restoring an active interval preserves its checkpoint and excludes backend downtime', t => {
  const ctx = setup(t); ctx.queue.add('https://crash.reestr35.ru/'); ctx.queue.pump(); ctx.advance(8000); ctx.heartbeat();
  const restored = setup(t, ctx.root, 1000000), attempt = restored.queue.jobs[0].attempts[0];
  assert.equal(attempt.status, 'interrupted'); assert.equal(attempt.activeDurationMs, 8000); assert.equal(attempt.activeSince, null); assert.equal(attempt.durationIncomplete, true);
  restored.queue.resume(restored.queue.jobs[0].id); restored.advance(100000); restored.queue.pump(); restored.advance(2000); restored.queue.pause(restored.queue.jobs[0].id);
  assert.equal(attempt.activeDurationMs, 10000);
});

test('legacy timestamps are never treated as active duration; preserved metadata and files stay unchanged', t => {
  const ctx = setup(t); ctx.queue.add('https://legacy.reestr35.ru/');
  const old = JSON.parse(fs.readFileSync(ctx.queue.stateFile)); const attempt = old.jobs[0].attempts[0];
  delete attempt.activeDurationMs; delete attempt.activeSince; delete attempt.durationIncomplete;
  Object.assign(attempt, { status: 'complete', startedAt: '2020-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z', note: 'keep' });
  fs.writeFileSync(ctx.queue.stateFile, JSON.stringify(old));
  const evidence = path.join(ctx.root, 'events.jsonl'); fs.writeFileSync(evidence, '{"status":"ok"}\n');
  const restored = setup(t, ctx.root), current = restored.queue.jobs[0].attempts[0];
  assert.equal(current.activeDurationMs, 0); assert.equal(current.durationIncomplete, true); assert.equal(current.note, 'keep');
  assert.equal(current.startedAt, attempt.startedAt); assert.equal(current.finishedAt, attempt.finishedAt); assert.equal(fs.readFileSync(evidence, 'utf8'), '{"status":"ok"}\n');
});

test('UI active duration freezes in paused/queued/complete and continues only a running interval', () => {
  const format = loadFormatDuration();
  const attempt = { activeDurationMs: 5000, activeSince: 10000, status: 'running' };
  assert.equal(format(attempt, 13000), '00:00:08');
  for (const status of ['paused', 'queued', 'complete']) assert.equal(format({ ...attempt, status }, 1000000), '00:00:05');
  assert.equal(format({ ...attempt, activeDurationMs: 8000, activeSince: 1000000 }, 1002000), '00:00:10');
  assert.equal(format({ status: 'paused', activeDurationMs: 0, durationIncomplete: true }, 1000000), '≥00:00:00');
});

test('a running step 3 assembly keeps a complete attempt timed until the build ends', t => {
  const ctx = setup(t), { queue } = ctx;
  queue.add('https://build.reestr35.ru/'); const job = queue.jobs[0], attempt = job.attempts[0];
  queue.pump();                                   // clock 1000: running, activeSince opened
  ctx.advance(2000); ctx.heartbeat();             // 2000 ms of ordinary active work
  attempt.status = 'complete'; queue.active.delete(job.id); queue.save();
  ctx.advance(3000); queue.save();
  assert.equal(attempt.activeDurationMs, 2000); assert.equal(attempt.activeSince, null, 'without a build the interval stays closed');
  attempt.builder = { status: 'running' };
  ctx.advance(1000); queue.save();
  assert.equal(attempt.activeDurationMs, 2000); assert.equal(attempt.activeSince, 7000, 'the assembly reopens the interval');
  ctx.advance(4000); ctx.heartbeat();
  assert.equal(attempt.activeDurationMs, 6000, 'the heartbeat checkpoints accumulate assembly time');
  attempt.builder.status = 'pausing'; ctx.advance(3000); ctx.heartbeat();
  assert.equal(attempt.activeDurationMs, 9000, 'a pausing assembly keeps the interval open until the session closes');
  attempt.builder.status = 'complete'; ctx.advance(2000); queue.save();
  assert.equal(attempt.activeDurationMs, 11000); assert.equal(attempt.activeSince, null, 'finishing the build fixes the checkpoint');
  ctx.advance(100000); queue.save();
  assert.equal(attempt.activeDurationMs, 11000);
});

test('a backend restart during a build preserves the checkpoint and marks it incomplete', t => {
  const ctx = setup(t), { queue } = ctx;
  queue.add('https://crash-build.reestr35.ru/'); queue.pump();
  ctx.advance(4000); ctx.heartbeat();
  const attempt = queue.jobs[0].attempts[0];
  attempt.status = 'complete'; attempt.builder = { status: 'running', generation: 1 }; queue.active.delete(queue.jobs[0].id);
  ctx.advance(7000); queue.save();
  assert.equal(attempt.activeDurationMs, 11000); assert.ok(Number.isFinite(attempt.activeSince));
  const restored = setup(t, ctx.root, 1000000), resumed = restored.queue.jobs[0].attempts[0];
  assert.equal(resumed.activeDurationMs, 11000); assert.equal(resumed.durationIncomplete, true);
  assert.ok(!Number.isFinite(resumed.activeSince) || resumed.activeSince >= 1000000, 'downtime while the ARM was off is never counted');
  // BuilderRunner.restore marks the run failed; from then on the interval stays closed.
  resumed.builder.status = 'failed';
  restored.queue.save();
  restored.advance(100000); restored.queue.save();
  assert.equal(resumed.activeDurationMs, 11000); assert.equal(resumed.activeSince, null);
});

test('UI duration extrapolates only a running assembly on an otherwise complete attempt', () => {
  const format = loadFormatDuration();
  const attempt = { status: 'complete', builder: { status: 'running' }, activeDurationMs: 5000, activeSince: 10000 };
  assert.equal(format(attempt, 13000), '00:00:08');
  assert.equal(format({ ...attempt, builder: { status: 'pausing' } }, 13000), '00:00:08');
  assert.equal(format({ ...attempt, activeSince: 1000000 }, 1002000), '00:00:07');
  for (const status of ['queued', 'complete', 'cancelled']) assert.equal(format({ ...attempt, builder: { status } }, 1000000), '00:00:05');
  assert.equal(format({ ...attempt, builder: undefined }, 1000000), '00:00:05');
});
