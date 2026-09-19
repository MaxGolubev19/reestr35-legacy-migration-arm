'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { APP_ROOT, dataRoot, dataSubdir } = require('../data-dir.cjs');
const { ACTIVE, TERMINAL } = require('./status.cjs');
const { normalizeUrl } = require('./url.cjs');
const { attemptDir } = require('./paths.cjs');
const { atomicJson } = require('../infrastructure/files.cjs');
const { resolveRuntime } = require('../infrastructure/runtime.cjs');
const { stopTree } = require('../infrastructure/process.cjs');
const { launchWorker } = require('../infrastructure/launcher.cjs');
const { restoreDuration, checkpointDuration } = require('./duration.cjs');
const pidAlive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const now = () => new Date().toISOString();
const last = job => job.attempts.at(-1);
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

// Page lifecycle and global FIFO scheduler. A registered stage owns its work units.
class PageQueue {
  constructor({ root = dataRoot(), workspace = APP_ROOT, concurrency = 2, spawnFn = launchWorker, stopFn = stopTree, codex = 'codex', autoStart = true,
    idleTimeoutMs = Number(process.env.ARM_IDLE_TIMEOUT_MS || 600000), launchGraceMs = 5000,
    clock = Date.now, setTimer = setInterval, clearTimer = clearInterval, isPidAlive = pidAlive, stageFactory, ...stageOptions } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency должен быть целым числом 1–8');
    Object.assign(this, { root, workspace, concurrency, spawnFn, stopFn, codex, autoStart });
    if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new Error('ARM_IDLE_TIMEOUT_MS должен быть положительным целым');
    if (!Number.isInteger(launchGraceMs) || launchGraceMs < 1) throw new Error('launchGraceMs должен быть положительным целым');
    Object.assign(this, { idleTimeoutMs, launchGraceMs, clock, setTimer, clearTimer, isPidAlive });
    this.monitors = new Map(); this.listeners = new Map();
    this.runtime = resolveRuntime();
    const tempDir = dataSubdir('tmp', root);
    Object.assign(this.runtime.env, { TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir });
    this.stateFile = path.join(root, 'state.json');
    this.active = new Map();
    this.closing = false;
    if (typeof stageFactory !== 'function') throw new Error('PageQueue requires a stageFactory');
    this.stage = stageFactory(this, stageOptions);
    fs.mkdirSync(root, { recursive: true });
    const saved = fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : null;
    this.jobs = saved ? saved.jobs : [];
    if (saved && Object.hasOwn(saved, 'concurrency')) {
      if (!Number.isInteger(saved.concurrency) || saved.concurrency < 1 || saved.concurrency > 8) throw new Error('Некорректная concurrency в state.json');
      this.concurrency = saved.concurrency;
    }
    if (!Array.isArray(this.jobs)) throw new Error('Некорректный state.json; сохраните его для диагностики');
    this.nextQueueOrder = this.jobs.flatMap(job => job.attempts).reduce((max, attempt) => Math.max(max, attempt.queueOrder || 0), 0);
    for (const job of this.jobs) {
      if (!/^[a-f0-9-]{36}$/.test(job.id) || normalizeUrl(job.url) !== job.url || !Array.isArray(job.attempts) || !job.attempts.length) throw new Error('Некорректное задание в state.json');
      for (const attempt of job.attempts) {
        if (!Number.isInteger(attempt.number) || attempt.number < 1) throw new Error('Некорректная попытка');
        restoreDuration(attempt);
        this.stage.restoreAttempt(job, attempt);
      }
    }
    this.save();
    this.recoveryTimer = this.setTimer(() => {
      if (!this.closing && this.jobs.some(job => job.attempts.some(attempt => Number.isFinite(attempt.activeSince)))) {
        try { this.save(); } catch (error) { console.error('Active duration checkpoint:', error.message); }
      }
      if (this.autoStart && !this.closing) this.pump();
    }, 1000);
    this.recoveryTimer?.unref?.();
    if (autoStart) setImmediate(() => this.pump());
  }
  save() {
    const timestamp = this.clock();
    for (const job of this.jobs) for (const attempt of job.attempts) checkpointDuration(attempt, timestamp);
    atomicJson(this.stateFile, { version: 2, concurrency: this.concurrency, jobs: this.jobs });
  }
  listenersFor(eventName) {
    if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
    return this.listeners.get(eventName);
  }
  subscribe(eventName, listener) {
    this.listenersFor(eventName).add(listener);
    return () => this.listenersFor(eventName).delete(listener);
  }
  emit(eventName, event) {
    for (const listener of this.listeners.get(eventName) || []) {
      try { listener(event); } catch {}
    }
  }
  setConcurrency(concurrency) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency должен быть целым числом 1–8');
    const previous = this.concurrency;
    this.concurrency = concurrency;
    try { this.save(); } catch (error) { this.concurrency = previous; throw error; }
    if (this.autoStart) this.pump();
    return { concurrency: this.concurrency };
  }
  add(urls) {
    if (typeof urls !== 'string' || urls.length > 128 * 1024) throw new Error('Передайте urls — текст до 128 KiB');
    const entries = urls.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (entries.length > 200) throw new Error('Не более 200 URL за один запрос');
    const result = { added: [], duplicates: [], invalid: [] };
    const known = new Set(this.jobs.map(job => job.url));
    for (const input of entries) {
      let url;
      try { url = normalizeUrl(input); } catch (error) { result.invalid.push({ input, error: error.message }); continue; }
      if (known.has(url)) { result.duplicates.push(url); continue; }
      const job = { id: crypto.randomUUID(), url, createdAt: now(), attempts: [] };
      this.newAttempt(job);
      this.jobs.push(job); known.add(url); this.save(); result.added.push(job.id);
    }
    this.save();
    if (this.autoStart) this.pump();
    return result;
  }
  newAttempt(job) {
    const attempt = { ...this.stage.attemptFields(), number: job.attempts.reduce((max, item) => Math.max(max, item.number), 0) + 1, status: 'queued', createdAt: now(), queuedAt: now(), queueOrder: ++this.nextQueueOrder, issues: [], files: [], activeDurationMs: 0, activeSince: null, durationIncomplete: false };
    fs.mkdirSync(path.join(this.root, 'runs', job.id), { recursive: true });
    let locations;
    // Reserve atomically. Preserve orphan folders left before a state.json save.
    while (true) {
      locations = { dir: attemptDir(this.root, job, attempt) };
      try { fs.mkdirSync(locations.dir); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; attempt.number++; }
    }
    this.stage.prepareAttempt(job, attempt);
    fs.writeFileSync(path.join(locations.dir, 'job.json'), JSON.stringify({ jobId: job.id, url: job.url, attempt: attempt.number }, null, 2));
    job.attempts.push(attempt);
    return attempt;
  }
  get(id) { const job = this.jobs.find(item => item.id === id); if (!job) throw Object.assign(new Error('Задание не найдено'), { statusCode: 404 }); return job; }
  retry(id) {
    const job = this.get(id);
    if (!(TERMINAL.has(last(job).status) || last(job).status === 'paused') || this.active.has(id) || !this.stage.launchFinished(job, last(job))) throw conflict('Повтор доступен после доказанного завершения текущей попытки');
    this.newAttempt(job); this.save(); if (this.autoStart) this.pump();
  }
  pause(id) {
    const job = this.get(id), attempt = last(job);
    if (['running', 'validating'].includes(attempt.status) && this.active.get(id)?.exitCode === null) return this.stage.pause(job, attempt);
    if (attempt.status !== 'queued' || this.active.has(id)) throw conflict('Пауза доступна для задания в очереди или выполняющегося задания; обновите состояние.');
    attempt.status = 'paused';
    try { this.save(); } catch (error) { attempt.status = 'queued'; throw error; }
  }
  resume(id) {
    const job = this.get(id), attempt = last(job);
    if (!['paused', 'interrupted'].includes(attempt.status) || this.active.has(id)) throw conflict('Возобновление доступно для приостановленной или прерванной попытки.');
    try { this.stage.validateResume(job, attempt); } catch (error) { throw conflict(error.message); }
    const previous = structuredClone(attempt);
    Object.assign(attempt, { status: 'queued', queuedAt: now(), queueOrder: ++this.nextQueueOrder });
    this.stage.prepareResume(attempt);
    try { this.save(); } catch (error) { Object.assign(attempt, previous); throw error; }
    if (this.autoStart) this.pump();
  }
  pump() {
    if (this.closing) return;
    this.stage.recoverPending();
    for (const job of this.jobs) this.stage.recoverJob(job);
    while (this.active.size + this.stage.occupiedSlots() < this.concurrency) {
      const queued = this.jobs.filter(job => last(job).status === 'queued' && this.stage.isRunnable(last(job), this.clock())).sort((a, b) => last(a).queueOrder - last(b).queueOrder);
      if (!queued.length) return;
      this.launch(queued[0]);
    }
  }
  launch(job) { return this.stage.start(job, last(job)); }
  async tick(job, attempt, child) {
    if (this.active.get(job.id) !== child || child.exitCode !== null || !this.stage.ownsLaunch(job, attempt, child.armLaunch)) return;
    this.stage.refreshArtifacts(job, attempt);
    if (!this.stage.shouldTimeout(attempt) || attempt.timeoutReason || attempt.cancellationRequested || attempt.pauseRequested || this.clock() - attempt.lastMeaningfulAt < this.idleTimeoutMs) return;
    attempt.timeoutReason = 'idle_timeout'; attempt.error = this.stage.timeoutMessage(this.idleTimeoutMs); attempt.status = 'stopping'; this.save();
    try {
      const proof = await child.armInterrupt();
      if (!this.stage.ownsStopCompletion(job, attempt, child)) return;
      child.armStopConfirmed = proof?.treeStopped === true; this.stage.confirmStopped(job, attempt, child);
      if (!this.active.has(job.id)) this.pump();
    }
    catch (error) {
      if (!this.stage.ownsStopCompletion(job, attempt, child)) return;
      attempt.status = this.stage.outcome(job, attempt); attempt.finishedAt = now();
      attempt.stopError = `Остановка по idle timeout не подтверждена: ${error.message}`; attempt.error = attempt.stopError; this.save();
    }
    if (this.stage.ownsStopCompletion(job, attempt, child) && this.active.get(job.id) === child && attempt.status === 'stopping') { attempt.status = this.stage.outcome(job, attempt); attempt.finishedAt = now(); this.save(); }
  }
  async stop(id) {
    const job = this.get(id), attempt = last(job);
    if (attempt.status === 'paused') throw conflict('Попытка на паузе ещё не запущена; используйте возобновление.');
    if (attempt.status === 'queued') { attempt.status = 'cancelled'; attempt.finishedAt = now(); this.save(); return; }
    if (!ACTIVE.has(attempt.status) && !this.active.has(id)) return;
    if (!this.active.has(id) || this.active.get(id).exitCode !== null) throw conflict('У попытки уже нет работающего процесса для остановки; обновите состояние.');
    if (!attempt.timeoutReason) { attempt.cancellationRequested = true; attempt.status = 'stopping'; }
    this.save();
    const child = this.active.get(id);
    try {
      const proof = await child.armInterrupt();
      if (!this.stage.ownsStopCompletion(job, attempt, child)) return;
      child.armStopConfirmed = proof?.treeStopped === true; this.stage.confirmStopped(job, attempt, child);
    }
    catch (error) {
      if (!this.stage.ownsStopCompletion(job, attempt, child)) return;
      if (this.active.has(id)) attempt.status = attempt.timeoutReason ? this.stage.outcome(job, attempt) : this.stage.executionStatus(attempt);
      attempt.stopError = `Остановка процесса не подтверждена; можно повторить: ${error.message}`;
      attempt.error = attempt.stopError;
      this.save(); throw error;
    }
  }
  async shutdown() {
    this.closing = true;
    this.clearTimer(this.recoveryTimer);
    await Promise.allSettled([...this.active.keys()].map(id => this.stop(id)));
    await this.stage.shutdown();
  }
  snapshot(csrfToken) {
    this.stage.refreshSnapshot();
    return { csrfToken, concurrency: this.concurrency, jobs: this.jobs.map(job => ({ ...job, status: last(job).status,
      ...this.stage.jobProjection(job),
      ...(this.pageBuilder ? { pageBuilder: this.pageBuilder.summary(job.id) } : {}),
      isActive: this.active.has(job.id) && this.active.get(job.id).exitCode === null,
      attempts: job.attempts.map(attempt => ({ ...attempt, ...(this.pageBuilder ? { pageBuilder: this.pageBuilder.summary(job.id, attempt.number) } : {}), files: (attempt.files || []).map(file => ({ ...file,
        url: `/api/files/${job.id}/${attempt.number}/${encodeURIComponent(file.name)}` })) })) })) };
  }
}
module.exports = { PageQueue };
