'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { atomicJson } = require('../../infrastructure/files.cjs');
const domains = require('../../resources/domains.json');
const { loadConfig } = require('./config.cjs');
const { createSshTransport } = require('./ssh.cjs');
const { readChecked, checkedPath } = require('../../infrastructure/media.cjs');
const { computeSorts, sectionKey } = require('./sorts.cjs');
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
function destinationIdentity(config) {
  if (!config) return null;
  return digest({ host: config.host.toLowerCase().replace(/\.$/, ''), user: config.user, port: config.port ?? 22,
    remoteScript: config.remoteScript, phpBinary: config.phpBinary ?? 'php7.4' });
}
const withoutReview = value => Array.isArray(value) ? value.map(withoutReview) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['review', 'reviewedRevision'].includes(key)).map(([key, item]) => [key, withoutReview(item)])) : value;
function hostname(value) { return new URL(String(value).includes('://') ? value : `https://${value}`).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, ''); }
function legacyId(value, mapping = domains) {
  const host = hostname(value), matches = Object.entries(mapping).filter(([, domain]) => hostname(domain) === host);
  if (matches.length !== 1 || !/^[1-9]\d*$/.test(matches[0][0])) throw new Error(`Для ${host} требуется единственное соответствие старому ID компании`);
  const id = Number(matches[0][0]); if (!Number.isSafeInteger(id)) throw new Error('Старый ID компании некорректен'); return id;
}
// The desired hash follows the sticky sort, not the list index: untouched
// objects keep their hash through any move of their neighbours. Without sorts
// (an external call or a journal from before sticky sorts) the computation
// degrades to the fixed migration order (index + 1) * 10.
function desired(document, sorts) {
  const sticky = sorts || computeSorts(null, document);
  const tabs = {}, blocks = {};
  document.tabs.forEach(tab => { tabs[tab.id] = digest({ title: tab.title, sort: sticky.tabs[tab.id] }); });
  [document.common, ...document.tabs].forEach(section => {
    const key = sectionKey(document, section);
    section.blocks.forEach(block => {
      blocks[block.id] = digest({ section: section === document.common ? null : section.id, sort: sticky.sections[key][block.id], block: withoutReview(block) });
    });
  });
  return { hash: digest({ tabs, blocks }), tabs, blocks };
}
function snapshotAssets(snapshot) {
  const media = {}, files = {};
  for (const asset of snapshot.media || []) {
    media[asset.local_id] = {};
    for (const kind of ['original', 'big']) if (asset[kind]?.sha256) media[asset.local_id][kind] = asset[kind].sha256;
  }
  for (const file of snapshot.files || []) files[file.local_id] = file.sha256;
  return { media, files };
}
class BegetSync {
  constructor(queue, options = {}) {
    this.queue = queue; this.root = path.join(queue.root, 'beget-sync'); this.records = new Map();
    let configuration = null, configurationError = '';
    try { configuration = loadConfig(queue.root); } catch (error) { configurationError = error.message; }
    this.destination = destinationIdentity(options.destination || configuration);
    this.transport = options.transport || (configuration ? createSshTransport(configuration, { spawnFn: options.sshSpawn }) : null);
    this.serialize = options.serialize;
    this.clock = options.clock || Date.now; this.intervalMs = options.intervalMs || 3000;
    this.timeoutMs = options.timeoutMs || 30000; this.closed = false; this.running = null;
    this.connection = this.transport ? 'connecting' : 'unconfigured'; this.lastError = configurationError;
    if (options.autoStart !== false) { this.timer = setInterval(() => { this.backgroundTick(); }, this.intervalMs); this.timer.unref(); }
  }
  key(jobId, attempt) {
    const job = this.queue.get(jobId); attempt ??= job.attempts.at(-1)?.number;
    if (!/^[a-f0-9-]{36}$/.test(jobId) || !Number.isSafeInteger(attempt) || attempt < 1 || !job.attempts.some(item => item.number === attempt)) throw conflict('Попытка синхронизации Beget не найдена');
    return jobId;
  }
  file(jobId) { return path.join(this.root, jobId, 'state.json'); }
  persist(record) {
    const file = this.file(record.jobId, record.attempt); fs.mkdirSync(path.dirname(file), { recursive: true }); atomicJson(file, record);
  }
  destinationError(record) {
    if (record.destination !== undefined && record.destination !== null) {
      if (record.destination !== this.destination) return 'Назначение SSH Beget изменилось. Отправка заблокирована: восстановите прежнюю настройку или используйте отдельный каталог данных АРМа.';
    } else if (record.company || record.acknowledged || record.inFlight) {
      return 'Журнал Beget не содержит привязки к SSH-назначению. Отправка заблокирована; требуется сверка первоначального назначения.';
    }
    return '';
  }
  assertDestination(record) {
    const message = this.destinationError(record) || (!this.destination ? 'SSH-назначение Beget не настроено' : '');
    if (message) throw Object.assign(new Error(message), { code: 'BEGET_DESTINATION', transportKind: 'configuration' });
    if (!record.destination) {
      // Bind durably before even lookup: its numeric company ID also belongs
      // to one specific server. Never infer ownership of an older journal.
      record.destination = this.destination; this.persist(record);
    }
  }
  destinationFailure() {
    for (const job of this.queue.jobs) {
      const message = this.destinationError(this.record(job.id, job.attempts.at(-1).number));
      if (message) return message;
    }
    return '';
  }
  spool(record, snapshot) {
    const directory = path.join(this.root, record.jobId, 'blobs');
    fs.mkdirSync(directory, { recursive: true }); checkedPath(this.queue.root, directory);
    const uploads = new Map();
    const freeze = (asset, imageOnly) => {
      if (!asset || typeof asset.base64 !== 'string') return;
      const bytes = Buffer.from(asset.base64, 'base64'), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (!bytes.length || sha256 !== asset.sha256) throw new Error('Содержимое отправляемого файла не соответствует SHA256');
      const file = path.join(directory, sha256);
      if (fs.existsSync(file)) {
        if (!readChecked(this.queue.root, file, 256 * 1024 * 1024).equals(bytes)) throw new Error('Локальная копия отправляемого файла повреждена');
      } else {
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, file); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      const key = `${sha256}:${asset.name}:${imageOnly}`;
      uploads.set(key, { sha256, name: asset.name, size: bytes.length, image_only: imageOnly });
      delete asset.base64;
    };
    for (const media of snapshot.media || []) for (const kind of ['original', 'big']) freeze(media[kind], true);
    for (const file of snapshot.files || []) freeze(file, false);
    return [...uploads.values()];
  }
  cleanupBlobs(record) {
    if (record.inFlight) return;
    const directory = path.join(this.root, record.jobId, 'blobs'); if (!fs.existsSync(directory)) return;
    checkedPath(this.queue.root, directory);
    for (const name of fs.readdirSync(directory)) if (/^[a-f0-9]{64}$/.test(name)) {
      const file = path.join(directory, name); checkedPath(this.queue.root, file); fs.unlinkSync(file);
    }
  }
  mayBeChangedByFlight(record, kind, id) {
    if (!record.inFlight?.applyStarted) return false;
    return record.inFlight.target?.[kind]?.[id] !== record.acknowledged?.[kind]?.[id];
  }
  companyId(jobId, attempt) {
    const record = this.record(jobId, attempt);
    return this.destinationError(record) ? null : record.company?.id || null;
  }
  projection(jobId, attempt, document) {
    const record = this.record(jobId, attempt);
    const target = desired(document, computeSorts(record.sorts || null, document));
    const destinationError = this.destinationError(record);
    const currentAttempt = this.queue.get(jobId).attempts.at(-1).number;
    const acknowledged = !destinationError && record.acknowledged?.attempt === attempt && currentAttempt === attempt ? record.acknowledged : null;
    const result = { connection: destinationError ? 'error' : this.connection, lastError: destinationError || record.lastError || this.lastError, pendingCount: 0, companyId: this.companyId(jobId, attempt), tabs: {}, blocks: {} };
    for (const kind of ['tabs', 'blocks']) {
      for (const [id, hash] of Object.entries(target[kind])) {
        const confirmed = acknowledged?.[kind]?.[id] === hash && !this.mayBeChangedByFlight(record, kind, id);
        result[kind][id] = { status: confirmed ? 'synced' : 'pending', bitrixId: acknowledged?.bindings?.[kind]?.[id] || null };
        if (!confirmed) result.pendingCount++;
      }
      for (const id of Object.keys(acknowledged?.[kind] || {})) if (!Object.hasOwn(target[kind], id)) result.pendingCount++;
    }
    result.version = digest({ target: target.hash, ack: acknowledged?.hash, inFlight: record.inFlight?.operationId, error: result.lastError, connection: result.connection });
    return result;
  }
  enforceReview(jobId, attempt, current, next) {
    const record = this.record(jobId, attempt);
    // Both snapshots derive from the same stored sorts: a hash changes only for
    // objects that really moved (or changed), never for the blocks that merely
    // shifted positions between the old and the new index of a neighbour.
    const before = desired(current, computeSorts(record.sorts || null, current));
    const after = desired(next, computeSorts(record.sorts || null, next));
    const ack = !this.destinationError(record) && record.acknowledged?.attempt === attempt && this.queue.get(jobId).attempts.at(-1).number === attempt ? record.acknowledged : null;
    const previous = new Map([current.common, ...current.tabs].flatMap(section => section.blocks.map(block => [block.id, block])));
    for (const section of [next.common, ...next.tabs]) for (const block of section.blocks) {
      const old = previous.get(block.id), changed = before.blocks[block.id] !== after.blocks[block.id];
      if (changed) { block.review = { status: 'unreviewed', reason: '' }; continue; }
      const confirmed = ack?.blocks?.[block.id] === after.blocks[block.id] && !this.mayBeChangedByFlight(record, 'blocks', block.id);
      if (JSON.stringify(old?.review) !== JSON.stringify(block.review) && !confirmed) throw conflict('Сначала дождитесь отправки текущей версии блока в Beget');
      if (!confirmed) block.review = { status: 'unreviewed', reason: '' };
    }
  }
  snapshot() {
    let pendingCount = 0;
    if (typeof this.queue.pageBuilder?.read === 'function') for (const job of this.queue.jobs) for (const attempt of [job.attempts.at(-1)]) {
      try { const page = this.queue.pageBuilder.read(job.id, { attempt: attempt.number, create: false }); if (page) pendingCount += page.sync?.pendingCount || 0; }
      catch (error) { this.lastError = error.message; }
    }
    const destinationError = this.destinationFailure();
    return { connection: destinationError ? 'error' : this.connection, pendingCount, lastError: destinationError || this.lastError };
  }
  backgroundTick() { void this.tick().catch(error => { this.lastError = error.message; this.connection = 'error'; }); }
  wake() { if (!this.closed && !this.wakeTimer) { this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.backgroundTick(); }, 100); this.wakeTimer.unref(); } }
  async request(action, data = {}, record = null) {
    if (record) this.assertDestination(record);
    this.lastContactAt = this.clock();
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await this.transport({ action, ...data }, { signal: controller.signal });
      if (record) this.assertDestination(record);
      this.connection = 'online'; this.lastError = '';
      if (result.ok !== true) throw Object.assign(new Error(typeof result.error === 'string' ? result.error.slice(0, 500) : result.error?.message || 'Ошибка Beget'), { remote: true, remoteCode: result.error?.code, retryable: result.error?.retryable !== false });
      return result;
    } catch (error) {
      if (!error.remote) {
        this.connection = ['authorization', 'configuration'].includes(error.transportKind) ? 'error' : 'offline';
        this.lastError = error.transportKind ? error.message : 'Нет связи с Beget';
      }
      throw error;
    } finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; }
  }
  async tick() {
    if (this.running) return this.running;
    if (this.closed || !this.transport) return;
    this.running = this.drain();
    try { await this.running; } finally { this.running = null; }
  }
  acknowledge(record, result) {
    this.assertDestination(record);
    const flight = record.inFlight;
    if (!flight || result.operation_id !== flight.operationId || result.epoch !== flight.attempt || result.revision !== flight.baseRevision + 1 || !/^[a-f0-9]{64}$/.test(result.fingerprint || '') || !result.bindings) throw new Error('Подтверждение Beget не соответствует отправленной операции');
    for (const kind of ['tabs', 'blocks']) for (const id of Object.keys(flight.target[kind])) if (!Number.isSafeInteger(result.bindings[kind]?.[id]) || result.bindings[kind][id] < 1) throw new Error('Beget не подтвердил ID всех объектов');
    record.acknowledged = { ...flight.target, attempt: flight.attempt, revision: result.revision, fingerprint: result.fingerprint, bindings: result.bindings, documentRevision: flight.documentRevision,
      assets: snapshotAssets(flight.snapshot) };
    record.inFlight = null; record.lastError = ''; record.failures = 0; record.nextAt = 0; delete record.blockedHash; this.persist(record); this.cleanupBlobs(record);
  }
  async shutdown() { this.closed = true; clearInterval(this.timer); clearTimeout(this.wakeTimer); this.controller?.abort(); await this.running; }
}
module.exports = { BegetSync: require('./object-queue.cjs')(BegetSync, { desired, digest, legacyId, snapshotAssets, withoutReview }), legacyId, hostname, desired, withoutReview, destinationIdentity };
