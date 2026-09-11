'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ACTIVE, TERMINAL } = require('../../pipeline/status.cjs');
const { atomicJson } = require('../../infrastructure/files.cjs');
const { layout, paths } = require('./paths.cjs');
const { inspectArtifacts } = require('./capture/artifacts.cjs');
const { SnapshotPngCache } = require('./capture/png.cjs');
const { sealedManifest, checkManifest, effectiveManifest } = require('./capture/manifest.cjs');
const { loadQa, reviews, counts } = require('./qa/progress.cjs');
const { AppServer } = require('./qa/app-server.cjs');
const { readLaunch, readLease, publishLease, recoverLease } = require('../../infrastructure/launcher.cjs');
const { launchCapture } = require('./capture/runner.cjs');
const { launchQa } = require('./qa/runner.cjs');
const { readCheckpoint, captureIdentity, checkpointPath } = require('./capture/checkpoint.cjs');
const now = () => new Date().toISOString();
const last = job => job.attempts.at(-1);
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

// One registered stage; phase stays capture/qa in the existing state v2.
// Runners receive the queue execution context, never own FIFO capacity.
class CaptureQaStage {
  constructor(queue, { qaAutoRetryLimit = 3, qaRetryDelayMs = 5000, appServerFactory } = {}) {
    if (!Number.isInteger(qaAutoRetryLimit) || qaAutoRetryLimit < 0 || qaAutoRetryLimit > 3 || !Number.isInteger(qaRetryDelayMs) || qaRetryDelayMs < 1) throw new Error('Некорректные параметры QA retry');
    this.queue = queue; this.id = 'capture-qa';
    this.snapshotPngCache = new SnapshotPngCache();
    // These runtime aliases remain available to existing Queue integrations.
    Object.assign(queue, { qaAutoRetryLimit, qaRetryDelayMs, qaStates: new Map(), qaCompletions: new Map(), recoveredQa: new Map(), qaServers: new Set(),
      appServerFactory: appServerFactory || (() => new AppServer({ codex: queue.codex, env: queue.runtime.env, root: queue.root })) });
  }
  attemptFields() { return { workflow: 2, phase: 'capture' }; }
  prepareAttempt(job, attempt) {
    fs.mkdirSync(layout(this.queue.root, job, attempt).output);
  }
  recoverPending() {
    const queue = this.queue;
    for (const [key, { job, attempt }] of queue.recoveredQa) {
      if (this.launchFinished(job, attempt)) queue.recoveredQa.delete(key);
    }
  }
  recoverJob(job) { return this.recoverQa(job); }
  isRunnable(attempt, timestamp) { return !attempt.qaRetryAt || attempt.qaRetryAt <= timestamp; }
  jobProjection(job) {
    const attempt = last(job), idle = !this.queue.active.has(job.id), finished = idle && (TERMINAL.has(attempt.status) || attempt.status === 'paused') && this.launchFinished(job, attempt);
    let canResume = false;
    if (finished && ['paused', 'interrupted'].includes(attempt.status)) {
      try { this.validateResume(job, attempt); canResume = true; } catch {}
    }
    return { canContinueQa: ['needs_review', 'incomplete'].includes(attempt.status) && this.canContinueQa(job), canResume,
      canPause: attempt.status === 'queued' || (['running', 'validating'].includes(attempt.status) && this.queue.active.get(job.id)?.exitCode === null),
      canRecapture: finished && (TERMINAL.has(attempt.status) || attempt.status === 'paused') };
  }
  validateResume(job, attempt) {
    if (this.queue.active.has(job.id) || !this.launchFinished(job, attempt)) throw new Error('Прежний launch lease ещё не завершён');
    const p = paths(this.queue.root, job, attempt);
    if (attempt.phase === 'qa' || attempt.captureSealed) {
      const qa = loadQa(this.queue.root, job, attempt);
      if (!qa) throw new Error('Нет сохранённого QA manifest');
      checkManifest(this.queue.root, job, attempt, qa.manifest);
      this.queue.qaStates.set(`${job.id}:${attempt.number}`, qa);
      return;
    }
    if (!attempt.captureStarted && !attempt.startedAt && attempt.status !== 'interrupted') return;
    return readCheckpoint(p.hostDir, captureIdentity(p.hostDir, job.url, `${job.id}:${attempt.number}`), null, { allowNextOrphan: true });
  }
  prepareResume(attempt) {
    if (attempt.captureSealed) attempt.phase = 'qa';
    delete attempt.pauseRequested; delete attempt.cancellationRequested; delete attempt.timeoutReason; delete attempt.qaRetryAt; delete attempt.stopError; delete attempt.error;
  }
  pause(job, attempt) {
    const queue = this.queue, child = queue.active.get(job.id), previous = { status: attempt.status, pauseRequested: attempt.pauseRequested };
    attempt.pauseRequested = true; attempt.status = 'pausing';
    try {
      queue.save();
      if (attempt.phase === 'capture') atomicJson(path.join(paths(queue.root, job, attempt).dir, 'pause-request.json'), { requestedAt: now() });
    } catch (error) { Object.assign(attempt, previous); queue.save(); throw error; }
    // QA commits synchronously before acknowledging reviews: all accepted work
    // is durable here. Capture instead cooperates at its next PNG boundary.
    if (attempt.phase === 'qa') void child.armInterrupt().catch(error => {
      if (queue.active.get(job.id) !== child) return;
      attempt.error = `Пауза ожидает подтверждения остановки: ${error.message}`; queue.save();
    });
  }
  occupiedSlots() { return this.queue.recoveredQa.size; }
  start(job, attempt) {
    if (!this.launchFinished(job, attempt)) { attempt.status = 'needs_review'; attempt.error = 'Запуск заблокирован: прежний launch lease не завершён'; this.queue.save(); return; }
    if (attempt.phase === 'qa') return this.launchQa(job, attempt);
    return launchCapture(this.queue, job, attempt);
  }
  afterCapture(job, attempt, { exitCode, spawnError }) {
    const queue = this.queue;
    if (!queue.closing && !attempt.timeoutReason && this.launchFinished(job, attempt) && attempt.captureSealed && attempt.qa?.unreviewed && !spawnError && [0, 2].includes(exitCode)) {
      attempt.phase = 'qa'; attempt.status = 'queued'; attempt.queueOrder = ++queue.nextQueueOrder; delete attempt.finishedAt;
    }
  }
  launchQa(job, attempt) { return launchQa(this.queue, job, attempt); }
  executionStatus(attempt) { return attempt.phase === 'qa' ? 'validating' : 'running'; }
  shouldTimeout(attempt) { return attempt.captureSealed; }
  timeoutMessage(timeout) { return `Нет подтверждённого прогресса QA в течение ${timeout} ms`; }
  async shutdown() { await Promise.allSettled([...this.queue.qaServers].map(server => server.shutdown())); }
  refreshSnapshot() {
    const queue = this.queue;
    this.snapshotPngCache.begin();
    try {
      for (const job of queue.jobs) for (const attempt of job.attempts) {
        if (attempt.workflow === 2) {
          try {
            const artifacts = this.refreshArtifacts(job, attempt, this.snapshotPngCache);
            if (attempt.captureSealed && ['complete', 'needs_review', 'incomplete'].includes(attempt.status)) attempt.status = this.outcome(job, attempt, artifacts);
          } catch (error) { attempt.error = error.message; if (attempt.status === 'complete') attempt.status = 'incomplete'; }
        }
      }
    } finally { this.snapshotPngCache.end(); }
  }
  artifactPath(job, attempt, name) { return path.join(layout(this.queue.root, job, attempt).hostDir, name); }
  restoreAttempt(job, attempt) {
    const queue = this.queue;
    let launch;
    try { launch = readLaunch(layout(queue.root, job, attempt).dir); }
    catch (error) { attempt.status = 'needs_review'; attempt.error = error.message; }
    if (launch) {
      attempt.launch = launch;
      if (!this.launchFinished(job, attempt)) {
        if (launch.phase === 'qa') queue.recoveredQa.set(`${job.id}:${attempt.number}`, { job, attempt });
        attempt.status = 'interrupted'; attempt.finishedAt = now();
        attempt.phase = launch.phase;
        if (launch.phase === 'capture') attempt.captureStarted = true;
      }
    }
    if (ACTIVE.has(attempt.status)) {
      attempt.status = 'interrupted'; attempt.finishedAt = now();
      attempt.error = 'Backend перезапущен во время выполнения; повтор создаст новую попытку. Старый PID автоматически не завершается.';
      if (attempt.workflow === 2) attempt.orphanPid = attempt.pid;
    }
    if (attempt.workflow === 2) {
      try {
        this.refreshArtifacts(job, attempt);
        if (attempt.captureSealed && ['complete', 'needs_review', 'incomplete'].includes(attempt.status)) attempt.status = this.outcome(job, attempt);
        if (attempt.status === 'interrupted' || (attempt.status === 'queued' && attempt.phase === 'capture' && attempt.captureStarted)) {
          if (attempt.pauseRequested && this.launchFinished(job, attempt)) {
            attempt.status = 'paused';
            if (attempt.captureSealed) attempt.phase = 'qa';
          } else attempt.status = attempt.captureSealed && !attempt.pauseRequested ? this.outcome(job, attempt) : 'interrupted';
          attempt.error = 'Backend перезапущен; capture/QA checkpoints сохранены. Продолжение требует завершённого launch lease; отсутствие PID само по себе не доказывает завершение.';
        }
      } catch (error) { attempt.status = 'needs_review'; attempt.error = error.message; }
    }
  }
  qaState(job, attempt) {
    return this.queue.qaStates.get(`${job.id}:${attempt.number}`);
  }
  launchFinished(job, attempt) {
    const queue = this.queue;
    const dir = layout(queue.root, job, attempt).dir;
    try {
      const launch = readLaunch(dir);
      if (!launch) return !(attempt.orphanPid && queue.isPidAlive(attempt.orphanPid)); // legacy history only
      let lease;
      try { lease = readLease(dir, launch); }
      catch (error) { if (error.code !== 'ENOENT') return false; }
      if (lease?.status === 'finished') { queue.qaCompletions.delete(launch.token); return true; }
      if (launch.leaseProtocol === 3) {
        const completion = queue.qaCompletions.get(launch.token);
        if (completion?.generation === launch.generation) {
          // Only this backend's observed completion is retryable here. Never
          // reconstruct this authority from state.json after a restart.
          try {
            publishLease(dir, launch, completion.fields);
            queue.qaCompletions.delete(launch.token);
            return true;
          } catch (error) {
            attempt.error = `Не удалось записать finished lease QA: ${error.message}. Завершение подтверждено; запись будет повторена.`;
            return false;
          }
        }
        if (queue.active.has(job.id) || queue.clock() - launch.createdAtMs < queue.launchGraceMs || !Number.isInteger(launch.backendPid) || queue.isPidAlive(launch.backendPid)) return false;
        // No request can precede the durable appServerPid lease. A dead backend
        // with no lease never dispatched QA. Otherwise require server death too.
        if (lease && (!Number.isInteger(lease.appServerPid) || queue.isPidAlive(lease.appServerPid))) return false;
        publishLease(dir, launch, { status: 'finished', proof: lease ? 'qa-owner-and-server-dead' : 'qa-never-dispatched', finishedAt: now() });
        return true;
      }
      return !queue.active.has(job.id) && recoverLease(dir, launch, { timestamp: queue.clock(), graceMs: queue.launchGraceMs, isPidAlive: queue.isPidAlive });
    } catch { return false; } // corrupt/foreign/uncertain claims remain blocked
  }
  ownsLaunch(job, attempt, launch) {
    const queue = this.queue;
    try {
      const current = readLaunch(layout(queue.root, job, attempt).dir);
      return current?.token === launch.token && current.generation === launch.generation;
    } catch { return false; }
  }
  ownsStopCompletion(job, attempt, child) {
    const queue = this.queue;
    if (last(job) !== attempt || !this.ownsLaunch(job, attempt, child.armLaunch)) return false;
    const active = queue.active.get(job.id);
    // A taskkill proof can arrive after close. Accept it only for the same
    // terminal launch, never for a continued queued attempt or a replacement.
    return active === child || (!active && child.armClosed === true && TERMINAL.has(attempt.status));
  }
  confirmStopped(job, attempt, child) {
    const queue = this.queue;
    // Windows taskkill /T /F confirms the tree. POSIX stopTree only dispatches
    // signals, so a killed wrapper without its finished lease remains uncertain.
    if (child.isQa || process.platform !== 'win32') return;
    if (!child.armClosed || !child.armStopConfirmed || !this.ownsLaunch(job, attempt, child.armLaunch)) return;
    publishLease(layout(queue.root, job, attempt).dir, child.armLaunch, { status: 'finished', pid: child.pid, finishedAt: now(), proof: 'confirmed-tree-stop' });
  }
  refreshArtifacts(job, attempt, pngCache) {
    const queue = this.queue;
    if (attempt.workflow !== 2) return;
    const artifacts = inspectArtifacts(queue.root, job, attempt, pngCache), p = paths(queue.root, job, attempt);
    // A partial report rewrite is transient: keep the last successfully discovered files.
    let qa = this.qaState(job, attempt);
    if (!qa) {
      qa = loadQa(queue.root, job, attempt);
      if (!qa) {
        // A finished report alone cannot promote a partially checkpointed
        // capture into QA. Legacy reports have no capture checkpoint.
        let captureComplete = true;
        if (artifacts.report?.finished && fs.existsSync(checkpointPath(p.hostDir))) {
          const checkpoint = readCheckpoint(p.hostDir, captureIdentity(p.hostDir, job.url, `${job.id}:${attempt.number}`), null, { allowNextOrphan: true });
          captureComplete = checkpoint.completed === checkpoint.plan.segments.length;
        }
        const manifest = captureComplete ? sealedManifest(artifacts, job, attempt) : null;
        if (manifest) {
          qa = { manifest, progress: { version: 2, manifestHash: manifest.hash, generation: 0, checkpoints: [] } };
          atomicJson(p.manifest, manifest); atomicJson(p.progress, qa.progress);
        }
      }
      if (qa) queue.qaStates.set(`${job.id}:${attempt.number}`, qa);
    }
    if (qa) {
      attempt.captureSealed = true; attempt.manifestHash = qa.manifest.hash;
      attempt.captureSummary = effectiveManifest(qa.manifest).summary; attempt.qa = counts(qa.manifest, qa.progress);
      if (attempt.lastMeaningfulAt === undefined) attempt.lastMeaningfulAt = queue.clock();
    }
    if (!artifacts.report) return artifacts;
    const accepted = qa ? reviews(qa.progress) : new Map();
    attempt.files = artifacts.files.map(file => ({ ...file, ...(file.kind === 'png' ? { qaStatus: accepted.get(file.name)?.sha256 === file.sha256 ? accepted.get(file.name).status : 'unreviewed' } : {}) }));
    if (!qa) attempt.qa = { total: attempt.files.filter(f => f.kind === 'png').length, reviewed: 0, passed: 0, issues: 0, unreviewed: attempt.files.filter(f => f.kind === 'png').length };
    return artifacts;
  }
  outcome(job, attempt, inspectedArtifacts) {
    const queue = this.queue;
    const qa = this.qaState(job, attempt);
    if (!qa) {
      const artifacts = inspectedArtifacts || inspectArtifacts(queue.root, job, attempt);
      attempt.issues = [...(artifacts.issues || []), ...(artifacts.error ? [artifacts.error] : [])];
      return artifacts.report || attempt.exitCode === 2 ? 'incomplete' : 'failed';
    }
    let evidence;
    try { evidence = checkManifest(queue.root, job, attempt, qa.manifest, inspectedArtifacts); delete attempt.manifestError; }
    catch (error) { attempt.manifestError = error.message; attempt.issues = [error.message]; return 'incomplete'; }
    attempt.qa = counts(qa.manifest, qa.progress);
    const effective = effectiveManifest(qa.manifest);
    attempt.coverage = evidence.coverage;
    attempt.issues = [...new Set([...effective.summary.issues, ...evidence.issues, ...evidence.coverage.issues]), ...[...reviews(qa.progress).values()].flatMap(file => file.issues.map(issue => `${file.name}: ${issue}`))];
    if (!effective.technicalComplete || !evidence.technicalComplete || !evidence.coverage.valid || attempt.qa.issues) return 'incomplete';
    return attempt.qa.unreviewed ? 'needs_review' : 'complete';
  }
  canContinueQa(job) {
    const queue = this.queue;
    const attempt = last(job), qa = this.qaState(job, attempt);
    return Boolean(TERMINAL.has(attempt.status) && !queue.active.has(job.id) && qa && counts(qa.manifest, qa.progress).unreviewed && !attempt.manifestError && this.launchFinished(job, attempt));
  }
  ['continue-qa'](id) {
    const queue = this.queue;
    const job = queue.get(id), attempt = last(job);
    this.refreshArtifacts(job, attempt);
    if (!['needs_review', 'incomplete'].includes(attempt.status) || !this.canContinueQa(job)) throw conflict('Продолжение проверки недоступно: нет оставшихся PNG либо завершение прежнего launch lease ещё не доказано.');
    const qa = this.qaState(job, attempt);
    try { checkManifest(queue.root, job, attempt, qa.manifest); }
    catch (error) { throw conflict(error.message); }
    this.queueQa(attempt);
    attempt.qaAutoRetries = 0; delete attempt.qaRetryAt;
    queue.save(); if (queue.autoStart) queue.pump();
  }
  queueQa(attempt) {
    const queue = this.queue;
    Object.assign(attempt, { phase: 'qa', status: 'queued', queuedAt: now(), queueOrder: ++queue.nextQueueOrder });
    delete attempt.finishedAt; delete attempt.error; delete attempt.stopError; delete attempt.cancellationRequested; delete attempt.timeoutReason; delete attempt.orphanPid;
  }
  recoverQa(job) {
    const queue = this.queue;
    const attempt = last(job);
    if (!Number.isInteger(attempt.qaAutoRetries ?? 0) || (attempt.qaAutoRetries ?? 0) < 0) return;
    if (queue.closing || attempt.pauseRequested || attempt.cancellationRequested || attempt.status === 'cancelled' || !TERMINAL.has(attempt.status) ||
        !attempt.captureSealed || (attempt.qaAutoRetries || 0) >= queue.qaAutoRetryLimit || !this.canContinueQa(job)) return;
    try {
      checkManifest(queue.root, job, attempt, this.qaState(job, attempt).manifest);
      // Retry only a known QA launch or a capture worker stopped after sealing.
      const launch = readLaunch(layout(queue.root, job, attempt).dir);
      if (!launch || (launch.phase !== 'qa' && !attempt.timeoutReason)) return;
      this.queueQa(attempt);
      attempt.qaAutoRetries = (attempt.qaAutoRetries || 0) + 1;
      attempt.qaRetryAt = queue.clock() + queue.qaRetryDelayMs;
      queue.save();
    } catch (error) { attempt.error = error.message; queue.save(); }
  }
}
module.exports = { CaptureQaStage };
