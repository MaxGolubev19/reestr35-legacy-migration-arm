'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CaptureQaStage } = require('./capture-qa/index.cjs');
const { HtmlMediaStage } = require('./html-media/index.cjs');
const { layout } = require('./capture-qa/paths.cjs');
const { hash } = require('../infrastructure/hash.cjs');
const { atomicJson, safeFile, stableRead, readJson } = require('../infrastructure/files.cjs');
const now = () => new Date().toISOString();
class Workflow extends CaptureQaStage {
  constructor(queue, options) { super(queue, options); this.media = new HtmlMediaStage(queue, options); }
  afterQa(job, attempt) {
    if (job.attempts.at(-1) !== attempt || attempt.workflow !== 2 || !attempt.captureSealed || attempt.finalizationError || attempt.status !== 'complete' || attempt.phase === 'html-media' || !this.launchFinished(job, attempt)) return false;
    this.media.enter(job, attempt); return true;
  }
  // Step 2 restart: the sealed step 1 evidence (captured PNG, the immutable
  // capture manifest and QA progress) is copied into the fresh attempt and
  // re-validated through the ordinary integrity path; launch/lease state and
  // step 2 results never carry over. The chosen HTML source starts a clean
  // media manifest so every resource downloads again.
  retryFrom(job, attempt, previous) {
    const from = layout(this.queue.root, job, previous), to = layout(this.queue.root, job, attempt);
    // Plain read/write copies: the data root may live behind sync filters
    // (OneDrive) where CopyFile-based primitives fail intermittently.
    const copyTree = (source, destination) => {
      fs.mkdirSync(destination, { recursive: true });
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.isFile()) fs.writeFileSync(path.join(destination, entry.name), fs.readFileSync(path.join(source, entry.name)));
        else if (entry.isDirectory()) copyTree(path.join(source, entry.name), path.join(destination, entry.name));
      }
    };
    copyTree(from.hostDir, to.hostDir);
    // The sealed manifest becomes the new attempt's evidence: re-bind it to
    // the new attempt number and re-hash. The byte-level content (report,
    // PNG, inventory) is unchanged, so the carried QA reviews stay valid
    // once their manifestHash references point at the rebound hash.
    const manifestFile = path.join(from.dir, 'capture-manifest.json');
    if (fs.existsSync(manifestFile)) {
      const data = { ...readJson(manifestFile) };
      delete data.hash;
      data.attempt = attempt.number;
      const rebound = hash(data);
      atomicJson(path.join(to.dir, 'capture-manifest.json'), { ...data, hash: rebound });
      const progressFile = path.join(from.dir, 'qa-progress.json');
      if (fs.existsSync(progressFile)) {
        const rebind = value => Array.isArray(value) ? value.map(rebind)
          : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'manifestHash' ? rebound : rebind(item)]))
          : value;
        atomicJson(path.join(to.dir, 'qa-progress.json'), rebind(readJson(progressFile)));
      }
    }
    attempt.phase = 'html-media';
    this.captureIntegrity(job, attempt);
    if (attempt.captureStatus !== 'complete') throw new Error(`Материалы шага 1 не прошли проверку целостности: ${attempt.error || attempt.captureStatus}`);
    if (previous.htmlMedia?.revision) {
      const dir = this.media.directory(job, previous);
      const bytes = stableRead(safeFile(this.queue.root, path.join(dir, 'source.html')), this.media.limits.maxHtmlBytes);
      this.media.create(job, attempt, bytes, previous.htmlMedia.source?.origin || 'bundled');
      Object.assign(attempt, { status: 'queued', queuedAt: now(), queueOrder: ++this.queue.nextQueueOrder });
    } else this.media.enter(job, attempt);
    delete attempt.finishedAt;
  }
  restoreAttempt(job, attempt) { if (attempt.phase === 'html-media') { this.captureIntegrity(job, attempt); return this.media.restore(job, attempt); } super.restoreAttempt(job, attempt); this.afterQa(job, attempt); }
  captureIntegrity(job, attempt, cache) {
    try { const artifacts = super.refreshArtifacts(job, attempt, cache); attempt.captureStatus = super.outcome(job, attempt, artifacts); }
    catch (error) { attempt.captureStatus = 'incomplete'; attempt.error = error.message; }
  }
  refreshSnapshot() {
    // Capture snapshots keep their original immutable manifest/policy checks.
    super.refreshSnapshot();
    let changed = false;
    for (const job of this.queue.jobs) changed = this.afterQa(job, job.attempts.at(-1)) || changed;
    if (changed) this.queue.save();
  }
  recoverJob(job) {
    if (job.attempts.at(-1).phase === 'html-media') return;
    super.recoverJob(job);
    if (this.afterQa(job, job.attempts.at(-1))) this.queue.save();
  }
  start(job, attempt) {
    if (attempt.phase !== 'html-media') return super.start(job, attempt);
    try { this.validateResume(job, attempt); } catch (error) { attempt.status = 'interrupted'; attempt.error = error.message; this.queue.save(); return; }
    return this.media.start(job, attempt);
  }
  validateResume(job, attempt) { if (attempt.phase !== 'html-media') return super.validateResume(job, attempt); this.captureIntegrity(job, attempt); if (attempt.captureStatus !== 'complete') throw new Error('Целостность capture/QA не подтверждена'); return this.media.validateResume(job, attempt); }
  prepareResume(attempt) { if (attempt.phase !== 'html-media') return super.prepareResume(attempt); delete attempt.pauseRequested; delete attempt.cancellationRequested; delete attempt.error; }
  pause(job, attempt) {
    if (attempt.phase !== 'html-media') return super.pause(job, attempt);
    const previous = { status: attempt.status, pauseRequested: attempt.pauseRequested };
    attempt.pauseRequested = true; attempt.status = 'pausing';
    try { this.queue.save(); } catch (error) { Object.assign(attempt, previous); throw error; }
  }
  launchFinished(job, attempt) { if (attempt.phase === 'html-media') return !this.queue.active.has(job.id) && !this.media?.uploads.has(job.id); return super.launchFinished(job, attempt); }
  ownsStopCompletion(job, attempt, child) { return child.isHtmlMedia ? job.attempts.at(-1) === attempt : super.ownsStopCompletion(job, attempt, child); }
  confirmStopped(job, attempt, child) { if (!child.isHtmlMedia) return super.confirmStopped(job, attempt, child); }
  canContinueQa(job) { return job.attempts.at(-1).phase !== 'html-media' && super.canContinueQa(job); }
  jobProjection(job) {
    const attempt = job.attempts.at(-1);
    if (attempt.phase !== 'html-media') return super.jobProjection(job);
    const idle = !this.queue.active.has(job.id) && !this.media.uploads.has(job.id), resumable = ['paused','interrupted'].includes(attempt.status);
    // Full byte verification happens on Continue/start, not every polling snapshot.
    return { canContinueQa: false, canResume: idle && resumable && attempt.captureStatus === 'complete' && !!attempt.htmlMedia?.revision,
      canPause: attempt.status === 'queued' || (attempt.status === 'running' && this.queue.active.get(job.id)?.exitCode === null),
      canRecapture: idle && ['paused','complete','interrupted'].includes(attempt.status) };
  }
}
module.exports = { Workflow };
