'use strict';
const TIMED = new Set(['running', 'validating', 'pausing', 'stopping']);
const valid = value => Number.isFinite(value) && value >= 0;

function restoreDuration(attempt) {
  if (!valid(attempt.activeDurationMs)) {
    // Old state, per-run leases and capture stdout do not contain a complete
    // history of pauses across capture, QA and in-process HTML work.
    attempt.activeDurationMs = 0;
    attempt.durationIncomplete = !!(attempt.startedAt || attempt.captureStarted || attempt.phase === 'qa' || attempt.phase === 'html-media' || !['queued', 'paused'].includes(attempt.status));
  }
  // A live persisted interval ended at an unknown point while the backend was
  // down. Keep its checkpointed total; never count downtime as active work.
  if (valid(attempt.activeSince)) attempt.durationIncomplete = true;
  attempt.activeSince = null;
}

function checkpointDuration(attempt, timestamp) {
  if (!valid(attempt.activeDurationMs)) restoreDuration(attempt);
  if (valid(attempt.activeSince)) attempt.activeDurationMs += Math.max(0, timestamp - attempt.activeSince);
  attempt.activeSince = TIMED.has(attempt.status) ? Math.max(timestamp, attempt.activeSince || 0) : null;
}

module.exports = { restoreDuration, checkpointDuration };
