'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { APP_ROOT } = require('../../../data-dir.cjs');
const { atomicJson } = require('../../../infrastructure/files.cjs');
const { readLaunch, publishLease } = require('../../../infrastructure/launcher.cjs');
const { layout } = require('../paths.cjs');
const { readCheckpoint, captureIdentity } = require('./checkpoint.cjs');
const now = () => new Date().toISOString();

// Executes one capture; the coordinator decides whether to queue QA.
function launchCapture(queue, job, attempt) {
    const locations = layout(queue.root, job, attempt);
    let prompt = '', command, args;
    try {
        const resume = Boolean(attempt.captureStarted);
        if (resume) readCheckpoint(locations.hostDir, captureIdentity(locations.hostDir, job.url, `${job.id}:${attempt.number}`), null, { allowNextOrphan: true });
        fs.rmSync(path.join(locations.dir, 'pause-request.json'), { force: true });
        attempt.captureStarted = true; attempt.phase = 'capture'; attempt.workflow = 2;
        // Direct backend spawn is the only owner of helper invocation; no agent can retry it.
        command = queue.runtime.node;
        args = [path.join(APP_ROOT, 'src', 'capture.cjs'), '--url', job.url, '--out', locations.output,
          '--attempt-id', `${job.id}:${attempt.number}`, '--pause-file', path.join(locations.dir, 'pause-request.json'), ...(resume ? ['--resume', 'true'] : []),
          ...(queue.runtime.chrome ? ['--executable', queue.runtime.chrome] : ['--channel', 'chrome'])];
        fs.writeFileSync(path.join(locations.dir, 'prompt.txt'), JSON.stringify({ command, args }, null, 2));
    } catch (error) { attempt.status = attempt.captureSealed ? 'incomplete' : 'failed'; attempt.error = error.message; attempt.finishedAt = now(); queue.save(); return; }
    const priorLaunch = readLaunch(locations.dir);
    const launch = { token: crypto.randomUUID(), generation: (priorLaunch?.generation || 0) + 1, phase: attempt.phase, status: 'launch-pending', createdAtMs: queue.clock(), leaseProtocol: 2 };
    const descriptor = path.join(locations.dir, `launch-${launch.token}.json`);
    atomicJson(descriptor, { ...launch, command, args, cwd: queue.workspace });
    // This independent durable fence is authoritative even if state.json still
    // contains the previous PID when the parent dies. Unknown pending never retries.
    atomicJson(path.join(locations.dir, 'launch-current.json'), launch);
    attempt.launch = launch; delete attempt.pid; delete attempt.orphanPid;
    attempt.status = 'running'; attempt.startedAt ||= now(); delete attempt.finishedAt; queue.save();
    let child;
    // Worker stdout carries segment progress lines for standalone CLI runs;
    // the UI dropped its log panel, so the backend no longer archives it.
    const stderr = fs.openSync(path.join(locations.dir, 'stderr.log'), 'a');
    try {
      child = queue.spawnFn(command, args, {
        cwd: queue.workspace, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'ignore', stderr], env: queue.runtime.env,
        armLaunch: { ...launch, dir: locations.dir, descriptor },
      });
    } catch (error) {
      fs.closeSync(stderr);
      publishLease(locations.dir, launch, { status: 'finished', proof: 'spawn-threw-before-child', finishedAt: now() });
      attempt.status = attempt.captureSealed ? queue.stage.outcome(job, attempt) : 'failed'; attempt.error = error.message; attempt.finishedAt = now(); queue.save();
      return;
    }
    fs.closeSync(stderr);
    child.armLaunch = launch;
    child.armInterrupt = () => queue.stopFn(child);
    queue.active.set(job.id, child); attempt.pid = child.pid; queue.save();
    const monitor = queue.setTimer(() => { queue.tick(job, attempt, child).catch(error => { if (queue.stage.ownsStopCompletion(job, attempt, child)) { attempt.error = error.message; queue.save(); } }); }, Math.min(1000, queue.idleTimeoutMs));
    monitor?.unref?.(); queue.monitors.set(job.id, monitor);
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') spawnError = error; });
    child.once('close', (exitCode, signal) => {
      if (queue.active.get(job.id) !== child || !queue.stage.ownsLaunch(job, attempt, launch)) return;
      child.armClosed = true; queue.stage.confirmStopped(job, attempt, child);
      queue.clearTimer(queue.monitors.get(job.id)); queue.monitors.delete(job.id);
      queue.active.delete(job.id);
      attempt.exitCode = exitCode; attempt.signal = signal; attempt.finishedAt = now();
      try { queue.stage.refreshArtifacts(job, attempt); } catch (error) { attempt.error = error.message; }
      if (attempt.cancellationRequested || attempt.status === 'cancelled') {
        attempt.status = 'cancelled';
        if (attempt.stopError && attempt.error === attempt.stopError) delete attempt.error;
        delete attempt.stopError;
      } else if (exitCode === 3) {
        attempt.status = 'failed'; attempt.error = 'Возобновление capture заблокировано: checkpoint, структура или геометрия страницы изменились. Подробности в журнале ошибок; доступно «Перезапустить».';
      } else if (attempt.pauseRequested) {
        try {
          const artifacts = queue.stage.refreshArtifacts(job, attempt);
          if (attempt.captureSealed) { attempt.phase = 'qa'; attempt.status = 'paused'; }
          else {
            readCheckpoint(locations.hostDir, captureIdentity(locations.hostDir, job.url, `${job.id}:${attempt.number}`), null, { allowNextOrphan: true });
            attempt.status = artifacts?.report?.status === 'paused' && !spawnError && [0, 2].includes(exitCode) ? 'paused' : 'interrupted';
          }
        } catch (error) { attempt.status = 'interrupted'; attempt.error = error.message; }
      } else {
        attempt.status = 'validating'; queue.save();
        try {
          if (spawnError) attempt.error = spawnError.message;
          attempt.status = queue.stage.outcome(job, attempt);
        } catch (error) { attempt.error = `Проверка результата: ${error.message}`; attempt.status = queue.stage.outcome(job, attempt); }
        queue.stage.afterCapture(job, attempt, { exitCode, spawnError });
        if (!attempt.captureSealed) {
          try {
            readCheckpoint(locations.hostDir, captureIdentity(locations.hostDir, job.url, `${job.id}:${attempt.number}`), null, { allowNextOrphan: true });
            attempt.status = 'interrupted';
          } catch { /* No valid checkpoint: keep the terminal diagnostic. */ }
        }
      }
      try {
        atomicJson(path.join(locations.dir, 'result.json'), attempt);
        queue.save();
      } catch (error) { queue.closing = true; console.error('Не удалось сохранить результат, очередь остановлена:', error); }
      queue.pump();
    });
    child.stdin.end(prompt, 'utf8');
}
module.exports = { launchCapture };
