'use strict';
const TIMED = new Set(['running', 'validating', 'pausing', 'stopping']);
// A step 3 assembly never changes attempt.status; its own running state is the
// only signal that the attempt is still at work. Shared by the checkpoint and
// the queue's heartbeat gate; the frontend mirrors it in formatDuration.
const isTimed = attempt => TIMED.has(attempt.status) || ['running', 'pausing'].includes(attempt.builder?.status);
const valid = value => Number.isFinite(value) && value >= 0;

function restoreDuration(attempt) {
  if (!valid(attempt.activeDurationMs)) {
    // Old state, per-run leases and capture stdout do not contain a complete
    // history of pauses across capture, QA and in-process HTML work.
    attempt.activeDurationMs = 0;
    attempt.durationIncomplete = !!(attempt.startedAt || attempt.captureStarted || attempt.phase === 'qa' || !['queued', 'paused'].includes(attempt.status));
  }
  // A live persisted interval ended at an unknown point while the backend was
  // down. Keep its checkpointed total; never count downtime as active work.
  if (valid(attempt.activeSince)) attempt.durationIncomplete = true;
  attempt.activeSince = null;
}

function checkpointDuration(attempt, timestamp) {
  if (!valid(attempt.activeDurationMs)) restoreDuration(attempt);
  if (valid(attempt.activeSince)) attempt.activeDurationMs += Math.max(0, timestamp - attempt.activeSince);
  attempt.activeSince = isTimed(attempt) ? Math.max(timestamp, attempt.activeSince || 0) : null;
}

module.exports = { restoreDuration, checkpointDuration, isTimed };
