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
const { restoreDuration, checkpointDuration, isTimed } = require('./duration.cjs');
const pidAlive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const now = () => new Date().toISOString();
const last = job => job.attempts.at(-1);
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

// Page lifecycle and global FIFO scheduler. A registered stage owns its work units.
// Concurrency is one shared pool: active stage 1-2 jobs plus running step 3
// assemblies never exceed the limit; occupancy is derived from live registries.
class PageQueue {
  constructor({ root = dataRoot(), workspace = APP_ROOT, concurrency = 2, spawnFn = launchWorker, stopFn = stopTree, zcode, autoStart = true,
    idleTimeoutMs = Number(process.env.ARM_IDLE_TIMEOUT_MS || 600000), launchGraceMs = 5000,
    clock = Date.now, setTimer = setInterval, clearTimer = clearInterval, isPidAlive = pidAlive, stageFactory, ...stageOptions } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency должен быть целым числом 1–8');
    Object.assign(this, { root, workspace, concurrency, spawnFn, stopFn, zcode, autoStart });
    if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new Error('ARM_IDLE_TIMEOUT_MS должен быть положительным целым');
    if (!Number.isInteger(launchGraceMs) || launchGraceMs < 1) throw new Error('launchGraceMs должен быть положительным целым');
    Object.assign(this, { idleTimeoutMs, launchGraceMs, clock, setTimer, clearTimer, isPidAlive });
    this.monitors = new Map(); this.listeners = new Map();
    this.runtime = resolveRuntime();
    const tempDir = dataSubdir('tmp', root);
    Object.assign(this.runtime.env, { TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir });
    this.stateFile = path.join(root, 'state.json');
    this.active = new Map();
    this.pendingFinalizations = new Map();
    // Live reasoning tails are session-scoped projections: never persisted, an
    // empty map after a restart just leaves the panel line blank until new text.
    this.reasoningTails = new Map();
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
      for (const attempt of job.attempts) if (!Number.isInteger(attempt.number) || attempt.number < 1) throw new Error('Некорректная попытка');
    }
    // One attempt per job: on start keep only the latest attempt of each job and
    // sweep every other attempt's materials plus unreferenced leftovers. The
    // pruned state is saved before anything is deleted, so a crash cannot leave
    // state.json pointing at removed evidence.
    const multiAttempt = this.jobs.filter(job => job.attempts.length > 1);
    for (const job of multiAttempt) job.attempts.splice(0, job.attempts.length - 1);
    if (multiAttempt.length) this.save();
    for (const job of this.jobs) {
      const swept = this.sweepJobMaterials(job, last(job).number);
      // The builder diagnostics folder is attempt-agnostic: cut it whenever this
      // job lost any material to the startup prune.
      if (swept) this.removeBuilderDiagnostics(job.id);
    }
    for (const job of this.jobs) {
      for (const attempt of job.attempts) {
        restoreDuration(attempt);
        this.stage.restoreAttempt(job, attempt);
        if (attempt.finalizationError) attempt.status = 'interrupted';
      }
    }
    this.save();
    this.recoveryTimer = this.setTimer(() => {
      // isTimed covers step 3 assemblies (attempt.status stays complete); the
      // activeSince disjunct lets one save close an interval a transition no
      // longer owns before it lingers in state.json.
      if (!this.closing && this.jobs.some(job => job.attempts.some(attempt => isTimed(attempt) || Number.isFinite(attempt.activeSince)))) {
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
  // Derived occupancy: a slot is held by the very fact of living in a registry
  // (active worker, recovered QA, running assembly), so a slot can never leak
  // and a restart recomputes the pool from the restored state automatically.
  usedSlots() { return this.active.size + this.stage.occupiedSlots() + (this.builder ? this.builder.running.size : 0); }
  hasFreeSlot() { return this.usedSlots() < this.concurrency; }
  setConcurrency(concurrency) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency должен быть целым числом 1–8');
    const previous = this.concurrency;
    this.concurrency = concurrency;
    try { this.save(); } catch (error) { this.concurrency = previous; throw error; }
    if (this.autoStart) this.pump();
    return { concurrency: this.concurrency };
  }
  reorderJobs(expected, order) {
    const current = this.jobs.map(job => job.id).reverse();
    if (!Array.isArray(expected) || !Array.isArray(order) ||
        expected.length !== current.length || order.length !== current.length ||
        expected.some((id, index) => id !== current[index]) ||
        new Set(order).size !== current.length || order.some(id => !current.includes(id))) {
      throw conflict('Список задач изменился; обновите страницу и повторите перестановку.');
    }
    if (order.every((id, index) => id === current[index])) return { ok: true };
    const previousJobs = this.jobs, previousOrder = this.nextQueueOrder;
    const previousQueued = this.jobs.filter(job => last(job).status === 'queued').map(job => [last(job), last(job).queueOrder]);
    const byId = new Map(this.jobs.map(job => [job.id, job]));
    this.jobs = order.map(id => byId.get(id)).reverse();
    for (const id of order) {
      const attempt = last(byId.get(id));
      if (attempt.status === 'queued') attempt.queueOrder = ++this.nextQueueOrder;
    }
    try { this.save(); }
    catch (error) {
      this.jobs = previousJobs; this.nextQueueOrder = previousOrder;
      for (const [attempt, queueOrder] of previousQueued) attempt.queueOrder = queueOrder;
      throw error;
    }
    if (this.autoStart) this.pump();
    return { ok: true };
  }
  add(urls) {
    if (typeof urls !== 'string' || urls.length > 128 * 1024) throw new Error('Передайте urls — текст до 128 KiB');
    const entries = urls.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (entries.length > 200) throw new Error('Не более 200 URL за один запрос');
    const result = { added: [], duplicates: [], invalid: [] };
    const known = new Set(this.jobs.map(job => job.url));
    const prepared = [], previousCount = this.jobs.length, previousOrder = this.nextQueueOrder;
    try {
      for (const input of entries) {
        let url;
        try { url = normalizeUrl(input); } catch (error) { result.invalid.push({ input, error: error.message }); continue; }
        if (known.has(url)) { result.duplicates.push(url); continue; }
        const job = { id: crypto.randomUUID(), url, createdAt: now(), attempts: [] };
        this.newAttempt(job);
        prepared.push(job); known.add(url); result.added.push(job.id);
      }
      if (prepared.length) { this.jobs.push(...prepared); this.save(); }
    } catch (error) {
      // Directories remain reserved evidence even when the entire batch is rejected.
      this.jobs.splice(previousCount); this.nextQueueOrder = previousOrder;
      throw error;
    }
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
  // Single-attempt model: called only after the new attempt is durably saved.
  // Removes every older attempt from the state, saves that projection, and only
  // then deletes the removed attempts' materials. Deletion failures are logged:
  // orphan folders without a state.json reference are inert.
  pruneAttempts(job) {
    if (job.attempts.length < 2) { this.sweepJobMaterials(job, last(job).number); this.removeBuilderDiagnostics(job.id); return; }
    const removed = job.attempts.splice(0, job.attempts.length - 1);
    try { this.save(); }
    catch (error) {
      job.attempts.unshift(...removed);
      console.error(`Attempt prune (${job.id}) не сохранён; материалы сохранены: ${error.message}`);
      return;
    }
    for (const attempt of removed) {
      this.reasoningTails?.delete(`${job.id}:${attempt.number}`);
      // The stage owns its per-attempt registries (QA state, recovery, completions).
      this.stage.forgetAttempt?.(job, attempt);
    }
    this.sweepJobMaterials(job, last(job).number);
    this.removeBuilderDiagnostics(job.id);
  }
  // Deletes every attempt material except the kept attempt's: runs/<jobId>/attempt-NNN
  // folders and page-builder/<jobId>/attempt-NNN.json files, including orphans no
  // state.json ever referenced. A stale legacy binding marker is reset so the next
  // read re-binds the preserved job-level legacy document to the current attempt.
  // Returns true when anything was deleted.
  sweepJobMaterials(job, keepNumber) {
    let swept = false;
    const runsDir = path.join(this.root, 'runs', job.id);
    const builderDir = path.join(this.root, 'page-builder', job.id);
    for (const dir of [runsDir, builderDir]) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const match = dir === runsDir ? entry.name.match(/^attempt-(\d{3,})$/) : entry.name.match(/^attempt-(\d{3,})\.json$/);
        if (!match || Number(match[1]) === keepNumber) continue;
        try { fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true }); swept = true; }
        catch (error) { console.error(`Удаление материалов попытки (${job.id}/${entry.name}): ${error.message}`); }
      }
    }
    try {
      const marker = path.join(builderDir, 'legacy-binding.json');
      if (fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')).attempt !== keepNumber) { fs.rmSync(marker, { force: true }); swept = true; }
    } catch (error) { console.error(`Сброс привязки legacy-документа (${job.id}): ${error.message}`); }
    return swept;
  }
  removeBuilderDiagnostics(jobId) {
    // Builder run files are named by generation, not attempt number; a fresh
    // attempt restarts generations at 1, so the whole diagnostics folder goes.
    try { fs.rmSync(path.join(this.root, 'page-builder', jobId, 'builder'), { recursive: true, force: true }); }
    catch (error) { console.error(`Удаление диагностики сборщика (${jobId}): ${error.message}`); }
  }
  retry(id) {
    const job = this.get(id);
    if (this.pendingFinalizations.has(id)) throw conflict('Завершение попытки ещё не сохранено; запись будет повторена.');
    if (!(TERMINAL.has(last(job).status) || last(job).status === 'paused') || this.active.has(id) || !this.stage.launchFinished(job, last(job))) throw conflict('Повтор доступен после доказанного завершения текущей попытки');
    this.newAttempt(job);
    try { this.save(); } catch (error) { job.attempts.pop(); throw error; }
    this.pruneAttempts(job);
    if (this.autoStart) this.pump();
  }
  // Restart a finished attempt from a later step: the new attempt reuses the
  // finished steps as evidence (the stage copies and re-validates it) and
  // re-runs the rest. Step 2 restarts also work during a live media download:
  // the worker is stopped first, exactly like the header stop button.
  async retryStage(id, stage) {
    if (stage !== 2) throw Object.assign(new Error('Недоступный шаг для перезапуска'), { statusCode: 400 });
    const job = this.get(id);
    if (this.pendingFinalizations.has(id)) throw conflict('Завершение попытки ещё не сохранено; запись будет повторена.');
    if (last(job).phase !== 'html-media' || last(job).captureStatus !== 'complete') throw conflict('Перезапуск с шага 2 доступен после завершения шага 1 (скриншоты и проверка)');
    if (this.active.has(id)) await this.stop(id);
    const previous = last(job);
    if (!(TERMINAL.has(previous.status) || previous.status === 'paused') || this.active.has(id) || !this.stage.launchFinished(job, previous)) throw conflict('Перезапуск доступен после доказанного завершения текущей попытки');
    const attempt = this.newAttempt(job);
    // A step restart continues the same task, so the timer carries over the
    // previous attempt's accumulated work (checkpointing first closes any live
    // interval, e.g. a still-running assembly). Only a full step 1 retry
    // starts the timer from zero.
    checkpointDuration(previous, this.clock());
    attempt.activeDurationMs = Math.max(0, previous.activeDurationMs || 0);
    if (previous.durationIncomplete) attempt.durationIncomplete = true;
    try { this.stage.retryFrom(job, attempt, previous); this.save(); }
    catch (error) { job.attempts.pop(); throw error; }
    this.pruneAttempts(job);
    if (this.autoStart) this.pump();
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
    if (this.pendingFinalizations.has(id)) throw conflict('Завершение попытки ещё не сохранено; запись будет повторена.');
    if (!['paused', 'interrupted'].includes(attempt.status) || this.active.has(id)) throw conflict('Возобновление доступно для приостановленной или прерванной попытки.');
    try { this.stage.validateResume(job, attempt); } catch (error) { throw conflict(error.message); }
    const previous = structuredClone(attempt);
    Object.assign(attempt, { status: 'queued', queuedAt: now(), queueOrder: ++this.nextQueueOrder });
    this.stage.prepareResume(attempt);
    delete attempt.finalizationError;
    try { this.save(); } catch (error) { Object.assign(attempt, previous); throw error; }
    if (this.autoStart) this.pump();
  }
  pump() {
    if (this.closing) return;
    for (const [id, finalize] of this.pendingFinalizations || []) {
      if (!finalize()) return;
      this.pendingFinalizations.delete(id);
    }
    this.stage.recoverPending();
    for (const job of this.jobs) if (!last(job).finalizationError) this.stage.recoverJob(job);
    // Fairness: a free slot is offered to the assembly queue first; stage 1-2
    // jobs start when the build queue is empty or cannot take the slot.
    this.builder?.pump();
    // hasFreeSlot() inlined (same derivation): pump must stay callable on bare
    // duck-typed queue objects that carry only the data fields.
    while (this.active.size + this.stage.occupiedSlots() + (this.builder ? this.builder.running.size : 0) < this.concurrency) {
      const queued = this.jobs.filter(job => last(job).status === 'queued' && this.stage.isRunnable(last(job), this.clock())).sort((a, b) => last(a).queueOrder - last(b).queueOrder);
      if (!queued.length) return;
      this.launch(queued[0]);
      if (this.pendingFinalizations?.size) return;
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
    return { csrfToken, concurrency: this.concurrency, jobs: this.jobs.map(job => {
      const projection = this.stage.jobProjection(job);
      const attempts = job.attempts.map(attempt => {
        const reasoningLine = this.reasoningTails.get(`${job.id}:${attempt.number}`);
        return { ...attempt, ...(reasoningLine ? { reasoningLine } : {}), ...(this.pageBuilder ? { pageBuilder: this.pageBuilder.summary(job.id, attempt.number) } : {}), files: (attempt.files || []).map(file => ({ ...file,
          url: `/api/files/${job.id}/${attempt.number}/${encodeURIComponent(file.name)}` })) };
      });
      return { ...job, status: last(job).status, ...projection,
        ...(this.pendingFinalizations.has(job.id) ? { canContinueQa: false, canResume: false, canPause: false, canRecapture: false } : {}),
        ...(this.pageBuilder ? { pageBuilder: attempts.at(-1).pageBuilder } : {}),
        isActive: this.active.has(job.id) && this.active.get(job.id).exitCode === null, attempts };
    }) };
  }
}
module.exports = { PageQueue };
