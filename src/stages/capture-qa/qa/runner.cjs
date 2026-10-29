'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicJson } = require('../../../infrastructure/files.cjs');
const { readLaunch, publishLease } = require('../../../infrastructure/launcher.cjs');
const { paths } = require('../paths.cjs');
const { checkManifest } = require('../capture/manifest.cjs');
const { stageBatch } = require('./staging.cjs');
const { reviews, nextReview, validateReview } = require('./progress.cjs');
const { buildQaPrompt, isCurrentPolicy } = require('./policy.cjs');
const { createReasoningJournal } = require('./reasoning.cjs');
const now = () => new Date().toISOString();
const last = job => job.attempts.at(-1);

function cleanupQa(attempt, qaDir) {
  if (!qaDir) return;
  try { fs.rmSync(qaDir, { recursive: true, force: true }); }
  catch (error) {
    attempt.qaCleanupError = `Не удалось удалить временный каталог QA: ${error.message}`;
    console.error(attempt.qaCleanupError);
  }
}

// Checkpoints and completion authority are independent of result/state projections.
// Retry required writes before allowing the scheduler to dispatch more work.
function finalizeQa(queue, job, attempt, p, qaDir) {
  cleanupQa(attempt, qaDir);
  const previousError = attempt.error;
  let result, resultWritten = false, advanced = false, finalStatus, closeMessage;
  const finalize = () => {
    let operation = 'result';
    try {
      if (!result) {
        queue.stage.refreshArtifacts(job, attempt);
        attempt.status = attempt.cancellationRequested ? 'cancelled' : attempt.pauseRequested ? 'paused' : queue.stage.outcome(job, attempt);
        result = structuredClone(attempt);
      }
      if (!resultWritten) { atomicJson(path.join(p.dir, 'result.json'), result); resultWritten = true; }
      delete attempt.finalizationError;
      operation = 'transition';
      if (!advanced) {
        attempt.status = result.status;
        queue.stage.afterQa?.(job, attempt);
        finalStatus = attempt.status; advanced = true;
      }
      attempt.status = finalStatus;
      if (attempt.error === closeMessage) {
        if (previousError) attempt.error = previousError; else delete attempt.error;
      }
      operation = 'state';
      queue.save();
      return true;
    } catch (error) {
      const message = `Завершение QA (${operation}) не сохранено; запись будет повторена: ${error.message}`;
      if (message !== closeMessage) console.error(message);
      closeMessage = message;
      attempt.status = 'interrupted'; attempt.error = message;
      attempt.finalizationError = { operation, message: error.message };
      try { queue.save(); } catch (failure) { attempt.finalizationError.stateError = failure.message; }
      return false;
    }
  };
  queue.pendingFinalizations.set(job.id, finalize);
  if (finalize()) {
    queue.pendingFinalizations.delete(job.id);
    try { queue.pump(); } catch (error) { console.error('QA queue continuation:', error.message); }
  }
}

// Executes one QA pass. A checkpoint is durable before its tool acknowledgement.
function launchQa(queue, job, attempt) {
    const p = paths(queue.root, job, attempt), qa = queue.stage.qaState(job, attempt);
    let session, qaDir, launch, appServer;
    try {
      const evidence = checkManifest(queue.root, job, attempt, qa.manifest);
      session = nextReview(qa.manifest, qa.progress);
      if (!session) { finalizeQa(queue, job, attempt, p); return; }
      const progress = { ...qa.progress, generation: session.generation, policy: session.policy };
      atomicJson(p.progress, progress); qa.progress = progress;
      qaDir = stageBatch(p.hostDir, session, queue.root);
      const previous = readLaunch(p.dir);
      launch = { token: crypto.randomUUID(), generation: (previous?.generation || 0) + 1, qaGeneration: session.generation,
        phase: 'qa', status: 'launch-pending', createdAtMs: queue.clock(), leaseProtocol: 3, backendPid: process.pid };
      atomicJson(path.join(p.dir, 'launch-current.json'), launch);
      attempt.launch = launch; delete attempt.pid; delete attempt.orphanPid; delete attempt.qaIdentity;
      Object.assign(attempt, { status: 'validating', lastMeaningfulAt: queue.clock() }); delete attempt.finishedAt;
      queue.save();
      const prompt = buildQaPrompt(qa.manifest, session, evidence);
      fs.writeFileSync(path.join(p.dir, `qa-${session.generation}-prompt.txt`), prompt);
      const reasoningJournal = createReasoningJournal({ file: path.join(p.dir, 'reasoning.log'),
        onTail: line => queue.reasoningTails?.set(`${job.id}:${attempt.number}`, line) });
      let identity = {}, child;
      appServer = queue.appServerFactory(); queue.qaServers.add(appServer);
      child = appServer.review({ ...session, cwd: qaDir, prompt,
        onIdentity: fields => {
          if (!queue.stage.ownsLaunch(job, attempt, launch) || queue.active.get(job.id) !== child) throw new Error('Stale QA launch');
          identity = { ...identity, ...fields };
          publishLease(p.dir, launch, { status: 'running', backendPid: process.pid, ...identity });
          attempt.qaIdentity = { generation: session.generation, ...identity }; queue.save();
        },
        onReview: (review, incoming) => {
          if (queue.active.get(job.id) !== child || last(job) !== attempt || !queue.stage.ownsLaunch(job, attempt, launch) || attempt.status !== 'validating' || attempt.cancellationRequested || attempt.timeoutReason ||
              incoming.generation !== session.generation || incoming.generation !== qa.progress.generation || !isCurrentPolicy(session.policy) || !isCurrentPolicy(qa.progress.policy) || incoming.threadId !== identity.threadId || incoming.turnId !== identity.turnId || !identity.threadId || !identity.turnId) throw new Error('Stale generation/thread/turn/policy');
          checkManifest(queue.root, job, attempt, qa.manifest);
          validateReview(review);
          const accepted = reviews(qa.progress), expected = session.files.find(file => !accepted.has(file.name));
          if (!expected || expected.name !== review.name || expected.sha256 !== review.sha256 || accepted.has(review.name)) throw new Error('record_review outside manifest/order or duplicate/hash mismatch');
          const checkpoint = { generation: session.generation, policy: session.policy, manifestHash: qa.manifest.hash, threadId: identity.threadId, turnId: identity.turnId,
            review: JSON.parse(JSON.stringify(review)), acceptedAt: now() };
          const updated = { ...qa.progress, checkpoints: [...qa.progress.checkpoints, checkpoint] };
          // Commit before acknowledging the tool; state is a recoverable projection.
          atomicJson(p.progress, updated); qa.progress = updated;
          attempt.lastMeaningfulAt = queue.clock(); attempt.qaAutoRetries = 0; delete attempt.qaRetryAt;
          queue.stage.refreshArtifacts(job, attempt);
          try { queue.save(); } catch (error) { attempt.error = `Checkpoint сохранён; проекция state не записана: ${error.message}`; }
          queue.emit('qa-review', { jobId: job.id, attempt: attempt.number, name: review.name });
          return { accepted: review.name, ...attempt.qa };
        },
        onLog: text => fs.appendFileSync(path.join(p.dir, 'stderr.log'), text),
        onReasoning: text => reasoningJournal.append(text),
      });
      child.armLaunch = launch; child.armInterrupt = () => child.interrupt(); queue.active.set(job.id, child);
      const monitor = queue.setTimer(() => queue.tick(job, attempt, child).catch(error => {
        if (queue.stage.ownsStopCompletion(job, attempt, child)) {
          attempt.error = error.message;
          try { queue.save(); } catch (failure) { console.error('QA monitor state:', failure.message); }
        }
      }), Math.min(1000, queue.idleTimeoutMs));
      monitor?.unref?.(); queue.monitors.set(job.id, monitor);
      child.once('close', code => {
        queue.qaServers.delete(appServer);
        if (queue.active.get(job.id) !== child || !queue.stage.ownsLaunch(job, attempt, launch)) return;
        if (child.exitCode === null || !['app-server-closed', 'no-app-server'].includes(child.completionProof)) return;
        queue.qaCompletions.set(launch.token, { generation: launch.generation,
          fields: { status: 'finished', ...identity, proof: child.completionProof, finishedAt: now() } });
        // The trusted transport has proved completion. Release the slot even if
        // atomic lease publication fails; continue/retry still require its
        // durable publication through launchFinished and the current token fence.
        child.armClosed = true; queue.clearTimer(queue.monitors.get(job.id)); queue.monitors.delete(job.id); queue.active.delete(job.id);
        attempt.exitCode = code; attempt.finishedAt = now();
        if (child.failure) attempt.error = child.failure.message;
        queue.stage.launchFinished(job, attempt);
        finalizeQa(queue, job, attempt, p, qaDir);
      });
    } catch (error) {
      if (appServer && !queue.active.has(job.id)) appServer.shutdown().finally(() => queue.qaServers.delete(appServer)).catch(failure => console.error('QA shutdown:', failure.message));
      if (!queue.active.has(job.id)) cleanupQa(attempt, qaDir);
      if (launch && !queue.active.has(job.id)) {
        try { publishLease(p.dir, launch, { status: 'finished', proof: 'qa-setup-failed', finishedAt: now() }); }
        catch (failure) { attempt.error = `QA setup lease: ${failure.message}; ${error.message}`; }
      }
      attempt.error ||= error.message; attempt.status = 'interrupted'; attempt.finishedAt = now();
      try { queue.save(); } catch (failure) { console.error('QA setup state:', failure.message); }
    }
}
module.exports = { launchQa };
