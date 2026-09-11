'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { APP_ROOT, dataRoot, dataSubdir } = require('./data-dir.cjs');
const { ACTIVE, TERMINAL, normalizeUrl, safeFile, layout, resolveRuntime, inspectArtifacts, stopTree } = require('./lib.cjs');
const { atomicJson, paths, sealedManifest, checkManifest, effectiveManifest, stageBatch, loadQa, reviews, counts, nextReview, validateReview, buildQaPrompt } = require('./qa.cjs');
const { AppServer } = require('./app-server.cjs');
const { readLaunch, readLease, publishLease, recoverLease, launchWorker } = require('./launcher.cjs');
const pidAlive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const now = () => new Date().toISOString();
const last = job => job.attempts.at(-1);
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

class Queue {
  constructor({ root = dataRoot(), workspace = APP_ROOT, concurrency = 2, spawnFn = launchWorker, stopFn = stopTree, codex = 'codex', autoStart = true,
    idleTimeoutMs = Number(process.env.ARM_IDLE_TIMEOUT_MS || 600000), launchGraceMs = 5000, qaAutoRetryLimit = 3, qaRetryDelayMs = 5000,
    clock = Date.now, setTimer = setInterval, clearTimer = clearInterval, isPidAlive = pidAlive, appServerFactory } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency должен быть целым числом 1–8');
    Object.assign(this, { root, workspace, concurrency, spawnFn, stopFn, codex, autoStart });
    if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new Error('ARM_IDLE_TIMEOUT_MS должен быть положительным целым');
    if (!Number.isInteger(launchGraceMs) || launchGraceMs < 1) throw new Error('launchGraceMs должен быть положительным целым');
    if (!Number.isInteger(qaAutoRetryLimit) || qaAutoRetryLimit < 0 || qaAutoRetryLimit > 3 || !Number.isInteger(qaRetryDelayMs) || qaRetryDelayMs < 1) throw new Error('Некорректные параметры QA retry');
    Object.assign(this, { idleTimeoutMs, launchGraceMs, qaAutoRetryLimit, qaRetryDelayMs, clock, setTimer, clearTimer, isPidAlive });
    this.qaStates = new Map(); this.monitors = new Map(); this.qaCompletions = new Map(); this.reviewListeners = new Set();
    this.recoveredQa = new Map();
    this.runtime = resolveRuntime();
    const tempDir = dataSubdir('tmp', root);
    Object.assign(this.runtime.env, { TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir });
    this.appServerFactory = appServerFactory || (() => new AppServer({ codex, env: this.runtime.env, root }));
    this.qaServers = new Set();
    this.stateFile = path.join(root, 'state.json');
    this.active = new Map();
    this.closing = false;
    fs.mkdirSync(root, { recursive: true });
    const saved = fs.existsSync(this.stateFile) ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : null;
    this.jobs = saved ? saved.jobs : [];
    if (saved && Object.hasOwn(saved, 'concurrency')) {
      if (!Number.isInteger(saved.concurrency) || saved.concurrency < 1 || saved.concurrency > 8) throw new Error('Некорректная concurrency в state.json');
      this.concurrency = saved.concurrency;
    }
    if (!Array.isArray(this.jobs)) throw new Error('Некорректный state.json; сохраните его для диагностики');
    for (const job of this.jobs) {
      if (!/^[a-f0-9-]{36}$/.test(job.id) || normalizeUrl(job.url) !== job.url || !Array.isArray(job.attempts) || !job.attempts.length) throw new Error('Некорректное задание в state.json');
      for (const attempt of job.attempts) {
        if (!Number.isInteger(attempt.number) || attempt.number < 1) throw new Error('Некорректная попытка');
        let launch;
        try { launch = readLaunch(layout(root, job, attempt).dir); }
        catch (error) { attempt.status = 'needs_review'; attempt.error = error.message; }
        if (launch) {
          attempt.launch = launch;
          if (!this.launchFinished(job, attempt)) {
            if (launch.phase === 'qa') this.recoveredQa.set(`${job.id}:${attempt.number}`, { job, attempt });
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
            if (attempt.status === 'interrupted' || (attempt.status === 'queued' && attempt.phase === 'capture' && attempt.captureStarted)) {
              attempt.status = attempt.captureSealed ? this.outcome(job, attempt) : 'incomplete';
              attempt.error = 'Backend перезапущен; принятые QA checkpoints сохранены. Продолжение требует завершённого launch lease; отсутствие PID само по себе не доказывает завершение.';
            }
          } catch (error) { attempt.status = 'needs_review'; attempt.error = error.message; }
        }
      }
    }
    this.nextQueueOrder = this.jobs.flatMap(job => job.attempts).reduce((max, attempt) => Math.max(max, attempt.queueOrder || 0), 0);
    this.save();
    this.recoveryTimer = this.setTimer(() => { if (this.autoStart && !this.closing) this.pump(); }, 1000);
    this.recoveryTimer?.unref?.();
    if (autoStart) setImmediate(() => this.pump());
  }
  save() {
    atomicJson(this.stateFile, { version: 2, concurrency: this.concurrency, jobs: this.jobs });
  }
  subscribeReviews(listener) {
    this.reviewListeners.add(listener);
    return () => this.reviewListeners.delete(listener);
  }
  notifyReviewAccepted(event) {
    for (const listener of this.reviewListeners) {
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
    const attempt = { workflow: 2, phase: 'capture', number: job.attempts.reduce((max, item) => Math.max(max, item.number), 0) + 1, status: 'queued', createdAt: now(), queuedAt: now(), queueOrder: ++this.nextQueueOrder, issues: [], files: [] };
    fs.mkdirSync(path.join(this.root, 'runs', job.id), { recursive: true });
    let locations;
    // Reserve atomically. Preserve orphan folders left before a state.json save.
    while (true) {
      locations = layout(this.root, job, attempt);
      try { fs.mkdirSync(locations.dir); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; attempt.number++; }
    }
    fs.mkdirSync(locations.output);
    fs.writeFileSync(path.join(locations.dir, 'job.json'), JSON.stringify({ jobId: job.id, url: job.url, attempt: attempt.number }, null, 2));
    job.attempts.push(attempt);
    return attempt;
  }
  get(id) { const job = this.jobs.find(item => item.id === id); if (!job) throw Object.assign(new Error('Задание не найдено'), { statusCode: 404 }); return job; }
  retry(id) {
    const job = this.get(id);
    if (!TERMINAL.has(last(job).status) || this.active.has(id) || !this.launchFinished(job, last(job))) throw conflict('Повтор доступен после доказанного завершения текущей попытки');
    this.newAttempt(job); this.save(); if (this.autoStart) this.pump();
  }
  qaState(job, attempt) { return this.qaStates.get(`${job.id}:${attempt.number}`); }
  launchFinished(job, attempt) {
    const dir = layout(this.root, job, attempt).dir;
    try {
      const launch = readLaunch(dir);
      if (!launch) return !(attempt.orphanPid && this.isPidAlive(attempt.orphanPid)); // legacy history only
      let lease;
      try { lease = readLease(dir, launch); }
      catch (error) { if (error.code !== 'ENOENT') return false; }
      if (lease?.status === 'finished') { this.qaCompletions.delete(launch.token); return true; }
      if (launch.leaseProtocol === 3) {
        const completion = this.qaCompletions.get(launch.token);
        if (completion?.generation === launch.generation) {
          // Only this backend's observed completion is retryable here. Never
          // reconstruct this authority from state.json after a restart.
          try {
            publishLease(dir, launch, completion.fields);
            this.qaCompletions.delete(launch.token);
            return true;
          } catch (error) {
            attempt.error = `Не удалось записать finished lease QA: ${error.message}. Завершение подтверждено; запись будет повторена.`;
            return false;
          }
        }
        if (this.active.has(job.id) || this.clock() - launch.createdAtMs < this.launchGraceMs || !Number.isInteger(launch.backendPid) || this.isPidAlive(launch.backendPid)) return false;
        // No request can precede the durable appServerPid lease. A dead backend
        // with no lease never dispatched QA. Otherwise require server death too.
        if (lease && (!Number.isInteger(lease.appServerPid) || this.isPidAlive(lease.appServerPid))) return false;
        publishLease(dir, launch, { status: 'finished', proof: lease ? 'qa-owner-and-server-dead' : 'qa-never-dispatched', finishedAt: now() });
        return true;
      }
      return !this.active.has(job.id) && recoverLease(dir, launch, { timestamp: this.clock(), graceMs: this.launchGraceMs, isPidAlive: this.isPidAlive });
    } catch { return false; } // corrupt/foreign/uncertain claims remain blocked
  }
  ownsLaunch(job, attempt, launch) {
    try {
      const current = readLaunch(layout(this.root, job, attempt).dir);
      return current?.token === launch.token && current.generation === launch.generation;
    } catch { return false; }
  }
  ownsStopCompletion(job, attempt, child) {
    if (last(job) !== attempt || !this.ownsLaunch(job, attempt, child.armLaunch)) return false;
    const active = this.active.get(job.id);
    // A taskkill proof can arrive after close. Accept it only for the same
    // terminal launch, never for a continued queued attempt or a replacement.
    return active === child || (!active && child.armClosed === true && TERMINAL.has(attempt.status));
  }
  confirmStopped(job, attempt, child) {
    // Windows taskkill /T /F confirms the tree. POSIX stopTree only dispatches
    // signals, so a killed wrapper without its finished lease remains uncertain.
    if (child.isQa || process.platform !== 'win32') return;
    if (!child.armClosed || !child.armStopConfirmed || !this.ownsLaunch(job, attempt, child.armLaunch)) return;
    publishLease(layout(this.root, job, attempt).dir, child.armLaunch, { status: 'finished', pid: child.pid, finishedAt: now(), proof: 'confirmed-tree-stop' });
  }
  refreshArtifacts(job, attempt) {
    if (attempt.workflow !== 2) return;
    const artifacts = inspectArtifacts(this.root, job, attempt), p = paths(this.root, job, attempt);
    // A partial report rewrite is transient: keep the last successfully discovered files.
    let qa = this.qaState(job, attempt);
    if (!qa) {
      qa = loadQa(this.root, job, attempt);
      if (!qa) {
        const manifest = sealedManifest(artifacts, job, attempt);
        if (manifest) {
          qa = { manifest, progress: { version: 2, manifestHash: manifest.hash, generation: 0, checkpoints: [] } };
          atomicJson(p.manifest, manifest); atomicJson(p.progress, qa.progress);
        }
      }
      if (qa) this.qaStates.set(`${job.id}:${attempt.number}`, qa);
    }
    if (qa) {
      attempt.captureSealed = true; attempt.manifestHash = qa.manifest.hash;
      attempt.captureSummary = effectiveManifest(qa.manifest).summary; attempt.qa = counts(qa.manifest, qa.progress);
      if (attempt.lastMeaningfulAt === undefined) attempt.lastMeaningfulAt = this.clock();
    }
    if (!artifacts.report) return;
    const accepted = qa ? reviews(qa.progress) : new Map();
    attempt.files = artifacts.files.map(file => ({ ...file, ...(file.kind === 'png' ? { qaStatus: accepted.get(file.name)?.sha256 === file.sha256 ? accepted.get(file.name).status : 'unreviewed' } : {}) }));
    if (!qa) attempt.qa = { total: attempt.files.filter(f => f.kind === 'png').length, reviewed: 0, passed: 0, issues: 0, unreviewed: attempt.files.filter(f => f.kind === 'png').length };
  }
  outcome(job, attempt) {
    const qa = this.qaState(job, attempt);
    if (!qa) {
      const artifacts = inspectArtifacts(this.root, job, attempt);
      attempt.issues = [...(artifacts.issues || []), ...(artifacts.error ? [artifacts.error] : [])];
      return artifacts.report || attempt.exitCode === 2 ? 'incomplete' : 'failed';
    }
    try { checkManifest(this.root, job, attempt, qa.manifest); delete attempt.manifestError; }
    catch (error) { attempt.manifestError = error.message; attempt.issues = [error.message]; return 'incomplete'; }
    attempt.qa = counts(qa.manifest, qa.progress);
    const effective = effectiveManifest(qa.manifest);
    attempt.issues = [...effective.summary.issues, ...[...reviews(qa.progress).values()].flatMap(file => file.issues.map(issue => `${file.name}: ${issue}`))];
    if (!effective.technicalComplete || attempt.qa.issues) return 'incomplete';
    return attempt.qa.unreviewed ? 'needs_review' : 'complete';
  }
  canContinueQa(job) {
    const attempt = last(job), qa = this.qaState(job, attempt);
    return Boolean(TERMINAL.has(attempt.status) && !this.active.has(job.id) && qa && counts(qa.manifest, qa.progress).unreviewed && !attempt.manifestError && this.launchFinished(job, attempt));
  }
  ['continue-qa'](id) {
    const job = this.get(id), attempt = last(job);
    this.refreshArtifacts(job, attempt);
    if (!this.canContinueQa(job)) throw conflict('Продолжение проверки недоступно: нет оставшихся PNG либо завершение прежнего launch lease ещё не доказано.');
    const qa = this.qaState(job, attempt);
    try { checkManifest(this.root, job, attempt, qa.manifest); }
    catch (error) { throw conflict(error.message); }
    this.queueQa(attempt);
    attempt.qaAutoRetries = 0; delete attempt.qaRetryAt;
    this.save(); if (this.autoStart) this.pump();
  }
  queueQa(attempt) {
    Object.assign(attempt, { phase: 'qa', status: 'queued', queuedAt: now(), queueOrder: ++this.nextQueueOrder });
    delete attempt.finishedAt; delete attempt.error; delete attempt.stopError; delete attempt.cancellationRequested; delete attempt.timeoutReason; delete attempt.orphanPid;
  }
  recoverQa(job) {
    const attempt = last(job);
    if (!Number.isInteger(attempt.qaAutoRetries ?? 0) || (attempt.qaAutoRetries ?? 0) < 0) return;
    if (this.closing || attempt.cancellationRequested || attempt.status === 'cancelled' || !TERMINAL.has(attempt.status) ||
        !attempt.captureSealed || (attempt.qaAutoRetries || 0) >= this.qaAutoRetryLimit || !this.canContinueQa(job)) return;
    try {
      checkManifest(this.root, job, attempt, this.qaState(job, attempt).manifest);
      // Retry only a known QA launch or a capture worker stopped after sealing.
      const launch = readLaunch(layout(this.root, job, attempt).dir);
      if (!launch || (launch.phase !== 'qa' && !attempt.timeoutReason)) return;
      this.queueQa(attempt);
      attempt.qaAutoRetries = (attempt.qaAutoRetries || 0) + 1;
      attempt.qaRetryAt = this.clock() + this.qaRetryDelayMs;
      this.save();
    } catch (error) { attempt.error = error.message; this.save(); }
  }
  pause(id) {
    const attempt = last(this.get(id));
    if (attempt.status !== 'queued' || attempt.startedAt || this.active.has(id)) throw conflict('Пауза доступна только для ещё не запущенного задания в очереди; обновите состояние.');
    attempt.status = 'paused';
    try { this.save(); } catch (error) { attempt.status = 'queued'; throw error; }
  }
  resume(id) {
    const attempt = last(this.get(id));
    if (attempt.status !== 'paused' || attempt.startedAt || this.active.has(id)) throw conflict('Возобновление доступно только для ещё не запущенной попытки на паузе.');
    const previous = { status: attempt.status, queuedAt: attempt.queuedAt, queueOrder: attempt.queueOrder };
    Object.assign(attempt, { status: 'queued', queuedAt: now(), queueOrder: ++this.nextQueueOrder });
    try { this.save(); } catch (error) { Object.assign(attempt, previous); throw error; }
    if (this.autoStart) this.pump();
  }
  pump() {
    if (this.closing) return;
    // A restarted backend does not own these processes and must not kill them.
    // Their durable leases still consume global capacity until the same proof
    // that permits company retry confirms completion (including grace/PIDs).
    for (const [key, { job, attempt }] of this.recoveredQa) {
      if (this.launchFinished(job, attempt)) this.recoveredQa.delete(key);
    }
    for (const job of this.jobs) this.recoverQa(job);
    while (this.active.size + this.recoveredQa.size < this.concurrency) {
      const queued = this.jobs.filter(job => last(job).status === 'queued' && (!last(job).qaRetryAt || last(job).qaRetryAt <= this.clock())).sort((a, b) => last(a).queueOrder - last(b).queueOrder);
      if (!queued.length) return;
      this.launch(queued[0]);
    }
  }
  launch(job) {
    const attempt = last(job), locations = layout(this.root, job, attempt);
    if (!this.launchFinished(job, attempt)) { attempt.status = 'needs_review'; attempt.error = 'Запуск заблокирован: прежний launch lease не завершён'; this.save(); return; }
    if (attempt.phase === 'qa') { this.launchQa(job, attempt); return; }
    let prompt = '', command, args;
    try {
        if (attempt.captureStarted) throw new Error('Capture уже запускался в этой попытке; используйте новую попытку');
        attempt.captureStarted = true; attempt.phase = 'capture'; attempt.workflow = 2;
        // Direct backend spawn is the only owner of helper invocation; no agent can retry it.
        command = this.runtime.node;
        args = [path.join(APP_ROOT, 'src', 'capture.cjs'), '--url', job.url, '--out', locations.output,
          ...(this.runtime.chrome ? ['--executable', this.runtime.chrome] : ['--channel', 'chrome'])];
        fs.writeFileSync(path.join(locations.dir, 'prompt.txt'), JSON.stringify({ command, args }, null, 2));
    } catch (error) { attempt.status = attempt.captureSealed ? 'incomplete' : 'failed'; attempt.error = error.message; attempt.finishedAt = now(); this.save(); return; }
    const priorLaunch = readLaunch(locations.dir);
    const launch = { token: crypto.randomUUID(), generation: (priorLaunch?.generation || 0) + 1, phase: attempt.phase, status: 'launch-pending', createdAtMs: this.clock(), leaseProtocol: 2 };
    const descriptor = path.join(locations.dir, `launch-${launch.token}.json`);
    atomicJson(descriptor, { ...launch, command, args, cwd: this.workspace });
    // This independent durable fence is authoritative even if state.json still
    // contains the previous PID when the parent dies. Unknown pending never retries.
    atomicJson(path.join(locations.dir, 'launch-current.json'), launch);
    attempt.launch = launch; delete attempt.pid; delete attempt.orphanPid;
    attempt.status = 'running'; attempt.startedAt ||= now(); delete attempt.finishedAt; this.save();
    let child;
    const stdout = fs.openSync(path.join(locations.dir, 'events.jsonl'), 'a');
    const stderr = fs.openSync(path.join(locations.dir, 'stderr.log'), 'a');
    try {
      child = this.spawnFn(command, args, {
        cwd: this.workspace, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', stdout, stderr], env: this.runtime.env,
        armLaunch: { ...launch, dir: locations.dir, descriptor },
      });
    } catch (error) {
      fs.closeSync(stdout); fs.closeSync(stderr);
      publishLease(locations.dir, launch, { status: 'finished', proof: 'spawn-threw-before-child', finishedAt: now() });
      attempt.status = attempt.captureSealed ? this.outcome(job, attempt) : 'failed'; attempt.error = error.message; attempt.finishedAt = now(); this.save();
      return;
    }
    fs.closeSync(stdout); fs.closeSync(stderr);
    child.armLaunch = launch;
    this.active.set(job.id, child); attempt.pid = child.pid; this.save();
    const monitor = this.setTimer(() => { this.tick(job, attempt, child).catch(error => { if (this.ownsStopCompletion(job, attempt, child)) { attempt.error = error.message; this.save(); } }); }, Math.min(1000, this.idleTimeoutMs));
    monitor?.unref?.(); this.monitors.set(job.id, monitor);
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') spawnError = error; });
    child.once('close', (exitCode, signal) => {
      if (this.active.get(job.id) !== child || !this.ownsLaunch(job, attempt, launch)) return;
      child.armClosed = true; this.confirmStopped(job, attempt, child);
      this.clearTimer(this.monitors.get(job.id)); this.monitors.delete(job.id);
      this.active.delete(job.id);
      attempt.exitCode = exitCode; attempt.signal = signal; attempt.finishedAt = now();
      try { this.refreshArtifacts(job, attempt); } catch (error) { attempt.error = error.message; }
      if (attempt.cancellationRequested || attempt.status === 'cancelled') {
        attempt.status = 'cancelled';
        if (attempt.stopError && attempt.error === attempt.stopError) delete attempt.error;
        delete attempt.stopError;
      } else {
        attempt.status = 'validating'; this.save();
        try {
          if (spawnError) attempt.error = spawnError.message;
          attempt.status = this.outcome(job, attempt);
        } catch (error) { attempt.error = `Проверка результата: ${error.message}`; attempt.status = this.outcome(job, attempt); }
        if (!this.closing && !attempt.timeoutReason && this.launchFinished(job, attempt) && attempt.captureSealed && attempt.qa?.unreviewed && !spawnError && [0, 2].includes(exitCode)) {
          attempt.phase = 'qa'; attempt.status = 'queued'; attempt.queueOrder = ++this.nextQueueOrder; delete attempt.finishedAt;
        }
      }
      try {
        atomicJson(path.join(locations.dir, 'result.json'), attempt);
        this.save();
      } catch (error) { this.closing = true; console.error('Не удалось сохранить результат, очередь остановлена:', error); }
      this.pump();
    });
    child.stdin.end(prompt, 'utf8');
  }
  launchQa(job, attempt) {
    const p = paths(this.root, job, attempt), qa = this.qaState(job, attempt);
    let session, qaDir, launch, appServer;
    try {
      checkManifest(this.root, job, attempt, qa.manifest);
      session = nextReview(qa.manifest, qa.progress);
      if (!session) { attempt.status = this.outcome(job, attempt); this.save(); return; }
      const progress = { ...qa.progress, generation: session.generation };
      atomicJson(p.progress, progress); qa.progress = progress;
      qaDir = stageBatch(p.hostDir, session, this.root);
      const previous = readLaunch(p.dir);
      launch = { token: crypto.randomUUID(), generation: (previous?.generation || 0) + 1, qaGeneration: session.generation,
        phase: 'qa', status: 'launch-pending', createdAtMs: this.clock(), leaseProtocol: 3, backendPid: process.pid };
      atomicJson(path.join(p.dir, 'launch-current.json'), launch);
      attempt.launch = launch; delete attempt.pid; delete attempt.orphanPid; delete attempt.qaIdentity;
      Object.assign(attempt, { status: 'running', lastMeaningfulAt: this.clock() }); delete attempt.finishedAt;
      this.save();
      const prompt = buildQaPrompt(qa.manifest, session);
      fs.writeFileSync(path.join(p.dir, `qa-${session.generation}-prompt.txt`), prompt);
      let identity = {}, child;
      appServer = this.appServerFactory(); this.qaServers.add(appServer);
      child = appServer.review({ ...session, cwd: qaDir, prompt,
        onIdentity: fields => {
          if (!this.ownsLaunch(job, attempt, launch) || this.active.get(job.id) !== child) throw new Error('Stale QA launch');
          identity = { ...identity, ...fields };
          publishLease(p.dir, launch, { status: 'running', backendPid: process.pid, ...identity });
          attempt.qaIdentity = { generation: session.generation, ...identity }; this.save();
        },
        onReview: (review, incoming) => {
          if (this.active.get(job.id) !== child || last(job) !== attempt || !this.ownsLaunch(job, attempt, launch) || attempt.status !== 'running' || attempt.cancellationRequested || attempt.timeoutReason ||
              incoming.generation !== session.generation || incoming.generation !== qa.progress.generation || incoming.threadId !== identity.threadId || incoming.turnId !== identity.turnId || !identity.threadId || !identity.turnId) throw new Error('Stale generation/thread/turn');
          checkManifest(this.root, job, attempt, qa.manifest);
          validateReview(review);
          const accepted = reviews(qa.progress), expected = session.files.find(file => !accepted.has(file.name));
          if (!expected || expected.name !== review.name || expected.sha256 !== review.sha256 || accepted.has(review.name)) throw new Error('record_review outside manifest/order or duplicate/hash mismatch');
          const checkpoint = { generation: session.generation, manifestHash: qa.manifest.hash, threadId: identity.threadId, turnId: identity.turnId,
            review: JSON.parse(JSON.stringify(review)), acceptedAt: now() };
          const updated = { ...qa.progress, checkpoints: [...qa.progress.checkpoints, checkpoint] };
          // Commit before acknowledging the tool; state is a recoverable projection.
          atomicJson(p.progress, updated); qa.progress = updated;
          attempt.lastMeaningfulAt = this.clock(); attempt.qaAutoRetries = 0; delete attempt.qaRetryAt;
          this.refreshArtifacts(job, attempt);
          try { this.save(); } catch (error) { attempt.error = `Checkpoint сохранён; проекция state не записана: ${error.message}`; }
          this.notifyReviewAccepted({ jobId: job.id, attempt: attempt.number, name: review.name });
          return { accepted: review.name, ...attempt.qa };
        },
        onLog: text => fs.appendFileSync(path.join(p.dir, 'stderr.log'), text),
      });
      child.armLaunch = launch; this.active.set(job.id, child);
      const monitor = this.setTimer(() => this.tick(job, attempt, child).catch(error => { if (this.ownsStopCompletion(job, attempt, child)) { attempt.error = error.message; this.save(); } }), Math.min(1000, this.idleTimeoutMs));
      monitor?.unref?.(); this.monitors.set(job.id, monitor);
      child.once('close', code => {
        this.qaServers.delete(appServer);
        if (this.active.get(job.id) !== child || !this.ownsLaunch(job, attempt, launch)) return;
        if (child.exitCode === null || !['app-server-closed', 'no-app-server'].includes(child.completionProof)) return;
        this.qaCompletions.set(launch.token, { generation: launch.generation,
          fields: { status: 'finished', ...identity, proof: child.completionProof, finishedAt: now() } });
        // The trusted transport has proved completion. Release the slot even if
        // atomic lease publication fails; continue/retry still require its
        // durable publication through launchFinished and the current token fence.
        child.armClosed = true; this.clearTimer(this.monitors.get(job.id)); this.monitors.delete(job.id); this.active.delete(job.id);
        attempt.exitCode = code; attempt.finishedAt = now();
        if (child.failure) attempt.error = child.failure.message;
        this.launchFinished(job, attempt);
        this.refreshArtifacts(job, attempt);
        attempt.status = attempt.cancellationRequested ? 'cancelled' : this.outcome(job, attempt);
        fs.rmSync(qaDir, { recursive: true, force: true });
        atomicJson(path.join(p.dir, 'result.json'), attempt); this.save(); this.pump();
      });
    } catch (error) {
      if (appServer && !this.active.has(job.id)) appServer.shutdown().finally(() => this.qaServers.delete(appServer)).catch(failure => console.error('QA shutdown:', failure.message));
      if (qaDir && !this.active.has(job.id)) fs.rmSync(qaDir, { recursive: true, force: true });
      if (launch && !this.active.has(job.id)) publishLease(p.dir, launch, { status: 'finished', proof: 'qa-setup-failed', finishedAt: now() });
      attempt.error = error.message; attempt.status = this.outcome(job, attempt); attempt.finishedAt = now(); this.save();
    }
  }
  async tick(job, attempt, child) {
    if (this.active.get(job.id) !== child || child.exitCode !== null || !this.ownsLaunch(job, attempt, child.armLaunch)) return;
    this.refreshArtifacts(job, attempt);
    if (!attempt.captureSealed || attempt.timeoutReason || attempt.cancellationRequested || this.clock() - attempt.lastMeaningfulAt < this.idleTimeoutMs) return;
    attempt.timeoutReason = 'idle_timeout'; attempt.error = `Нет подтверждённого прогресса QA в течение ${this.idleTimeoutMs} ms`; attempt.status = 'stopping'; this.save();
    try {
      const proof = await (child.isQa ? child.interrupt() : this.stopFn(child));
      if (!this.ownsStopCompletion(job, attempt, child)) return;
      child.armStopConfirmed = proof?.treeStopped === true; this.confirmStopped(job, attempt, child);
      if (!this.active.has(job.id)) this.pump();
    }
    catch (error) {
      if (!this.ownsStopCompletion(job, attempt, child)) return;
      attempt.status = this.outcome(job, attempt); attempt.finishedAt = now();
      attempt.stopError = `Остановка по idle timeout не подтверждена: ${error.message}`; attempt.error = attempt.stopError; this.save();
    }
    if (this.ownsStopCompletion(job, attempt, child) && this.active.get(job.id) === child && attempt.status === 'stopping') { attempt.status = this.outcome(job, attempt); attempt.finishedAt = now(); this.save(); }
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
      const proof = await (child.isQa ? child.interrupt() : this.stopFn(child));
      if (!this.ownsStopCompletion(job, attempt, child)) return;
      child.armStopConfirmed = proof?.treeStopped === true; this.confirmStopped(job, attempt, child);
    }
    catch (error) {
      if (!this.ownsStopCompletion(job, attempt, child)) return;
      if (this.active.has(id)) attempt.status = attempt.timeoutReason ? this.outcome(job, attempt) : 'running';
      attempt.stopError = `Остановка процесса не подтверждена; можно повторить: ${error.message}`;
      attempt.error = attempt.stopError;
      this.save(); throw error;
    }
  }
  async shutdown() {
    this.closing = true;
    this.clearTimer(this.recoveryTimer);
    await Promise.allSettled([...this.active.keys()].map(id => this.stop(id)));
    await Promise.allSettled([...this.qaServers].map(appServer => appServer.shutdown()));
  }
  snapshot(csrfToken) {
    for (const job of this.jobs) for (const attempt of job.attempts) {
      if (attempt.workflow === 2) {
        try {
          this.refreshArtifacts(job, attempt);
          if (attempt.captureSealed && ['complete', 'needs_review', 'incomplete'].includes(attempt.status)) attempt.status = this.outcome(job, attempt);
        } catch (error) { attempt.error = error.message; if (attempt.status === 'complete') attempt.status = 'incomplete'; }
      }
    }
    return { csrfToken, concurrency: this.concurrency, jobs: this.jobs.map(job => ({ ...job, status: last(job).status,
      canContinueQa: this.canContinueQa(job),
      canStop: this.active.has(job.id) && this.active.get(job.id).exitCode === null,
      attempts: job.attempts.map(attempt => ({ ...attempt, files: (attempt.files || []).map(file => ({ ...file,
        url: `/api/files/${job.id}/${attempt.number}/${encodeURIComponent(file.name)}` })) })) })) };
  }
}

function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Нужен Content-Type application/json'), { statusCode: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 150 * 1024) throw new Error('Слишком большой запрос'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createServer(queue) {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/app.css', ['app.css', 'text/css; charset=utf-8']],
    ['/vendor/css/tabler.css', ['vendor/css/tabler.css', 'text/css; charset=utf-8']], ['/vendor/js/tabler.js', ['vendor/js/tabler.js', 'text/javascript; charset=utf-8']],
    ['/assets/astronaut.png', ['assets/astronaut.png', 'image/png']],
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const host = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(res, 403, { error: 'Разрешён только локальный origin' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site запрос запрещён' });
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'POST') {
        if (req.headers['x-csrf-token'] !== csrfToken) return json(res, 403, { error: 'Неверный CSRF token; обновите страницу' });
        const data = await body(req);
        if (url.pathname === '/api/settings') {
          if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'concurrency')) throw new Error('Разрешено только поле concurrency');
          return json(res, 200, queue.setConcurrency(data.concurrency));
        }
        if (url.pathname === '/api/jobs') {
          if (!data || Object.keys(data).some(key => key !== 'urls')) throw new Error('Разрешено только поле urls');
          return json(res, 200, queue.add(data.urls));
        }
        const action = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(stop|retry|pause|resume|continue-qa)$/);
        if (action) {
          if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) throw new Error('Этот запрос не принимает параметры');
          await queue[action[2]](action[1]); return json(res, 200, { ok: true });
        }
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Метод не поддерживается' });
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        const unsubscribe = queue.subscribeReviews(event => {
          if (!res.destroyed && !res.writableEnded) res.write(`event: qa-review\ndata: ${JSON.stringify(event)}\n\n`);
        });
        const cleanup = () => unsubscribe();
        req.once('close', cleanup); res.once('close', cleanup);
        return;
      }
      if (url.pathname === '/api/state') return json(res, 200, queue.snapshot(csrfToken));
      const logs = url.pathname.match(/^\/api\/logs\/([a-f0-9-]{36})\/([1-9][0-9]*)$/);
      if (logs) {
        const job = queue.get(logs[1]), attempt = job.attempts.find(a => a.number === Number(logs[2]));
        if (!attempt) return json(res, 404, { error: 'Попытка не найдена' });
        const stream = url.searchParams.get('stream');
        if (!['stdout', 'stderr'].includes(stream)) throw new Error('Неизвестный поток');
        const dir = layout(queue.root, job, attempt).dir;
        const file = path.join(dir, stream === 'stdout' ? 'events.jsonl' : 'stderr.log');
        if (!fs.existsSync(file)) return json(res, 200, { text: '', truncated: false });
        const allowed = safeFile(queue.root, safeFile(dir, file));
        const fd = fs.openSync(allowed, 'r');
        try {
          const size = fs.fstatSync(fd).size, start = Math.max(0, size - 128 * 1024), buffer = Buffer.alloc(size - start);
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
          return json(res, 200, { text: buffer.subarray(0, bytes).toString('utf8'), truncated: start > 0 });
        } finally { fs.closeSync(fd); }
      }
      const artifact = url.pathname.match(/^\/api\/files\/([a-f0-9-]{36})\/([1-9][0-9]*)\/([^/]+)$/);
      if (artifact) {
        const job = queue.get(artifact[1]), attempt = job.attempts.find(a => a.number === Number(artifact[2]));
        const name = decodeURIComponent(artifact[3]);
        const listed = attempt?.files?.find(file => file.name === name);
        if (!listed) return json(res, 404, { error: 'Файл не входит в список разрешённых результатов' });
        const locations = layout(queue.root, job, attempt);
        const file = safeFile(queue.root, safeFile(locations.dir, path.join(locations.hostDir, name)));
        res.writeHead(200, { 'Content-Type': listed.kind === 'png' ? 'image/png' : 'application/json; charset=utf-8' });
        const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      if (assets.has(url.pathname)) {
        const [name, mime] = assets.get(url.pathname);
        const publicRoot = path.join(APP_ROOT, 'public');
        const file = safeFile(publicRoot, path.join(publicRoot, name));
        res.writeHead(200, { 'Content-Type': mime });
        const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      json(res, 404, { error: 'Не найдено' });
    } catch (error) { if (!res.headersSent) json(res, error.statusCode || 400, { error: error.message }); else res.destroy(); }
  });
  return server;
}

function acquireLock(root) {
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, 'server.lock');
  try {
    const fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Повреждён server.lock; проверьте отсутствие работающего АРМ');
    try { process.kill(pid, 0); throw new Error(`АРМ уже работает (PID ${pid})`); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    fs.unlinkSync(lock);
    return acquireLock(root);
  }
  return () => { if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); };
}

if (require.main === module) {
  let unlock;
  try {
    const root = dataRoot();
    unlock = acquireLock(root);
    const port = Number(process.env.ARM_PORT || 4318);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ARM_PORT должен быть 1–65535');
    const queue = new Queue({ root, concurrency: Number(process.env.ARM_CONCURRENCY || 2), codex: process.env.ARM_CODEX_EXE || 'codex', autoStart: false });
    const server = createServer(queue);
    server.on('error', error => { console.error(error.message); queue.shutdown().finally(() => { unlock(); process.exit(1); }); });
    server.listen(port, '127.0.0.1', () => {
      console.log(`АРМ: http://127.0.0.1:${port} (параллельность ${queue.concurrency})`);
      queue.autoStart = true; queue.pump();
    });
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      server.close(); await queue.shutdown();
      const deadline = Date.now() + 5000;
      while (queue.active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      unlock(); process.exit(queue.active.size ? 1 : 0);
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('exit', unlock);
  } catch (error) { console.error(error.message); if (unlock) unlock(); process.exitCode = 1; }
}
module.exports = { Queue, createServer, acquireLock };
