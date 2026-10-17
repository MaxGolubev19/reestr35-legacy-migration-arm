'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { APP_ROOT } = require('../../data-dir.cjs');
const { attemptDir } = require('../../pipeline/paths.cjs');
const { atomicJson, safeFile, stableRead } = require('../../infrastructure/files.cjs');
const { inventory } = require('./inventory.cjs');
const { LIMITS, download } = require('./download.cjs');
const { detectLegacyImages, validateContent, detectRasterMime, readChecked } = require('../../infrastructure/media.cjs');
const { inspectSource } = require('../../../public/embed-policy.js');
const { parseFragment, serializeOuter } = require('parse5');
const { MediaDeletion } = require('./deletion.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
class HtmlMediaStage {
  constructor(queue, { htmlResources = path.join(APP_ROOT, 'src/resources'), mediaDownload = download, mediaLimits = {} } = {}) {
    Object.assign(this, { queue, resources: htmlResources, download: mediaDownload, limits: { ...LIMITS, ...mediaLimits }, uploads: new Set() });
    this.deletion = new MediaDeletion(this);
  }
  directory(job, attempt, revision = attempt.htmlMedia?.revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Нет HTML revision');
    return path.join(attemptDir(this.queue.root, job, attempt), 'html-media', `revision-${String(revision).padStart(3, '0')}`);
  }
  read(job, attempt, verify = false) {
    const dir = this.directory(job, attempt), manifest = JSON.parse(stableRead(safeFile(this.queue.root, path.join(dir, 'manifest.json')), 24 * 1024 * 1024));
    if (manifest.jobId !== job.id || manifest.attempt !== attempt.number || manifest.revision !== attempt.htmlMedia.revision) throw new Error('HTML manifest identity mismatch');
    if (verify) {
      if (sha(stableRead(safeFile(dir, path.join(dir, 'source.html')), this.limits.maxHtmlBytes)) !== manifest.source.sha256) throw new Error('HTML source checksum mismatch');
      for (const item of manifest.resources) if (item.status === 'downloaded') {
        if (!/^objects\/[a-f0-9]{64}$/.test(item.object) || item.object !== `objects/${item.sha256}`) throw new Error('Object identity mismatch');
        const bytes = stableRead(safeFile(dir, path.join(dir, item.object)), this.limits.maxFileBytes);
        if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) throw new Error('Object checksum mismatch');
      }
    }
    detectLegacyImages(this.queue.root, dir, manifest.resources, this.limits.maxFileBytes);
    return manifest;
  }
  project(attempt, manifest) {
    const resources = manifest.resources.filter(item => item.status !== 'deleted');
    attempt.htmlMedia = { revision: manifest.revision, source: { bytes: manifest.source.bytes, sha256: manifest.source.sha256, origin: manifest.source.origin }, status: manifest.status,
      total: resources.length, downloaded: resources.filter(r => r.status === 'downloaded').length, pending: resources.filter(r => r.status === 'pending').length,
      issues: resources.filter(r => ['failed', 'unsupported'].includes(r.status)).length, external: resources.filter(r => r.status === 'external').length,
      bytes: resources.reduce((sum, r) => sum + (r.bytes || 0), 0), transferredBytes: manifest.transferredBytes || 0, checkpoint: manifest.checkpoint };
  }
  publish(job, attempt, manifest) {
    this.deletion.assertReady();
    manifest.checkpoint = (manifest.checkpoint || 0) + 1;
    atomicJson(path.join(this.directory(job, attempt, manifest.revision), 'manifest.json'), manifest);
    this.project(attempt, manifest); this.queue.save();
  }
  manualContext(jobId, request) {
    this.deletion.assertReady();
    if (this.queue.closing || !request || Object.keys(request).sort().join(',') !== 'attempt,htmlRevision,revision'
      || !Object.values(request).every(value => Number.isSafeInteger(value) && value > 0)) throw conflict('Некорректный контекст добавления медиа');
    const job = this.queue.get(jobId), attempt = job.attempts.find(value => value.number === request.attempt);
    if (!attempt || job.attempts.at(-1) !== attempt || !['complete', 'paused', 'interrupted'].includes(attempt.status)
      || this.queue.active.has(jobId) || attempt.htmlMedia?.revision !== request.htmlRevision
      || this.queue.pageBuilder.read(jobId, { attempt: request.attempt, create: false })?.revision !== request.revision) throw conflict('Попытка, HTML или документ изменились; откройте редактор снова');
    const dir = this.directory(job, attempt), manifestBytes = readChecked(this.queue.root, path.join(dir, 'manifest.json'), 24 * 1024 * 1024);
    const manifest = JSON.parse(manifestBytes);
    if (manifest.jobId !== jobId || manifest.attempt !== request.attempt || manifest.revision !== request.htmlRevision || !Array.isArray(manifest.resources)) throw conflict('Manifest шага 2 изменился');
    return { job, attempt, dir, manifest, manifestHash: sha(manifestBytes) };
  }
  commitManual(jobId, request, selected, item) {
    const current = this.manualContext(jobId, request);
    if (current.manifestHash !== selected.manifestHash) throw conflict('Manifest шага 2 изменился; откройте выбор снова');
    if (selected.manifest.resources.length >= this.limits.maxResources) throw new Error('Лимит ресурсов шага 2');
    item.id = Math.max(0, ...selected.manifest.resources.map(value => value.id)) + 1;
    selected.manifest.resources.push(item);
    this.publish(selected.job, selected.attempt, selected.manifest);
    return { resourceId: item.id, checkpoint: selected.manifest.checkpoint };
  }
  async addFile(jobId, request, name, kind, stream) {
    if (!['image', 'document'].includes(kind) || typeof name !== 'string' || !name || Buffer.byteLength(name, 'utf8') > 240
      || /[\p{Cc}\p{Cf}\p{Cs}<>:"/\\|?*]/u.test(name) || /^\.|[. ]$/.test(name)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Некорректное имя или тип файла');
    if (this.uploads.has(jobId)) throw conflict('Добавление медиа уже выполняется');
    const selected = this.manualContext(jobId, request);
    this.uploads.add(jobId);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of stream) { size += chunk.length; if (size > this.limits.maxFileBytes) throw new Error('Файл превышает лимит размера'); chunks.push(chunk); }
      if (!size) throw new Error('Пустой файл');
      const bytes = Buffer.concat(chunks), header = bytes.subarray(0, 4096), extension = name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
      const mimes = { pdf:'application/pdf', txt:'text/plain', csv:'text/csv', rtf:'application/rtf', doc:'application/msword', xls:'application/vnd.ms-excel', ppt:'application/vnd.ms-powerpoint',
        docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        odt:'application/vnd.oasis.opendocument.text', ods:'application/vnd.oasis.opendocument.spreadsheet', zip:'application/zip', gz:'application/gzip', rar:'application/vnd.rar', '7z':'application/x-7z-compressed', tar:'application/x-tar',
        mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', mp4:'video/mp4', m4a:'audio/mp4', webm:'video/webm', mov:'video/quicktime', svg:'image/svg+xml', tif:'image/tiff', tiff:'image/tiff', ico:'image/vnd.microsoft.icon' };
      const raster = detectRasterMime(header), mime = kind === 'image' ? raster : mimes[extension];
      if (kind === 'image' && (!raster || !({ png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', avif:'image/avif', bmp:'image/bmp' })[extension] || ({ png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', avif:'image/avif', bmp:'image/bmp' })[extension] !== raster)
        || kind === 'document' && (!mime || raster || !validateContent(mime, header))) throw new Error('Формат файла и содержимое не совпадают');
      const current = this.manualContext(jobId, request);
      if (current.manifestHash !== selected.manifestHash) throw conflict('Manifest шага 2 изменился; откройте выбор снова');
      const used = selected.manifest.resources.filter(item => item.status === 'downloaded').reduce((sum, item) => sum + (item.bytes || 0), 0);
      if (used + size > this.limits.maxTotalBytes) throw new Error('Лимит суммарного размера медиа');
      const digest = sha(bytes), object = `objects/${digest}`, destination = path.join(selected.dir, object);
      if (fs.existsSync(destination)) { if (!readChecked(this.queue.root, destination, this.limits.maxFileBytes).equals(bytes)) throw new Error('Коллизия объекта медиа'); }
      else { const temp = path.join(selected.dir, 'objects', `${crypto.randomUUID()}.tmp`); try { fs.writeFileSync(temp, bytes, { flag: 'wx' }); fs.renameSync(temp, destination); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); } }
      const nextId = Math.max(0, ...selected.manifest.resources.map(item => item.id)) + 1;
      const localUrl = `/api/html-media/${jobId}/${request.attempt}/${request.htmlRevision}/${object}?resourceId=${nextId}`;
      return this.commitManual(jobId, request, selected, { kind: 'asset', status: 'downloaded', manual: true, originalUrl: localUrl, resolvedUrl: localUrl,
        occurrence: { tag: 'manual-upload', attribute: 'file', line: null, column: null, downloadFilename: name }, mime, bytes: size, sha256: digest, object });
    } finally { this.uploads.delete(jobId); }
  }
  addFrame(jobId, request, code) {
    if (this.uploads.has(jobId)) throw conflict('Добавление медиа уже выполняется');
    const selected = this.manualContext(jobId, request);
    if (typeof code !== 'string' || !code.trim() || code.length > 8192) throw new Error('Введите код iframe до 8192 символов');
    const parseErrors = [], fragment = parseFragment(code.trim(), { onParseError: error => parseErrors.push(error.code) });
    const elements = fragment.childNodes.filter(node => node.nodeName !== '#text' || node.value.trim());
    if (elements.length !== 1 || elements[0].tagName !== 'iframe' || elements[0].childNodes.length) throw new Error('Нужен один iframe без вложенного содержимого');
    const attrs = elements[0].attrs || [], allowed = new Set(['src', 'title', 'width', 'height', 'loading', 'allow', 'allowfullscreen', 'frameborder']);
    if (attrs.filter(attr => attr.name === 'src').length !== 1) throw new Error('Код iframe должен содержать атрибут src');
    const source = inspectSource(attrs.find(attr => attr.name === 'src').value);
    if (!source.allowed) throw new Error(source.reason);
    // Manual snippets are copied as text. Drop unknown attributes from the
    // persisted copy, including event handlers and srcdoc.
    const unknown = attrs.some(attr => !allowed.has(attr.name));
    if (unknown) elements[0].attrs = attrs.filter(attr => allowed.has(attr.name));
    const snippet = unknown || parseErrors.includes('duplicate-attribute') ? serializeOuter(elements[0]) : code;
    this.uploads.add(jobId);
    try { return this.commitManual(jobId, request, selected, { kind: 'external', status: 'external', manual: true, originalUrl: source.url, resolvedUrl: source.url,
      occurrence: { tag: 'iframe', attribute: 'src', line: null, column: null }, snippet }); }
    finally { this.uploads.delete(jobId); }
  }
  create(job, attempt, bytes, origin) {
    this.deletion.assertReady();
    if (bytes.length > this.limits.maxHtmlBytes || !bytes.length) throw new Error('HTML пуст или превышает лимит 8 MiB');
    const root = path.join(attemptDir(this.queue.root, job, attempt), 'html-media'); fs.mkdirSync(root, { recursive: true });
    let revision = (attempt.htmlMedia?.revision || 0) + 1, dir;
    for (;;) { dir = this.directory(job, attempt, revision); if (!fs.existsSync(dir)) break; revision++; }
    const staging = path.join(root, `.revision-${crypto.randomUUID()}.tmp`); fs.mkdirSync(staging);
    const manifest = { version: 1, jobId: job.id, attempt: attempt.number, revision, status: 'ready', checkpoint: 1, transferredBytes: 0,
      source: { origin, bytes: bytes.length, sha256: sha(bytes) }, provenance: { baseUrl: job.url, relativeUrls: 'resolved against job URL; HTML base element is not applied', parser: 'parse5 static; no JavaScript execution', encoding: 'UTF-8, or declared HTML charset' }, resources: [] };
    try {
      const ascii = bytes.subarray(0, 4096).toString('ascii'), charset = ascii.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
      let text; try { text = new TextDecoder(charset).decode(bytes); } catch { text = bytes.toString('utf8'); }
      manifest.source.encoding = charset; manifest.resources = inventory(text, job.url, this.limits.maxResources);
      fs.writeFileSync(path.join(staging, 'source.html'), bytes, { flag: 'wx' });
      fs.mkdirSync(path.join(staging, 'objects')); atomicJson(path.join(staging, 'manifest.json'), manifest);
      fs.renameSync(staging, dir); this.project(attempt, manifest);
    } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
    return manifest;
  }
  enter(job, attempt) {
    attempt.phase = 'html-media'; attempt.captureStatus = 'complete'; attempt.status = 'interrupted';
    delete attempt.error; delete attempt.pauseRequested; delete attempt.cancellationRequested;
    if (!attempt.htmlMedia?.revision) {
      try {
        const filename = path.resolve(this.resources, 'html', new URL(job.url).hostname + '.html');
        // Only an absent expected source is an upload wait. Once this lookup
        // succeeds, read/validation/staging/publication failures are real errors.
        try { fs.lstatSync(filename); }
        catch (error) {
          if (error.code !== 'ENOENT' || error.path !== filename) throw error;
          attempt.status = 'paused';
          attempt.htmlMedia = { revision: 0, status: 'missing', error: 'HTML не найден. Выберите исходный HTML-файл.' }; return;
        }
        this.create(job, attempt, stableRead(safeFile(this.resources, filename), this.limits.maxHtmlBytes), 'bundled');
      } catch (error) {
        attempt.error = error.message;
        attempt.htmlMedia = { revision: 0, status: 'error', error: error.message }; return;
      }
    }
    Object.assign(attempt, { status: 'queued', queuedAt: new Date(this.queue.clock()).toISOString(), queueOrder: ++this.queue.nextQueueOrder });
    delete attempt.finishedAt;
  }
  restore(job, attempt) {
    // In-process worker dies with backend; no detached PID/lease is introduced.
    if (attempt.pauseRequested || attempt.cancellationRequested || ['pausing', 'stopping'].includes(attempt.status)) attempt.status = 'paused';
    else if (attempt.status === 'running') attempt.status = 'queued';
    delete attempt.pauseRequested; delete attempt.cancellationRequested;
    if (attempt.htmlMedia?.revision) {
      try {
        const manifest = this.read(job, attempt, true);
        this.project(attempt, manifest);
        if (['complete', 'ready_with_issues'].includes(manifest.status)) attempt.status = 'complete';
      }
      catch (error) { attempt.status = 'interrupted'; attempt.error = error.message; }
    } else { const captureStatus = attempt.captureStatus; this.enter(job, attempt); attempt.captureStatus = captureStatus; }
  }
  validateResume(job, attempt) {
    if (this.uploads.has(job.id)) throw new Error('Загрузка HTML ещё выполняется');
    this.read(job, attempt, true);
  }
  start(job, attempt) {
    const queue = this.queue, controller = new AbortController();
    const child = { exitCode: null, isHtmlMedia: true, armClosed: false };
    queue.active.set(job.id, child); attempt.status = 'running'; delete attempt.finishedAt;
    child.armInterrupt = async () => { attempt.pauseRequested = true; controller.abort(new Error('Остановка ARM')); await child.completion; return { treeStopped: true }; };
    child.completion = (async () => {
      try {
        const manifest = this.read(job, attempt, true); manifest.status = 'running'; this.publish(job, attempt, manifest);
        for (const item of manifest.resources) {
          if (attempt.pauseRequested || queue.closing) break;
          if (item.status !== 'pending') continue;
          try {
            const existing = manifest.resources.find(r => r.status === 'downloaded' && r.resolvedUrl === item.resolvedUrl);
            const result = existing ? Object.fromEntries(['status','finalUrl','redirects','mime','detectedMime','bytes','sha256','object'].map(k => [k, existing[k]])) : await this.download(item.resolvedUrl, path.join(this.directory(job, attempt), 'objects'), { limits: this.limits, remaining: this.limits.maxTotalBytes - (manifest.transferredBytes || 0), signal: controller.signal });
            if (!existing) manifest.transferredBytes = (manifest.transferredBytes || 0) + result.bytes;
            Object.assign(item, result);
          } catch (error) {
            manifest.transferredBytes = (manifest.transferredBytes || 0) + (error.provenance?.receivedBytes || 0);
            if (controller.signal.aborted) break;
            Object.assign(item, error.provenance || {}, { status: 'failed', error: error.message });
          }
          this.publish(job, attempt, manifest);
        }
        const paused = attempt.pauseRequested || queue.closing;
        manifest.status = paused ? 'paused' : manifest.resources.some(r => ['failed','unsupported'].includes(r.status)) ? 'ready_with_issues' : 'complete';
        this.publish(job, attempt, manifest); attempt.status = paused ? 'paused' : 'complete';
        attempt.finishedAt = new Date().toISOString();
        // Stage 2 completion is the only live auto-assembly trigger; the
        // builder hook never breaks the attempt's own completion path.
        if (attempt.status === 'complete') { try { queue.builder?.consider(job, attempt); } catch (error) { console.error(`Builder autostart (${job.id}): ${error.message}`); } }
      } catch (error) { attempt.status = 'interrupted'; attempt.error = error.message; }
      finally {
        child.exitCode = 0; child.armClosed = true; queue.active.delete(job.id); delete attempt.pauseRequested; delete attempt.cancellationRequested;
        let saved = false;
        try { queue.save(); saved = true; } catch (error) { attempt.error = `Checkpoint на диске; state не записан: ${error.message}`; }
        if (saved && !queue.closing) queue.pump();
      }
    })();
    return child;
  }
  async upload(job, attempt, expectedRevision, request) {
    const queue = this.queue;
    const check = () => {
      this.deletion.assertReady();
      if (queue.closing || job.attempts.at(-1) !== attempt || attempt.phase !== 'html-media' || !['paused','complete','interrupted'].includes(attempt.status) || queue.active.has(job.id) || (attempt.htmlMedia?.revision || 0) !== expectedRevision) throw conflict('Попытка или revision изменились; обновите страницу');
    };
    check(); if (this.uploads.has(job.id)) throw conflict('HTML уже загружается');
    const resumeMissing = attempt.status === 'paused' && attempt.htmlMedia?.status === 'missing';
    this.uploads.add(job.id);
    const temp = path.join(attemptDir(queue.root, job, attempt), `html-upload-${crypto.randomUUID()}.tmp`);
    try {
      const file = await fs.promises.open(temp, 'wx'); let size = 0;
      try { for await (const chunk of request) { size += chunk.length; if (size > this.limits.maxHtmlBytes) throw new Error('HTML превышает лимит 8 MiB'); await file.writeFile(chunk); } await file.sync(); } finally { await file.close(); }
      check(); this.create(job, attempt, stableRead(temp, this.limits.maxHtmlBytes), 'manual-upload'); attempt.status = 'paused'; delete attempt.error; queue.save();
    } finally { this.uploads.delete(job.id); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    // Release the upload fence before normal validation and FIFO scheduling.
    if (resumeMissing) queue.resume(job.id);
    return { ok: true, revision: attempt.htmlMedia.revision };
  }
}
module.exports = { HtmlMediaStage };
