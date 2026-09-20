'use strict';
const { CaptureQaStage } = require('./capture-qa/index.cjs');
const { HtmlMediaStage } = require('./html-media/index.cjs');
class Workflow extends CaptureQaStage {
  constructor(queue, options) { super(queue, options); this.media = new HtmlMediaStage(queue, options); }
  afterQa(job, attempt) {
    if (job.attempts.at(-1) !== attempt || attempt.workflow !== 2 || !attempt.captureSealed || attempt.finalizationError || attempt.status !== 'complete' || attempt.phase === 'html-media' || !this.launchFinished(job, attempt)) return false;
    this.media.enter(job, attempt); return true;
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
