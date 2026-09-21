'use strict';
const path = require('node:path'), crypto = require('node:crypto');
const { readChecked } = require('../../infrastructure/media.cjs');
const { inspectSource, inspect } = require('../../../public/embed-policy.js');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
function provenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'attempt,resourceId,revision,sourceSha256'
    || !['attempt', 'revision', 'resourceId'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0) || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) throw new Error('Некорректное происхождение фрейма');
  return { attempt: value.attempt, revision: value.revision, resourceId: value.resourceId, sourceSha256: value.sourceSha256 };
}
class FramePicker {
  constructor(queue) { this.queue = queue; }
  snapshot(jobId, attemptNumber, revision) {
    const job = this.queue.get(jobId), attempt = job.attempts.find(item => item.number === attemptNumber);
    if (!attempt) throw conflict('Попытка фрейма не найдена');
    const dir = this.queue.stage.media.directory(job, attempt, revision);
    const bytes = readChecked(this.queue.root, path.join(dir, 'manifest.json'), 24 * 1024 * 1024), manifest = JSON.parse(bytes);
    if (manifest.jobId !== jobId || manifest.attempt !== attemptNumber || manifest.revision !== revision) throw new Error('Происхождение manifest фреймов изменено');
    const source = readChecked(this.queue.root, path.join(dir, 'source.html'), this.queue.stage.media.limits.maxHtmlBytes);
    if (source.length !== manifest.source.bytes || hash(source) !== manifest.source.sha256) throw new Error('Исходный HTML фреймов не соответствует SHA256');
    return { job, attempt, dir, manifest };
  }
  context(jobId, request) {
    if (this.queue.closing) throw conflict('Приложение завершает работу; выбор фрейма недоступен');
    if (!request || Object.keys(request).sort().join(',') !== 'attempt,htmlRevision,revision' || !Object.values(request).every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Разрешены только revision, attempt и htmlRevision');
    const job = this.queue.get(jobId), attempt = job.attempts.find(item => item.number === request.attempt);
    if (!attempt || attempt.htmlMedia?.revision !== request.htmlRevision || this.queue.pageBuilder.read(jobId, { attempt: request.attempt }).revision !== request.revision) throw conflict('Попытка, HTML или документ изменились; откройте редактор снова');
    return this.snapshot(jobId, request.attempt, request.htmlRevision);
  }
  descriptor(item) {
    const source = inspectSource(item.resolvedUrl);
    const selectable = item.status === 'external' && item.occurrence?.tag === 'iframe' && item.occurrence.attribute === 'src' && source.allowed;
    return { resourceId: item.id, originalUrl: item.originalUrl, status: item.status, selectable,
      ...(selectable ? { resolvedUrl: source.url, ...(inspect(source.url).allowed ? {} : { reason: inspect(source.url).reason }) } : { reason: item.error || source.reason || 'Статическая обработка фрейма не поддерживается' }) };
  }
  catalog(jobId, request) {
    const selected = this.context(jobId, request);
    return { frames: selected.manifest.resources.filter(item => item.status !== 'deleted' && item.occurrence?.tag === 'iframe').map(item => this.descriptor(item)) };
  }
  choose(jobId, request, resourceId) {
    if (!Number.isSafeInteger(resourceId) || resourceId < 1) throw new Error('Некорректный resourceId фрейма');
    const selected = this.context(jobId, request), item = selected.manifest.resources.find(item => item.id === resourceId);
    if (!item || !this.descriptor(item).selectable) throw new Error('Фрейм недоступен для выбора в manifest шага 2');
    return { source_url: inspectSource(item.resolvedUrl).url, sourceFrame: { attempt: request.attempt, revision: request.htmlRevision, resourceId, sourceSha256: selected.manifest.source.sha256 }, frame: this.descriptor(item) };
  }
  resolve(jobId, ref, sourceUrl, attemptNumber, snapshot) {
    provenance(ref);
    if (ref.attempt !== attemptNumber) throw conflict('Фрейм относится к другой попытке');
    const selected = snapshot || this.snapshot(jobId, ref.attempt, ref.revision), item = selected.manifest.resources.find(item => item.id === ref.resourceId);
    if (selected.manifest.source.sha256 !== ref.sourceSha256 || !item || !this.descriptor(item).selectable || inspectSource(item.resolvedUrl).url !== sourceUrl) throw new Error('URL или происхождение фрейма не соответствует manifest');
    return this.descriptor(item);
  }
  validateDocument(jobId, document, previous, attemptNumber) {
    const old = new Map([previous.common, ...previous.tabs].flatMap(section => section.blocks.map(block => [block.id, block])));
    for (const block of [document.common, ...document.tabs].flatMap(section => section.blocks)) {
      if (block.type !== 'embed') continue;
      const before = old.get(block.id), unchanged = before?.type === 'embed' && before.source_url === block.source_url && JSON.stringify(before.sourceFrame) === JSON.stringify(block.sourceFrame);
      // Existing legacy sources remain editable without assigning invented provenance.
      if (unchanged || !block.source_url && !block.sourceFrame) continue;
      if (!block.sourceFrame) throw new Error('Выберите источник из фреймов шага 2');
      const attempt = this.queue.get(jobId).attempts.find(item => item.number === attemptNumber);
      if (block.sourceFrame.attempt !== attemptNumber || block.sourceFrame.revision !== attempt?.htmlMedia?.revision) throw conflict('Выбранный фрейм относится к устаревшей попытке или HTML');
      this.resolve(jobId, block.sourceFrame, block.source_url, attemptNumber);
    }
  }
  describeDocument(jobId, stored) {
    const frames = {}, attempt = this.queue.get(jobId).attempts.find(item => item.number === stored.attempt);
    // One source checksum per response, even with many frame blocks.
    let snapshot;
    const current = () => snapshot ||= this.snapshot(jobId, stored.attempt, attempt.htmlMedia.revision);
    for (const block of [stored.document.common, ...stored.document.tabs].flatMap(section => section.blocks)) {
      if (block.type !== 'embed') continue;
      frames[block.id] = { reason: block.source_url ? 'Источник не найден среди фреймов шага 2' : 'Нажмите, чтобы выбрать фрейм шага 2' };
      if (!block.source_url || !attempt?.htmlMedia?.revision) continue;
      try {
        if (block.sourceFrame) {
          if (block.sourceFrame.revision !== attempt.htmlMedia.revision) { frames[block.id] = { reason: 'Источник относится к прежней версии HTML шага 2' }; continue; }
          frames[block.id] = this.resolve(jobId, block.sourceFrame, block.source_url, stored.attempt, current());
        } else {
          const selected = current();
          const item = selected.manifest.resources.find(item => this.descriptor(item).selectable && inspectSource(item.resolvedUrl).url === block.source_url);
          if (item) frames[block.id] = this.descriptor(item);
        }
      } catch { frames[block.id] = { reason: 'Источник фрейма недоступен или его происхождение не подтверждено' }; }
    }
    return { ...stored, frames, mediaContext: { attempt: stored.attempt, htmlRevision: attempt?.htmlMedia?.revision || 0 } };
  }
}
module.exports = { FramePicker, provenance };
