'use strict';
const path = require('node:path'), crypto = require('node:crypto');
const { verifiedRasterMime, extensions, mediaMime, detectLegacyImages, checkedPath, readChecked, filename, provenance } = require('../../infrastructure/media.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
class MediaPicker {
  constructor(queue) { this.queue = queue; this.tokens = new Map(); }
  context(jobId, revision, attemptNumber) {
    const job = this.queue.get(jobId), attempt = job.attempts.find(item => item.number === attemptNumber);
    if (!attempt) throw conflict('Попытка шага 3 не найдена');
    if (this.queue.pageBuilder.read(jobId, { attempt: attemptNumber }).revision !== revision) throw conflict('Данные шага 3 изменились; откройте редактор снова');
    if (!attempt?.htmlMedia?.revision) throw new Error('В текущей попытке ещё нет медиа шага 2');
    return { job, attempt, revision: attempt.htmlMedia.revision };
  }
  verifyItem(dir, item) {
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.object !== `objects/${item.sha256}`) throw new Error('Изображение не входит в manifest шага 2');
    const bytes = readChecked(this.queue.root, path.join(dir, item.object), this.queue.stage.media.limits.maxFileBytes);
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256 || !verifiedRasterMime(item, bytes)) throw new Error('Изображение изменено или не соответствует SHA/MIME');
    return { bytes, mime: mediaMime(item), url: item.resolvedUrl || item.originalUrl, dir };
  }
  resolve(jobId, ref, url) {
    provenance(ref);
    const job = this.queue.get(jobId), attempt = job.attempts.find(item => item.number === ref.attempt);
    if (!attempt) throw new Error('Попытка медиа не найдена');
    const dir = this.queue.stage.media.directory(job, attempt, ref.revision);
    const manifest = JSON.parse(readChecked(this.queue.root, path.join(dir, 'manifest.json'), 24 * 1024 * 1024));
    if (manifest.jobId !== job.id || manifest.attempt !== ref.attempt || manifest.revision !== ref.revision) throw new Error('Происхождение manifest изменено');
    const item = this.item({ dir, manifest }, ref.filename, ref.sha256, url, ref.resourceId);
    return this.verifyItem(dir, item);
  }
  selectionContext(jobId, request) {
    if (this.queue.closing) throw conflict('Приложение завершает работу; выбор изображения недоступен');
    if (!request || Object.keys(request).sort().join(',') !== 'attempt,htmlRevision,revision' || !Object.values(request).every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Разрешены только revision, attempt и htmlRevision');
    const context = this.context(jobId, request.revision, request.attempt);
    if (context.attempt.number !== request.attempt || context.revision !== request.htmlRevision) throw conflict('Попытка или HTML шага 2 изменились; откройте редактор снова');
    const { job, attempt, revision } = context, dir = this.queue.stage.media.directory(job, attempt);
    const manifestBytes = readChecked(this.queue.root, path.join(dir, 'manifest.json'), 24 * 1024 * 1024);
    const manifest = JSON.parse(manifestBytes);
    if (manifest.jobId !== job.id || manifest.attempt !== attempt.number || manifest.revision !== revision) throw conflict('Медиа шага 2 изменились; откройте редактор снова');
    return { job, attempt, revision, dir, manifest, manifestHash: hash(manifestBytes) };
  }
  assertCurrent(jobId, request, selected) {
    const current = this.context(jobId, request.revision, request.attempt);
    if (current.attempt.number !== selected.attempt.number || current.revision !== selected.revision || hash(readChecked(this.queue.root, path.join(selected.dir, 'manifest.json'), 24 * 1024 * 1024)) !== selected.manifestHash) throw conflict('Медиа шага 2 изменились; откройте редактор снова');
  }
  item(selected, name, sha256, url, resourceId) {
    if (typeof name !== 'string' || !/^[\p{L}\p{N}_-]+\.(png|jpg|gif|webp|avif|bmp)$/u.test(name) || name.length > 100) throw new Error('Файл не входит в список изображений шага 2');
    if (resourceId !== undefined && resourceId !== null && (!Number.isSafeInteger(resourceId) || resourceId < 1)) throw new Error('Некорректный resourceId изображения');
    const suffix = name.split('.').at(-1), requestedMime = Object.keys(extensions).find(mime => extensions[mime] === suffix);
    for (const item of selected.manifest.resources) {
      if (item.status !== 'downloaded' || !/^[a-f0-9]{64}$/.test(item.sha256) || item.object !== `objects/${item.sha256}` || (sha256 && item.sha256 !== sha256) || (resourceId != null && item.id !== resourceId)) continue;
      const legacy = item.mime === 'application/octet-stream' && item.detectedMime === undefined;
      const candidate = legacy ? { ...item, detectedMime: requestedMime } : item;
      if (!extensions[mediaMime(candidate)] || filename(candidate) !== name) continue;
      if (legacy) detectLegacyImages(this.queue.root, selected.dir, [item], this.queue.stage.media.limits.maxFileBytes);
      if (!extensions[mediaMime(item)] || filename(item) !== name || (url && ![item.originalUrl, item.resolvedUrl, item.finalUrl].includes(url))) continue;
      return item;
    }
    throw new Error('Файл не входит в список изображений шага 2');
  }
  catalog(jobId, request) {
    const selected = this.selectionContext(jobId, request), images = [];
    detectLegacyImages(this.queue.root, selected.dir, selected.manifest.resources, this.queue.stage.media.limits.maxFileBytes);
    for (const item of selected.manifest.resources) {
      if (item.status !== 'downloaded' || !extensions[mediaMime(item)]) continue;
      const name = filename(item);
      this.verifyItem(selected.dir, item);
      images.push({ resourceId: item.id, name, preview: `/api/page-builder/${jobId}/catalog/${encodeURIComponent(name)}?revision=${request.revision}&attempt=${request.attempt}&htmlRevision=${request.htmlRevision}&resourceId=${item.id}` });
    }
    this.assertCurrent(jobId, request, selected);
    return { images };
  }
  catalogImage(jobId, request, name, resourceId) {
    const selected = this.selectionContext(jobId, request), item = this.item(selected, name, undefined, undefined, resourceId);
    const image = this.verifyItem(selected.dir, item);
    this.assertCurrent(jobId, request, selected);
    return image;
  }
  choose(jobId, request, name, resourceId) {
    const selected = this.selectionContext(jobId, request), item = this.item(selected, name, undefined, undefined, resourceId);
    const ref = { attempt: selected.attempt.number, revision: selected.revision, resourceId: item.id, sha256: item.sha256, filename: name };
    const verified = this.verifyItem(selected.dir, item);
    this.assertCurrent(jobId, request, selected);
    const token = crypto.randomBytes(32).toString('hex');
    for (const [key, value] of this.tokens) if (value.expires < Date.now()) this.tokens.delete(key);
    while (this.tokens.size >= 100) this.tokens.delete(this.tokens.keys().next().value);
    this.tokens.set(token, { jobId, ref, revision: request.revision, expires: Date.now() + 60 * 60 * 1000 });
    return { media: ref, url: verified.url, preview: `/api/page-builder/${jobId}/selection/${token}` };
  }
  async shutdown() { this.tokens.clear(); }
  preview(jobId, token) {
    const entry = this.tokens.get(token);
    if (!entry || entry.jobId !== jobId || entry.expires < Date.now()) throw new Error('Предпросмотр устарел; выберите изображение снова');
    const current = this.context(jobId, entry.revision, entry.ref.attempt);
    if (current.attempt.number !== entry.ref.attempt || current.revision !== entry.ref.revision) throw conflict('Медиа шага 2 изменились');
    return this.resolve(jobId, entry.ref);
  }
  validateDocument(jobId, document, previous, attemptNumber) {
    const old = new Set([previous.common, ...previous.tabs].flatMap(section => section.blocks.flatMap(block => block.media.flatMap(asset => ['original', 'big'].filter(kind => asset[`${kind}Media`]).map(kind => JSON.stringify([asset[`${kind}Media`], asset[`${kind}Url`]]))))));
    for (const section of [document.common, ...document.tabs]) for (const block of section.blocks) for (const asset of block.media) for (const kind of ['original', 'big']) {
      const ref = asset[`${kind}Media`]; if (!ref) continue;
      this.resolve(jobId, ref, asset[`${kind}Url`]);
      if (!old.has(JSON.stringify([ref, asset[`${kind}Url`]]))) {
        const attempt = this.queue.get(jobId).attempts.find(item => item.number === attemptNumber);
        if (attempt.number !== ref.attempt || attempt.htmlMedia?.revision !== ref.revision) throw conflict('Выбранное изображение относится к устаревшей попытке или HTML');
      }
    }
  }
}
module.exports = { MediaPicker, provenance, checkedPath, filename, extensions };
