'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { APP_ROOT } = require('../../../data-dir.cjs');
const { safeFile } = require('../../../infrastructure/files.cjs');
const { AppServer } = require('../../capture-qa/qa/app-server.cjs');
const { loadQa } = require('../../capture-qa/qa/progress.cjs');
const { checkManifest } = require('../../capture-qa/capture/manifest.cjs');
const { layout } = require('../../capture-qa/paths.cjs');
const { BLOCK_TYPES, isPristine } = require('../store.cjs');
const { stageBuilder, cleanupBuilder } = require('./staging.cjs');
const { BUILDER_POLICY, buildBuilderPrompt } = require('./policy.cjs');

const BUILDER_PROFILE = Object.freeze({ mcpName: 'reestr35-builder', tools: ['save_document', 'read_file'],
  relay: Object.freeze({ save_document: 'onSave', read_file: 'onReadFile' }),
  instructionsPath: path.join(APP_ROOT, 'src', 'page-builder-instructions.txt') });
const BUILDER_BRIDGE = path.join(APP_ROOT, 'src', 'stages', 'page-builder', 'agent', 'bridge.cjs');
const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'skipped', 'paused']);
const READ_WHITELIST = new Set(['source.html', 'media-catalog.json', 'frame-catalog.json', 'document-catalog.json', 'block-catalog.json', 'block-contract.json']);
const READ_FILE_MAX = 256 * 1024;
const READ_FILE_PAGE = 65536;
const SAVE_ARGUMENT_LIMIT = 512 * 1024;
const now = () => new Date().toISOString();
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

// Owns the step 3 assembly agent. Assemblies share the queue's common
// concurrency pool through the slots hooks instead of a private limit: a
// running session occupies one pool slot until its close handler, and
// publication stays the ordinary store.write -> sync.enqueue path.
class BuilderRunner {
  constructor(queue, { launch, zcodeError, appServerFactory, slots,
    idleTimeoutMs = Number(process.env.ARM_BUILD_IDLE_TIMEOUT_MS || 900000),
    saveLimit = Number(process.env.ARM_BUILD_SAVE_LIMIT || 8),
    retryLimit = 3, retryDelayMs = 5000, clock, setTimer, clearTimer } = {}) {
    if (!slots || typeof slots.available !== 'function' || typeof slots.released !== 'function') throw new Error('BuilderRunner requires slots hooks { available(), released() }');
    if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new Error('ARM_BUILD_IDLE_TIMEOUT_MS должен быть положительным целым');
    if (!Number.isInteger(saveLimit) || saveLimit < 1) throw new Error('ARM_BUILD_SAVE_LIMIT должен быть положительным целым');
    if (!Number.isInteger(retryLimit) || retryLimit < 0 || retryLimit > 10 || !Number.isInteger(retryDelayMs) || retryDelayMs < 1) throw new Error('Некорректные параметры повторов сборки');
    Object.assign(this, { queue, launch, zcodeError, slots, idleTimeoutMs, saveLimit, retryLimit, retryDelayMs,
      clock: clock || queue.clock, setTimer: setTimer || queue.setTimer, clearTimer: clearTimer || queue.clearTimer,
      appServerFactory: appServerFactory || (() => {
        if (!this.launch) throw new Error(this.zcodeError || this.queue.zcodeError || 'ZCode launch для сборки страницы не настроен: задайте ARM_ZCODE_API_KEY и установите ZCode CLI');
        return new AppServer({ launch: this.launch, env: this.queue.runtime.env, root: this.queue.root, profile: BUILDER_PROFILE });
      }),
      queueList: [], running: new Map(), ticker: null, pumpScheduled: false, stopping: false });
  }
  // Auto hook from stage 2 completion: never throws into the stage flow.
  consider(job, attempt) {
    try {
      if (this.stopping || this.queue.closing || job.attempts.at(-1) !== attempt) return;
      if (!['complete', 'ready_with_issues'].includes(attempt.htmlMedia?.status)) return;
      if (attempt.builder && !TERMINAL.has(attempt.builder.status)) return;
      const stored = this.queue.pageBuilder.read(job.id, { create: false, attempt: attempt.number });
      if (stored && !isPristine(stored.document)) {
        attempt.builder = { ...(attempt.builder || {}), status: 'skipped', error: 'Документ шага 3 уже заполнен', finishedAt: now() };
        this.persist(job, attempt);
        return;
      }
      this.enqueue(job, attempt);
    } catch (error) {
      attempt.builder = { ...(attempt.builder || {}), status: 'failed', error: `Автозапуск сборки не удался: ${error.message}`, finishedAt: now() };
      console.error(`Builder autostart (${job.id}): ${error.message}`);
      this.persist(job, attempt);
    }
  }
  // Manual trigger from the UI: strict conflicts, optional forced overwrite.
  // A forced request during a live assembly is a restart: the current run is
  // cancelled (its generation then rejects every late save) and a fresh
  // generation takes its place in the queue.
  request(jobId, { force = false } = {}) {
    if (this.stopping || this.queue.closing) throw conflict('Приложение завершает работу; сборка недоступна');
    const job = this.queue.get(jobId), attempt = job.attempts.at(-1);
    if (!['complete', 'ready_with_issues'].includes(attempt.htmlMedia?.status)) throw conflict('Сборка доступна после завершения шага 2 (HTML и медиа)');
    const builder = attempt.builder;
    if (builder?.finalizationError) throw conflict('Завершение сборки ещё не сохранено; запись будет повторена');
    if (builder && !TERMINAL.has(builder.status)) {
      if (!force) throw conflict('Сборка страницы уже выполняется');
      this.cancel(jobId);
    }
    const stored = this.queue.pageBuilder.read(jobId, { create: false, attempt: attempt.number });
    if (stored && !isPristine(stored.document)) {
      if (!force) throw conflict('Документ шага 3 уже заполнен; подтвердите перезапись');
      // От момента клика «Пересобрать» шаг 3 непеременно пуст: старые вкладки
      // не доживают до первого сохранения новой сборки, даже в очереди.
      this.queue.pageBuilder.reset(jobId, attempt.number);
    }
    this.enqueue(job, attempt);
    return { status: attempt.builder.status, generation: attempt.builder.generation };
  }
  currentRevision(jobId, attemptNumber) {
    try { return this.queue.pageBuilder.read(jobId, { create: false, attempt: attemptNumber })?.revision || 1; }
    catch { return 1; }
  }
  enqueue(job, attempt, { mode } = {}) {
    attempt.builder = { status: 'queued', generation: (attempt.builder?.generation || 0) + 1, policy: BUILDER_POLICY,
      revision: this.currentRevision(job.id, attempt.number), saveAttempts: 0, retries: 0, lastMeaningfulAt: this.clock(),
      ...(mode ? { mode } : {}) };
    this.queueList = this.queueList.filter(entry => entry.jobId !== job.id);
    this.queueList.push({ jobId: job.id, attemptNumber: attempt.number, readyAt: 0, retry: false });
    this.persist(job, attempt);
    this.schedulePump();
  }
  cancel(jobId) {
    const job = this.queue.get(jobId), attempt = job.attempts.at(-1), builder = attempt?.builder;
    if (!builder) throw conflict('Сборка не выполняется');
    if (builder.finalizationError) throw conflict('Завершение сборки ещё не сохранено; запись будет повторена');
    if (builder.status === 'queued' || builder.status === 'failed' && builder.retryAt !== undefined) {
      this.queueList = this.queueList.filter(entry => entry.jobId !== jobId);
      if (builder.status === 'queued') this.finalizeTerminal(job, attempt, () => { builder.status = 'cancelled'; });
      else { delete builder.retryAt; this.persist(job, attempt); }
      // A run may still belong to an older attempt of this job; it can no
      // longer save (stale guard) and must not linger until the idle timeout.
      const stale = this.running.get(jobId);
      if (stale && stale.attemptNumber !== attempt.number) void stale.session.interrupt().catch(() => {});
      this.schedulePump();
      return { ok: true };
    }
    if (builder.status === 'running' || builder.status === 'pausing') {
      const run = this.running.get(jobId);
      if (!run) throw conflict('Сессия сборщика уже завершается');
      run.cancelRequested = true;
      this.finalizeTerminal(job, attempt, () => { builder.status = 'cancelled'; delete builder.pauseRequested; });
      void run.session.interrupt().catch(error => console.error(`Builder stop (${jobId}): ${error.message}`));
      return { ok: true };
    }
    throw conflict('Сборка не выполняется');
  }
  pause(jobId) {
    if (this.stopping || this.queue.closing) throw conflict('Приложение завершает работу; сборка недоступна');
    const job = this.queue.get(jobId), attempt = job.attempts.at(-1), builder = attempt?.builder;
    if (!builder) throw conflict('Сборка не выполняется');
    if (builder.finalizationError) throw conflict('Завершение сборки ещё не сохранено; запись будет повторена');
    if (builder.status === 'queued') {
      this.queueList = this.queueList.filter(entry => entry.jobId !== jobId);
      this.finalizeTerminal(job, attempt, () => { builder.status = 'paused'; });
      this.schedulePump();
      return { ok: true };
    }
    if (builder.status === 'running') {
      const run = this.running.get(jobId);
      if (!run) throw conflict('Сессия сборщика уже завершается');
      // Каждая принятая вкладка уже атомарно на диске (модель QA): пауза
      // прерывает сессию сразу, а не ждёт следующей границы сохранения.
      builder.pauseRequested = true;
      builder.status = 'pausing';
      this.persist(job, attempt);
      void run.session.interrupt().catch(error => console.error(`Builder pause (${jobId}): ${error.message}`));
      return { ok: true };
    }
    throw conflict('Сборка не выполняется');
  }
  resume(jobId) {
    if (this.stopping || this.queue.closing) throw conflict('Приложение завершает работу; сборка недоступна');
    const job = this.queue.get(jobId), attempt = job.attempts.at(-1);
    if (!['complete', 'ready_with_issues'].includes(attempt.htmlMedia?.status)) throw conflict('Сборка доступна после завершения шага 2 (HTML и медиа)');
    const builder = attempt.builder;
    if (!builder || builder.status !== 'paused') throw conflict('Возобновление доступно для сборки на паузе');
    if (builder.finalizationError) throw conflict('Завершение сборки ещё не сохранено; запись будет повторена');
    this.enqueue(job, attempt, { mode: 'resume' });
    return { status: attempt.builder.status, generation: attempt.builder.generation };
  }
  restore() {
    let changed = false;
    for (const job of this.queue.jobs) {
      const attempt = job.attempts.at(-1), builder = attempt?.builder;
      if (!builder || typeof builder !== 'object' || !builder.status) continue;
      if (builder.status === 'running' || builder.status === 'pausing') {
        // Критерий возобновления — сам документ попытки: записи атомарны, и
        // вердикт одинаков при штатном завершении и падении процесса.
        let resumable = false;
        try {
          const stored = this.queue.pageBuilder.read(job.id, { create: false, attempt: attempt.number });
          resumable = Boolean(stored && !isPristine(stored.document));
        } catch { /* документ недоступен — продолжать нечего */ }
        if (resumable) { builder.status = 'paused'; builder.error = 'Сборка прервана перезапуском АРМа; можно продолжить'; }
        else { builder.status = 'failed'; builder.error = 'Сборка прервана перезапуском АРМа'; }
        builder.finishedAt = now(); changed = true;
      } else if (builder.status === 'queued') this.queueList.push({ jobId: job.id, attemptNumber: attempt.number, readyAt: 0, retry: false });
      if (builder.status === 'failed' && builder.retryAt !== undefined) {
        // A scheduled auto-retry never survives a restart; the manual button
        // still can start a fresh assembly generation.
        delete builder.retryAt; changed = true;
      }
      if (builder.pauseRequested) { delete builder.pauseRequested; changed = true; }
      if (builder.finalizationError) {
        // Рестарт перечитал вердикт с диска: терминальный статус уже записан
        // (или running только что свёрнут в paused/failed), а реестр ретраев
        // финализаций в памяти не переживает рестарт — маркер недозаписи устарел.
        delete builder.finalizationError; changed = true;
      }
      // Jobs that finished stage 2 before this start are not auto-queued; only
      // the live transition and the manual button enqueue fresh assemblies.
    }
    if (changed) { try { this.queue.save(); } catch (error) { console.error(`Builder restore (${error.message}): state не записан`); } }
  }
  // Enqueue paths (HTTP assemble, stage 2 completion) only queue and schedule:
  // the heavy staging (PNG re-hash, catalog choose) runs in a separately
  // scheduled pump, off the request and stage-transition call stacks.
  schedulePump() {
    if (this.pumpScheduled || this.stopping || this.queue.closing) return;
    this.pumpScheduled = true;
    setImmediate(() => { this.pumpScheduled = false; this.pump(); });
  }
  pump() {
    if (this.stopping || this.queue.closing) return;
    // Недозаписанный терминальный вердикт владеет состоянием сборки на диске:
    // пока финализация не доехала, новые раны не стартуют.
    if ([...this.queue.pendingFinalizations.keys()].some(key => key.startsWith('builder:'))) return;
    // The registry is keyed by jobId: at most one assembly per job, whatever
    // the pool size, so runs of different attempts can never overwrite each
    // other's registration. Entries of busy jobs wait in queueList for the
    // closing run's pump to pick them up. Slot availability is rechecked on
    // every iteration: startRun may open (or synchronously close) a session.
    while (this.slots.available()) {
      const index = this.queueList.findIndex(entry => (entry.readyAt || 0) <= this.clock() && !this.running.has(entry.jobId));
      if (index < 0) break;
      const [entry] = this.queueList.splice(index, 1);
      this.startRun(entry);
    }
    this.ensureTicker();
  }
  ensureTicker() {
    if (this.ticker || this.stopping || !this.running.size && !this.queueList.length) return;
    this.ticker = this.setTimer(() => this.tick(), Math.min(1000, Math.max(1, this.idleTimeoutMs)));
    this.ticker?.unref?.();
  }
  tick() {
    if (this.stopping) return;
    for (const run of [...this.running.values()]) {
      const builder = run.attempt.builder;
      if (!builder || builder.generation !== run.generation) continue;
      // A pause whose interrupt failed must not hang until the idle timeout:
      // every tick just retries the stop, without error or timeout fields.
      if (builder.status === 'pausing') { void run.session.interrupt().catch(() => {}); continue; }
      if (builder.status !== 'running') continue;
      if (this.clock() - (builder.lastMeaningfulAt ?? 0) <= this.idleTimeoutMs) continue;
      run.timeout = true;
      builder.error = `Нет подтверждённого прогресса сборки в течение ${this.idleTimeoutMs} ms`;
      try { this.queue.save(); } catch (error) { console.error(`Builder idle state (${run.jobId}): ${error.message}`); }
      void run.session.interrupt().catch(() => {});
    }
    this.pump();
    if (!this.running.size && !this.queueList.length && this.ticker) { this.clearTimer(this.ticker); this.ticker = null; }
  }
  startRun(entry) {
    if (this.stopping || this.queue.closing) return;
    const job = this.queue.jobs.find(item => item.id === entry.jobId);
    const attempt = job?.attempts.find(item => item.number === entry.attemptNumber);
    if (!job || !attempt) return;
    const builder = attempt.builder;
    if (job.attempts.at(-1) !== attempt) {
      // A newer attempt exists: this assembly belongs to a historical attempt
      // and must never start. Resolve it visibly instead of dangling queued.
      if (builder && !TERMINAL.has(builder.status)) {
        builder.status = 'skipped'; builder.error = 'Попытка больше не последняя'; builder.finishedAt = now();
        this.persist(job, attempt);
      } else if (builder?.retryAt !== undefined) {
        // A scheduled auto-retry of a superseded attempt must not outlive its
        // queue entry as dead state in state.json.
        delete builder.retryAt;
        this.persist(job, attempt);
      }
      return;
    }
    if (!builder || !['queued', 'failed'].includes(builder.status)) return;
    if (entry.retry) { builder.generation = (builder.generation || 0) + 1; delete builder.retryAt; builder.saveAttempts = 0; }
    builder.status = 'running'; builder.policy = BUILDER_POLICY;
    builder.startedAt = now(); delete builder.finishedAt; delete builder.error;
    builder.lastMeaningfulAt = this.clock(); builder.identity = {};
    this.persist(job, attempt);
    const run = { jobId: job.id, attemptNumber: attempt.number, generation: builder.generation, job, attempt,
      identity: {}, cache: new Map(), saveAccepted: false, cancelRequested: false, limitExceeded: false, finished: false };
    try {
      let stored = this.queue.pageBuilder.read(job.id, { attempt: attempt.number });
      const resume = builder.mode === 'resume' && !isPristine(stored.document);
      // Fresh runs (auto-retry, drift) rebuild from the default page: only a
      // resume keeps the document, so no assembled tab outlives its generation.
      if (!resume && !isPristine(stored.document)) stored = this.queue.pageBuilder.reset(job.id, attempt.number);
      builder.revision = stored.revision;
      const qa = loadQa(this.queue.root, job, attempt);
      if (!qa) throw new Error('Нет capture manifest для сборки страницы');
      checkManifest(this.queue.root, job, attempt, qa.manifest);
      const files = qa.manifest.files.map(file => ({ name: file.name, sha256: file.sha256, bytes: file.bytes }));
      const manifest = this.queue.stage.media.read(job, attempt, true);
      const manifestSha = manifest.source.sha256, htmlRevision = attempt.htmlMedia.revision;
      const catalogs = this.buildCatalogs(job, { revision: stored.revision, attempt: attempt.number, htmlRevision });
      const stagingDir = stageBuilder(this.queue.root, { hostDir: layout(this.queue.root, job, attempt).hostDir, files,
        htmlDir: this.queue.stage.media.directory(job, attempt), htmlSha256: manifestSha,
        catalogs: { 'block-catalog.json': { blocks: BLOCK_TYPES }, 'media-catalog.json': { images: catalogs.media },
          'frame-catalog.json': { frames: catalogs.frames }, 'document-catalog.json': { documents: catalogs.documents } } });
      Object.assign(run, { stagingDir, htmlEncoding: manifest.source.encoding || 'utf-8', manifestSha, htmlRevision, files, catalogs });
      const prompt = buildBuilderPrompt({ job, attempt, revision: stored.revision, htmlRevision, manifestSha, files,
        catalogCounts: { media: catalogs.media.length, frames: catalogs.frames.length, documents: catalogs.documents.length },
        resumeDocument: resume ? stored.document : null });
      const builderDir = path.join(this.queue.root, 'page-builder', job.id, 'builder');
      fs.mkdirSync(builderDir, { recursive: true });
      // Plain overwrite: a generation id may legitimately repeat when state was
      // restored from a backup, and an EEXIST crash would fail the run forever.
      fs.writeFileSync(path.join(builderDir, `run-${builder.generation}-prompt.txt`), prompt);
      run.logFile = path.join(builderDir, `run-${builder.generation}-log.txt`);
      fs.writeFileSync(run.logFile, '');
      const appServer = this.appServerFactory();
      const session = appServer.assemble({ generation: builder.generation, cwd: stagingDir, prompt, files,
        onIdentity: fields => {
          Object.assign(run.identity, fields);
          builder.identity = { ...(builder.identity || {}), ...fields };
          builder.lastMeaningfulAt = this.clock();
          this.persist(job, attempt);
        },
        onSave: (args, incoming) => this.onSave(run, args, incoming),
        onReadFile: (args, incoming) => this.onReadFile(run, args, incoming),
        onLog: text => {
          builder.lastMeaningfulAt = this.clock();
          try { fs.appendFileSync(run.logFile, text); } catch { /* the log is diagnostic */ }
        } });
      run.appServer = appServer; run.session = session;
      this.running.set(job.id, run);
      session.once('close', () => this.finishRun(run));
    } catch (error) {
      this.failRun(run, error);
    }
  }
  buildCatalogs(job, request) {
    const media = [];
    for (const image of this.queue.mediaPicker.catalog(job.id, request).images) {
      const chosen = this.queue.mediaPicker.choose(job.id, request, image.name, image.resourceId);
      media.push({ ref: String(image.resourceId), name: image.name, url: chosen.url, media: chosen.media });
    }
    const frames = this.queue.framePicker.catalog(job.id, request).frames.map(frame => {
      if (!frame.selectable) return { ref: String(frame.resourceId), ...frame };
      const chosen = this.queue.framePicker.choose(job.id, request, frame.resourceId);
      return { ref: String(frame.resourceId), ...frame, source_url: chosen.source_url, sourceFrame: chosen.sourceFrame, provider: 'iframe' };
    });
    const documents = [];
    for (const item of this.queue.documentPicker.catalog(job.id, request).documents) {
      const chosen = this.queue.documentPicker.choose(job.id, request, item.resourceId);
      documents.push({ ref: String(item.resourceId), name: chosen.name, mime: item.mime, bytes: item.bytes, fileType: item.fileType, link: chosen.link, sourceDocument: chosen.sourceDocument });
    }
    return { media, frames, documents };
  }
  relayGuard(run, incoming) {
    const builder = run.attempt.builder;
    if (this.running.get(run.jobId) !== run || run.session.exitCode !== null || run.job.attempts.at(-1) !== run.attempt
      || !builder || builder.generation !== run.generation || builder.status !== 'running' || run.cancelRequested
      || incoming.generation !== builder.generation || !run.identity.threadId || !run.identity.turnId
      || incoming.threadId !== run.identity.threadId || incoming.turnId !== run.identity.turnId) throw new Error('Stale builder session');
  }
  // Replace agent-facing refs (mediaRef/frameRef/documentRef) with the
  // catalog-backed URLs and provenance the store contract requires.
  expandReferences(run, document) {
    const mediaByRef = new Map(run.catalogs.media.map(entry => [entry.ref, entry]));
    const frameByRef = new Map(run.catalogs.frames.map(entry => [entry.ref, entry]));
    const documentByRef = new Map(run.catalogs.documents.map(entry => [entry.ref, entry]));
    for (const section of [document.common, ...document.tabs]) {
      for (const block of section.blocks) {
        for (const asset of block.media) {
          if (asset.mediaRef !== undefined) {
            const entry = mediaByRef.get(String(asset.mediaRef));
            if (!entry) throw new Error(`Неизвестный mediaRef: ${JSON.stringify(asset.mediaRef)}`);
            asset.originalUrl = entry.url; asset.originalMedia = structuredClone(entry.media);
            delete asset.mediaRef;
          }
          if (asset.bigMediaRef !== undefined) {
            const entry = mediaByRef.get(String(asset.bigMediaRef));
            if (!entry) throw new Error(`Неизвестный bigMediaRef: ${JSON.stringify(asset.bigMediaRef)}`);
            asset.bigUrl = entry.url; asset.bigMedia = structuredClone(entry.media);
            delete asset.bigMediaRef;
          }
        }
        if (block.frameRef !== undefined) {
          const entry = frameByRef.get(String(block.frameRef));
          if (!entry || entry.selectable !== true) throw new Error(`Фрейм недоступен для выбора: ${JSON.stringify(block.frameRef)}`);
          block.source_url = entry.source_url; block.sourceFrame = structuredClone(entry.sourceFrame);
          block.provider = entry.provider || 'iframe';
          delete block.frameRef;
        }
        for (const item of block.items || []) {
          if (item.documentRef === undefined) continue;
          const entry = documentByRef.get(String(item.documentRef));
          if (!entry) throw new Error(`Неизвестный documentRef: ${JSON.stringify(item.documentRef)}`);
          item.link = entry.link; item.sourceDocument = structuredClone(entry.sourceDocument);
          delete item.documentRef;
        }
      }
    }
    return document;
  }
  onSave(run, args, incoming) {
    this.relayGuard(run, incoming);
    const builder = run.attempt.builder;
    builder.lastMeaningfulAt = this.clock();
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['revision', 'document'].includes(key))) throw new Error('save_document требует ровно revision и document');
    if (Buffer.byteLength(JSON.stringify(args)) > SAVE_ARGUMENT_LIMIT) throw new Error(`Аргументы save_document превышают ${SAVE_ARGUMENT_LIMIT} байт`);
    // Лимит тратят только отклонённые сохранения: пошаговые снимки не должны
    // расходовать бюджет, отведённый на исправление ошибок.
    const reject = (message, extra) => {
      builder.saveAttempts = (builder.saveAttempts || 0) + 1;
      if (builder.saveAttempts > this.saveLimit) {
        run.limitExceeded = true;
        if (!run.saveAccepted) {
          this.finalizeTerminal(run.job, run.attempt, () => {
            builder.status = 'failed'; builder.error = 'Превышен лимит попыток сохранения';
            if ((builder.retries || 0) < this.retryLimit && !this.queue.closing) {
              builder.retries = (builder.retries || 0) + 1;
              builder.retryAt = this.clock() + this.retryDelayMs;
            }
          });
          if (builder.retryAt !== undefined) this.queueList.push({ jobId: run.jobId, attemptNumber: run.attemptNumber, readyAt: builder.retryAt, retry: true });
        } else this.persist(run.job, run.attempt);
        void run.session.interrupt().catch(() => {});
        return { error: 'Превышен лимит попыток сохранения' };
      }
      this.persist(run.job, run.attempt);
      return { error: message, ...extra };
    };
    if (!Number.isSafeInteger(args.revision) || args.revision < 1) return reject('Некорректная revision');
    try {
      const stored = this.queue.pageBuilder.read(run.job.id, { attempt: run.attemptNumber });
      if (stored.revision !== args.revision) return reject('Данные шага 3 уже изменены', { currentRevision: stored.revision });
      const expanded = this.expandReferences(run, structuredClone(args.document));
      // Attach source.html only to a pristine page; an existing binding is
      // preserved verbatim, whatever the agent submitted.
      const pristine = isPristine(stored.document);
      if (!pristine) expanded.source.htmlSha256 = stored.document.source.htmlSha256;
      const written = this.queue.pageBuilder.write(run.job.id, args.revision, expanded, run.attemptNumber, pristine ? { sourceBinding: run.manifestSha } : {});
      run.saveAccepted = true;
      builder.revision = written.revision;
      this.persist(run.job, run.attempt);
      return { accepted: true, revision: written.revision };
    } catch (error) {
      return reject(error.message);
    }
  }
  onReadFile(run, args, incoming) {
    this.relayGuard(run, incoming);
    run.attempt.builder.lastMeaningfulAt = this.clock();
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['name', 'offset', 'length'].includes(key))) throw new Error('read_file требует только name, offset и length');
    if (!READ_WHITELIST.has(args.name)) throw new Error(`Файл не входит в список разрешённых: ${JSON.stringify(args.name)}`);
    const offset = args.offset === undefined ? 0 : args.offset, length = args.length === undefined ? READ_FILE_PAGE : args.length;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > READ_FILE_MAX) throw new Error(`Некорректные offset/length read_file (за один вызов не более ${READ_FILE_MAX} символов)`);
    const text = this.stagedText(run, args.name);
    if (offset > text.length) throw new Error('offset за пределами файла');
    return { name: args.name, totalChars: text.length, offset, content: text.slice(offset, offset + length) };
  }
  stagedText(run, name) {
    if (run.cache.has(name)) return run.cache.get(name);
    const bytes = fs.readFileSync(safeFile(run.stagingDir, path.join(run.stagingDir, name)));
    let text;
    if (name === 'source.html') { try { text = new TextDecoder(run.htmlEncoding).decode(bytes); } catch { text = bytes.toString('utf8'); } }
    else text = bytes.toString('utf8');
    run.cache.set(name, text);
    return text;
  }
  failRun(run, error) {
    cleanupBuilder(run);
    const builder = run.attempt.builder;
    if (!builder || builder.generation !== run.generation || builder.status !== 'running') return;
    this.finalizeTerminal(run.job, run.attempt, () => {
      builder.status = 'failed'; builder.error = error.message;
      if ((builder.retries || 0) < this.retryLimit && !this.queue.closing) {
        builder.retries = (builder.retries || 0) + 1;
        builder.retryAt = this.clock() + this.retryDelayMs;
      }
    });
    // Очередь повтора пушится после финализатора: readyAt берётся из builder.retryAt.
    if (builder.retryAt !== undefined) this.queueList.push({ jobId: run.jobId, attemptNumber: run.attemptNumber, readyAt: builder.retryAt, retry: true });
  }
  finishRun(run) {
    if (run.finished) return;
    run.finished = true;
    this.running.delete(run.jobId);
    cleanupBuilder(run);
    const builder = run.attempt.builder;
    if (builder && builder.generation === run.generation) {
    if (builder.status === 'running' || builder.status === 'pausing') {
      // Естественное закрытие хода уже завершило работу: висящая пауза не
      // должна перекрашивать собранную до конца сборку в paused.
      if ((builder.pauseRequested || builder.status === 'pausing') && !(run.saveAccepted && run.session?.exitCode === 0)) {
        this.finalizeTerminal(run.job, run.attempt, () => { builder.status = 'paused'; delete builder.error; delete builder.pauseRequested; });
      } else if (run.saveAccepted) {
        this.finalizeTerminal(run.job, run.attempt, () => { builder.status = 'complete'; delete builder.error; delete builder.pauseRequested; });
      }
        else {
          this.finalizeTerminal(run.job, run.attempt, () => {
            builder.status = 'failed';
            builder.error ||= run.session?.failure?.message || 'Сессия сборщика закрыта без сохранения документа';
            if ((builder.retries || 0) < this.retryLimit && !this.queue.closing) {
              builder.retries = (builder.retries || 0) + 1;
              builder.retryAt = this.clock() + this.retryDelayMs;
            }
          });
          if (builder.retryAt !== undefined) this.queueList.push({ jobId: run.jobId, attemptNumber: run.attemptNumber, readyAt: builder.retryAt, retry: true });
        }
      } else {
        if (!builder.finishedAt) builder.finishedAt = now();
        this.persist(run.job, run.attempt);
      }
    }
    // running.delete above freed one pool slot; released() pumps BOTH queues
    // (assembly first, then the FIFO stage jobs) instead of only this one.
    this.slots.released();
  }
  // Терминальный вердикт сборки обязан доехать до state.json: при ошибке записи
  // память уже терминальна, помечается finalizationError и запись повторяется
  // перед каждым pump (модель finalizeQa).
  finalizeTerminal(job, attempt, apply) {
    const builder = attempt.builder, key = `builder:${job.id}`;
    apply();
    if (!builder.finishedAt) builder.finishedAt = now();
    const finalize = () => {
      try {
        delete builder.finalizationError;
        this.queue.save();
      } catch (error) {
        builder.finalizationError = { message: error.message };
        console.error(`Builder finalization (${job.id}) не сохранена; запись будет повторена: ${error.message}`);
        try { this.queue.save(); } catch { /* повторит recovery-pump */ }
        this.queue.pendingFinalizations.set(key, finalize);
        return false;
      }
      this.queue.pendingFinalizations.delete(key);
      this.queue.emit('builder', { jobId: job.id, attempt: attempt.number, status: builder.status });
      return true;
    };
    finalize();
  }
  persist(job, attempt) {
    try { this.queue.save(); } catch (error) { console.error(`Builder state save (${job.id}): ${error.message}`); }
    this.queue.emit('builder', { jobId: job.id, attempt: attempt.number, status: attempt.builder?.status });
  }
  async shutdown() {
    this.stopping = true;
    if (this.ticker) { this.clearTimer(this.ticker); this.ticker = null; }
    // Statuses stay as recorded; close handlers may still finalize naturally,
    // and the next start's restore reconciles anything left running.
    await Promise.allSettled([...this.running.values()].map(run => run.appServer?.shutdown?.()));
  }
}
module.exports = { BuilderRunner, BUILDER_PROFILE, BUILDER_BRIDGE };
