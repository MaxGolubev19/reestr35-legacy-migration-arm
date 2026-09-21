'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { atomicJson } = require('../../infrastructure/files.cjs');
const { readChecked, filename, mediaMime, extensions, verifiedRasterMime, validateContent } = require('../../infrastructure/media.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encoded = value => Buffer.from(JSON.stringify(value, null, 2));
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });

class MediaDeletion {
  constructor(stage) { this.stage = stage; this.failed = false; }
  assertReady() { if (this.failed) throw Object.assign(new Error('Удаление медиа не завершено; требуется восстановление при запуске'), { statusCode: 503 }); }
  journalPath(job, attempt) { return path.join(this.stage.directory(job, attempt), 'delete-transaction.json'); }
  fileHash(file) { return fs.existsSync(file) ? hash(readChecked(this.stage.queue.root, file, 24 * 1024 * 1024)) : null; }
  context(jobId, request) {
    this.assertReady();
    if (this.stage.queue.closing || !request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).sort().join(',') !== 'attempt,checkpoint,htmlRevision,resourceId,revision'
      || !['attempt', 'checkpoint', 'htmlRevision', 'resourceId'].every(key => Number.isSafeInteger(request[key]) && request[key] > 0)
      || !Number.isSafeInteger(request.revision) || request.revision < 0) throw conflict('Некорректный контекст удаления медиа');
    if (this.stage.uploads.has(jobId)) throw conflict('Добавление медиа ещё выполняется');
    const queue = this.stage.queue, job = queue.get(jobId), attempt = job.attempts.find(value => value.number === request.attempt);
    if (!attempt || job.attempts.at(-1) !== attempt || !['complete', 'paused', 'interrupted'].includes(attempt.status)
      || queue.active.has(jobId) || attempt.htmlMedia?.revision !== request.htmlRevision
      || attempt.htmlMedia?.checkpoint !== request.checkpoint) throw conflict('Попытка или HTML шага 2 изменились; обновите страницу');
    const dir = this.stage.directory(job, attempt), journal = this.journalPath(job, attempt);
    if (fs.existsSync(journal)) throw conflict('Предыдущее удаление медиа ещё не завершено');
    const manifestFile = path.join(dir, 'manifest.json'), manifestBytes = readChecked(queue.root, manifestFile, 24 * 1024 * 1024);
    const manifest = JSON.parse(manifestBytes);
    if (manifest.jobId !== jobId || manifest.attempt !== request.attempt || manifest.revision !== request.htmlRevision
      || manifest.checkpoint !== request.checkpoint || !Array.isArray(manifest.resources)) throw conflict('Manifest шага 2 изменился');
    const builder = queue.pageBuilder.read(jobId, { attempt: request.attempt, create: false });
    if ((builder?.revision || 0) !== request.revision) throw conflict('Данные шага 3 изменились; обновите страницу');
    const builderFile = queue.pageBuilder.file(jobId, request.attempt);
    return { queue, job, attempt, dir, journal, manifestFile, manifest, manifestHash: hash(manifestBytes), builder, builderFile, builderHash: this.fileHash(builderFile) };
  }
  kind(selected, item) {
    if (item.status === 'external' && item.occurrence?.tag === 'iframe' && item.occurrence.attribute === 'src') {
      if (!selected.queue.framePicker.descriptor(item).selectable) throw conflict('Фрейм недоступен для удаления');
      return 'frame';
    }
    if (item.status !== 'downloaded') throw conflict('Ресурс уже удалён или недоступен');
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.object !== `objects/${item.sha256}`) throw new Error('Object identity mismatch');
    const bytes = readChecked(selected.queue.root, path.join(selected.dir, item.object), this.stage.limits.maxFileBytes);
    if (!bytes.length || bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error('Object checksum mismatch');
    if (extensions[mediaMime(item)]) {
      if (!verifiedRasterMime(item, bytes)) throw new Error('MIME изображения не соответствует содержимому');
      return 'image';
    }
    if (!validateContent(item.mime, bytes.subarray(0, 4096)) || !validateContent(mediaMime(item), bytes.subarray(0, 4096))) throw new Error('MIME документа не соответствует содержимому');
    return 'document';
  }
  plan(jobId, request) {
    const selected = this.context(jobId, request), checked = this.stage.read(selected.job, selected.attempt, true);
    if (hash(readChecked(selected.queue.root, selected.manifestFile, 24 * 1024 * 1024)) !== selected.manifestHash) throw conflict('Manifest шага 2 изменился');
    const item = checked.resources.find(value => value.id === request.resourceId);
    if (!item) throw conflict('Ресурс не найден в manifest шага 2');
    const kind = this.kind(selected, item), remaining = checked.resources.filter(value => value.id !== item.id);
    let used = false, nextBuilder = null;
    if (selected.builder) {
      const document = structuredClone(selected.builder.document);
      const sameSource = ref => ref?.attempt === request.attempt && ref?.revision === request.htmlRevision;
      const itemUrls = [item.originalUrl, item.resolvedUrl, item.finalUrl].filter(Boolean);
      const imageName = kind === 'image' ? filename(item) : '';
      const legacyImageMatches = (ref, url) => sameSource(ref) && ref.sha256 === item.sha256 && ref.filename === imageName && itemUrls.includes(url);
      const otherImage = (ref, url) => remaining.some(other => other.status === 'downloaded' && extensions[mediaMime(other)]
        && other.sha256 === ref.sha256 && filename(other) === ref.filename && [other.originalUrl, other.resolvedUrl, other.finalUrl].includes(url));
      const otherUrl = status => remaining.some(other => other.status === status && [other.originalUrl, other.resolvedUrl, other.finalUrl].some(url => itemUrls.includes(url)));
      for (const block of [document.common, ...document.tabs].flatMap(section => section.blocks)) {
        if (kind === 'image') for (const asset of block.media) for (const variant of ['original', 'big']) {
          const field = `${variant}Url`, refField = `${variant}Media`, ref = asset[refField], url = asset[field];
          const matched = ref ? (sameSource(ref) && (ref.resourceId === item.id || ref.resourceId === undefined && legacyImageMatches(ref, url) && !otherImage(ref, url)))
            : url && itemUrls.includes(url) && !remaining.some(other => other.status === 'downloaded' && extensions[mediaMime(other)] && [other.originalUrl, other.resolvedUrl, other.finalUrl].includes(url));
          if (matched) { asset[field] = ''; delete asset[refField]; used = true; }
        }
        if (kind === 'frame' && block.type === 'embed' && block.source_url) {
          const ref = block.sourceFrame, matched = ref ? sameSource(ref) && ref.resourceId === item.id
            : itemUrls.includes(block.source_url) && !otherUrl('external');
          if (matched) { block.source_url = ''; delete block.sourceFrame; used = true; }
        }
        if (kind === 'document' && block.type === 'links') {
          const before = block.items.length;
          block.items = block.items.filter(entry => {
            const ref = entry.sourceDocument;
            const matched = ref ? sameSource(ref) && ref.resourceId === item.id && ref.sha256 === item.sha256
              : (block.view === 'documents' || entry.meta?.kind === 'document') && itemUrls.includes(entry.link)
                && !remaining.some(other => other.status === 'downloaded' && !extensions[mediaMime(other)] && [other.originalUrl, other.resolvedUrl, other.finalUrl].includes(entry.link));
            return !matched;
          });
          if (block.items.length !== before) used = true;
        }
      }
      if (used) {
        const prepared = selected.queue.pageBuilder.prepareWrite(jobId, request.revision, document, request.attempt);
        nextBuilder = { revision: prepared.revision, updatedAt: prepared.updatedAt, document: prepared.document };
      }
    }
    const nextManifest = structuredClone(selected.manifest), target = nextManifest.resources.find(value => value.id === item.id);
    target.status = 'deleted'; target.deletedAt = new Date().toISOString(); target.deletedFrom = item.status;
    nextManifest.checkpoint = request.checkpoint + 1;
    return { ...selected, item, kind, used, nextBuilder, nextManifest };
  }
  impact(jobId, request) { const plan = this.plan(jobId, request); return { used: plan.used, kind: plan.kind }; }
  commit(jobId, request) {
    const plan = this.plan(jobId, request), journal = { version: 1, jobId, attempt: request.attempt, htmlRevision: request.htmlRevision,
      resourceId: request.resourceId, manifestBefore: plan.manifestHash, manifestAfter: hash(encoded(plan.nextManifest)),
      builderBefore: plan.builderHash, builderAfter: plan.nextBuilder ? hash(encoded(plan.nextBuilder)) : plan.builderHash,
      nextManifest: plan.nextManifest, nextBuilder: plan.nextBuilder };
    if (this.fileHash(plan.manifestFile) !== journal.manifestBefore || this.fileHash(plan.builderFile) !== journal.builderBefore) throw conflict('Данные изменились перед удалением; обновите страницу');
    atomicJson(plan.journal, journal);
    try { this.recoverOne(plan.job, plan.attempt); }
    catch (error) { this.failed = true; throw error; }
    return { deleted: true, resourceId: request.resourceId, checkpoint: plan.nextManifest.checkpoint,
      builderRevision: plan.nextBuilder?.revision || request.revision, used: plan.used };
  }
  recoverOne(job, attempt) {
    const journalFile = this.journalPath(job, attempt);
    if (!fs.existsSync(journalFile)) return false;
    const record = JSON.parse(readChecked(this.stage.queue.root, journalFile, 48 * 1024 * 1024));
    if (record.version !== 1 || record.jobId !== job.id || record.attempt !== attempt.number || record.htmlRevision !== attempt.htmlMedia?.revision
      || !Number.isSafeInteger(record.resourceId) || record.resourceId < 1
      || record.manifestAfter !== hash(encoded(record.nextManifest))
      || record.builderAfter !== (record.nextBuilder ? hash(encoded(record.nextBuilder)) : record.builderBefore)) throw new Error('Журнал удаления медиа повреждён');
    const manifestFile = path.join(this.stage.directory(job, attempt), 'manifest.json'), builderFile = this.stage.queue.pageBuilder.file(job.id, attempt.number);
    const manifestHash = this.fileHash(manifestFile), builderHash = this.fileHash(builderFile);
    if (![record.manifestBefore, record.manifestAfter].includes(manifestHash) || ![record.builderBefore, record.builderAfter].includes(builderHash)
      || manifestHash === record.manifestAfter && builderHash !== record.builderAfter) throw new Error('Конфликт восстановления удаления медиа');
    if (builderHash === record.builderBefore && record.builderAfter !== record.builderBefore) atomicJson(builderFile, record.nextBuilder);
    if (manifestHash === record.manifestBefore) atomicJson(manifestFile, record.nextManifest);
    if (this.fileHash(builderFile) !== record.builderAfter || this.fileHash(manifestFile) !== record.manifestAfter) throw new Error('Удаление медиа не завершено');
    this.stage.project(attempt, record.nextManifest); this.stage.queue.save(); fs.unlinkSync(journalFile);
    return true;
  }
  recoverAll() {
    for (const job of this.stage.queue.jobs) for (const attempt of job.attempts) if (attempt.htmlMedia?.revision) this.recoverOne(job, attempt);
  }
}
module.exports = { MediaDeletion };
