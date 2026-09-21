'use strict';
const path = require('node:path'), crypto = require('node:crypto');
const { readChecked, validateContent, detectRasterMime, extensions, mediaMime } = require('../../infrastructure/media.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
const suffixes = {
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/rtf': 'rtf', 'text/rtf': 'rtf',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/gzip': 'gz', 'application/x-gzip': 'gz',
  'application/vnd.rar': 'rar', 'application/x-rar-compressed': 'rar', 'application/x-7z-compressed': '7z', 'application/x-tar': 'tar',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/vnd.wave': 'wav', 'audio/ogg': 'ogg', 'application/ogg': 'ogg',
  'video/ogg': 'ogg', 'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'video/webm': 'webm', 'audio/webm': 'webm', 'video/quicktime': 'mov',
  'image/svg+xml': 'svg', 'image/tiff': 'tiff', 'image/vnd.microsoft.icon': 'ico', 'image/x-icon': 'ico'
};
function safeName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name && Buffer.byteLength(name, 'utf8') <= 240 && !/[\p{Cc}\p{Cf}\p{Cs}<>:"/\\|?*]/u.test(value)
    && !/^\.|[. ]$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ? name : '';
}
function documentName(item) {
  const supplied = safeName(item.occurrence?.downloadFilename); if (supplied) return supplied;
  for (const address of [item.resolvedUrl, item.originalUrl]) {
    try { const name = safeName(decodeURIComponent(new URL(address).pathname.split('/').at(-1))); if (name) return name; } catch {}
  }
  return `Файл${suffixes[mediaMime(item)] ? '.' + suffixes[mediaMime(item)] : ''}`;
}
function provenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'attempt,resourceId,revision,sha256'
    || !['attempt', 'revision', 'resourceId'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0)
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('Некорректное происхождение документа');
  return { attempt: value.attempt, revision: value.revision, resourceId: value.resourceId, sha256: value.sha256 };
}
class DocumentPicker {
  constructor(queue) { this.queue = queue; }
  snapshot(jobId, attemptNumber, revision) {
    const job = this.queue.get(jobId), attempt = job.attempts.find(item => item.number === attemptNumber);
    if (!attempt) throw conflict('Попытка документа не найдена');
    const dir = this.queue.stage.media.directory(job, attempt, revision);
    const manifestBytes = readChecked(this.queue.root, path.join(dir, 'manifest.json'), 24 * 1024 * 1024), manifest = JSON.parse(manifestBytes);
    if (manifest.jobId !== jobId || manifest.attempt !== attemptNumber || manifest.revision !== revision || !Array.isArray(manifest.resources)) throw new Error('Происхождение manifest документов изменено');
    const ids = new Set();
    for (const item of manifest.resources) {
      if (!Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id)) throw new Error('Некорректный resourceId в manifest документов');
      ids.add(item.id);
    }
    return { job, attempt, dir, manifest, manifestHash: hash(manifestBytes) };
  }
  context(jobId, request) {
    if (this.queue.closing) throw conflict('Приложение завершает работу; выбор документа недоступен');
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).sort().join(',') !== 'attempt,htmlRevision,revision'
      || !Object.values(request).every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Разрешены только revision, attempt и htmlRevision');
    const job = this.queue.get(jobId), attempt = job.attempts.find(item => item.number === request.attempt);
    if (!attempt || attempt.htmlMedia?.revision !== request.htmlRevision || this.queue.pageBuilder.read(jobId, { attempt: request.attempt, create: false })?.revision !== request.revision) throw conflict('Попытка, HTML или документ изменились; откройте редактор снова');
    return this.snapshot(jobId, request.attempt, request.htmlRevision);
  }
  assertCurrent(jobId, request, selected) {
    const attempt = this.queue.get(jobId).attempts.find(item => item.number === request.attempt);
    if (attempt?.htmlMedia?.revision !== request.htmlRevision || this.queue.pageBuilder.read(jobId, { attempt: request.attempt, create: false })?.revision !== request.revision
      || hash(readChecked(this.queue.root, path.join(selected.dir, 'manifest.json'), 24 * 1024 * 1024)) !== selected.manifestHash) throw conflict('Медиа шага 2 изменились; откройте редактор снова');
  }
  verify(selected, item) {
    if (!item || item.status !== 'downloaded' || !/^[a-f0-9]{64}$/.test(item.sha256) || item.object !== `objects/${item.sha256}`) throw new Error('Документ не входит в manifest шага 2');
    const bytes = readChecked(this.queue.root, path.join(selected.dir, item.object), this.queue.stage.media.limits.maxFileBytes), header = bytes.subarray(0, 4096);
    if (!bytes.length || bytes.length !== item.bytes || hash(bytes) !== item.sha256 || !validateContent(item.mime, header) || !validateContent(mediaMime(item), header)) throw new Error('Документ изменён или не соответствует SHA/размеру/MIME');
    if (extensions[mediaMime(item)] || detectRasterMime(header)) return null;
    let link;
    if (item.manual) {
      link = `/api/html-media/${selected.job.id}/${selected.attempt.number}/${selected.manifest.revision}/${item.object}?resourceId=${item.id}`;
      if (item.resolvedUrl !== link || item.originalUrl !== link || item.occurrence?.tag !== 'manual-upload') throw new Error('Некорректный локальный URL документа');
    } else {
      try { link = new URL(item.resolvedUrl || item.originalUrl); } catch { throw new Error('Некорректный URL документа в manifest'); }
      if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password) throw new Error('Некорректный URL документа в manifest');
      link = link.href;
    }
    const name = documentName(item), mime = mediaMime(item), fileType = (suffixes[mime] || name.match(/\.([a-z0-9]{1,10})$/i)?.[1] || '').toUpperCase();
    return { resourceId: item.id, name, mime, bytes: bytes.length, fileType, link,
      preview: `/api/html-media/${selected.job.id}/${selected.attempt.number}/${selected.manifest.revision}/${item.object}?resourceId=${item.id}` };
  }
  catalog(jobId, request) {
    const selected = this.context(jobId, request), documents = [];
    for (const item of selected.manifest.resources) {
      if (item.status !== 'downloaded' || extensions[mediaMime(item)]) continue;
      const descriptor = this.verify(selected, item); if (descriptor) documents.push(descriptor);
    }
    this.assertCurrent(jobId, request, selected); return { documents };
  }
  choose(jobId, request, resourceId) {
    if (!Number.isSafeInteger(resourceId) || resourceId < 1) throw new Error('Некорректный resourceId документа');
    const selected = this.context(jobId, request), item = selected.manifest.resources.find(resource => resource.id === resourceId);
    const descriptor = this.verify(selected, item); if (!descriptor) throw new Error('Изображение не входит в список документов');
    this.assertCurrent(jobId, request, selected);
    const { name, bytes, fileType, link, preview } = descriptor;
    return { name, bytes, fileType, link, preview, sourceDocument: { attempt: request.attempt, revision: request.htmlRevision, resourceId, sha256: item.sha256 } };
  }
  resolve(jobId, ref, link, attemptNumber, snapshot) {
    provenance(ref);
    if (ref.attempt !== attemptNumber) throw conflict('Документ относится к другой попытке');
    const selected = snapshot || this.snapshot(jobId, ref.attempt, ref.revision), item = selected.manifest.resources.find(resource => resource.id === ref.resourceId);
    if (!item || item.sha256 !== ref.sha256) throw new Error('Происхождение документа не соответствует manifest');
    const descriptor = this.verify(selected, item);
    if (!descriptor || descriptor.link !== link) throw new Error('URL документа не соответствует manifest');
    return descriptor;
  }
  validateDocument(jobId, document, previous, attemptNumber) {
    const oldBlocks = new Map([previous.common, ...previous.tabs].flatMap(section => section.blocks.map(block => [block.id, block])));
    let selected;
    for (const block of [document.common, ...document.tabs].flatMap(section => section.blocks)) {
      if (block.type !== 'links') continue;
      const oldBlock = oldBlocks.get(block.id), old = new Map((oldBlock?.type === 'links' ? oldBlock.items : []).map(item => [item.id, item]));
      for (const item of block.items) {
        if (item.meta.file_id !== undefined && item.meta.file_id !== old.get(item.id)?.meta.file_id) throw new Error('ID файла Bitrix разрешён только для сохранения прежних данных');
        // An unchanged historical item remains editable with the rest of its page,
        // even after source files or HTML revisions are retired.
        if (oldBlock?.view === block.view && JSON.stringify(old.get(item.id)) === JSON.stringify(item)) continue;
        if (!item.sourceDocument && (!item.link && !item.meta.file_id || block.view !== 'documents' && item.meta.kind !== 'document')) continue;
        if (!item.sourceDocument) throw new Error('Выберите документ из файлов шага 2');
        const attempt = this.queue.get(jobId).attempts.find(entry => entry.number === attemptNumber);
        if (item.sourceDocument.attempt !== attemptNumber || item.sourceDocument.revision !== attempt?.htmlMedia?.revision) throw conflict('Выбранный документ относится к устаревшей попытке или HTML');
        selected ||= this.snapshot(jobId, attemptNumber, item.sourceDocument.revision);
        this.resolve(jobId, item.sourceDocument, item.link, attemptNumber, selected);
      }
    }
    if (selected && hash(readChecked(this.queue.root, path.join(selected.dir, 'manifest.json'), 24 * 1024 * 1024)) !== selected.manifestHash) throw conflict('Manifest документов изменился при сохранении');
  }
}
module.exports = { DocumentPicker, provenance };
