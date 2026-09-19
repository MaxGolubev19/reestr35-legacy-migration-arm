'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { APP_ROOT } = require('../../data-dir.cjs');
const { attemptDir } = require('../../pipeline/paths.cjs');
const { atomicJson, safeFile, stableRead } = require('../../infrastructure/files.cjs');
const { inventory } = require('./inventory.cjs');
const { LIMITS, download } = require('./download.cjs');
const { checkedPath, filename, extensions } = require('../page-builder/media-picker.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
class HtmlMediaStage {
  constructor(queue, { htmlResources = path.join(APP_ROOT, 'src/resources'), mediaDownload = download, mediaLimits = {} } = {}) {
    Object.assign(this, { queue, resources: htmlResources, download: mediaDownload, limits: { ...LIMITS, ...mediaLimits }, uploads: new Set() });
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
    return manifest;
  }
  project(attempt, manifest) {
    const resources = manifest.resources;
    attempt.htmlMedia = { revision: manifest.revision, source: { bytes: manifest.source.bytes, sha256: manifest.source.sha256, origin: manifest.source.origin }, status: manifest.status,
      total: resources.length, downloaded: resources.filter(r => r.status === 'downloaded').length, pending: resources.filter(r => r.status === 'pending').length,
      issues: resources.filter(r => ['failed', 'unsupported'].includes(r.status)).length, external: resources.filter(r => r.status === 'external').length,
      bytes: resources.reduce((sum, r) => sum + (r.bytes || 0), 0), transferredBytes: manifest.transferredBytes || 0, checkpoint: manifest.checkpoint };
  }
  publish(job, attempt, manifest) {
    manifest.checkpoint = (manifest.checkpoint || 0) + 1;
    atomicJson(path.join(this.directory(job, attempt, manifest.revision), 'manifest.json'), manifest);
    this.project(attempt, manifest); this.queue.save();
  }
  publishImage(job, attempt, item) {
    if (item.status !== 'downloaded' || !extensions[item.mime]) return;
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.object !== `objects/${item.sha256}`) throw new Error('Object identity mismatch');
    const dir = this.directory(job, attempt), images = checkedPath(this.queue.root, path.join(dir, 'images'));
    const source = checkedPath(this.queue.root, path.join(dir, item.object)), target = path.join(images, filename(item));
    const bytes = stableRead(source, this.limits.maxFileBytes);
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) throw new Error('Object checksum mismatch');
    try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const copied = stableRead(checkedPath(this.queue.root, target), this.limits.maxFileBytes);
    if (copied.length !== item.bytes || sha(copied) !== item.sha256) throw new Error('Файл в папке выбора изменён; восстановите медиа шага 2');
  }
  create(job, attempt, bytes, origin) {
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
      fs.mkdirSync(path.join(staging, 'objects')); fs.mkdirSync(path.join(staging, 'images')); atomicJson(path.join(staging, 'manifest.json'), manifest);
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
        if (attempt.status === 'queued') this.recoverImages(job, attempt, manifest);
        this.project(attempt, manifest);
        if (['complete', 'ready_with_issues'].includes(manifest.status)) attempt.status = 'complete';
      }
      catch (error) { attempt.status = 'interrupted'; attempt.error = error.message; }
    } else { const captureStatus = attempt.captureStatus; this.enter(job, attempt); attempt.captureStatus = captureStatus; }
  }
  recoverImages(job, attempt, manifest) {
    if (['complete', 'ready_with_issues'].includes(manifest.status)) return;
    const dir = this.directory(job, attempt), images = path.join(dir, 'images');
    checkedPath(this.queue.root, dir);
    try { fs.mkdirSync(images); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    checkedPath(this.queue.root, images);
    for (const item of manifest.resources) this.publishImage(job, attempt, item);
  }
  validateResume(job, attempt) {
    if (this.uploads.has(job.id)) throw new Error('Загрузка HTML ещё выполняется');
    this.recoverImages(job, attempt, this.read(job, attempt, true));
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
            const result = existing ? Object.fromEntries(['status','finalUrl','redirects','mime','bytes','sha256','object'].map(k => [k, existing[k]])) : await this.download(item.resolvedUrl, path.join(this.directory(job, attempt), 'objects'), { limits: this.limits, remaining: this.limits.maxTotalBytes - (manifest.transferredBytes || 0), signal: controller.signal });
            if (!existing) manifest.transferredBytes = (manifest.transferredBytes || 0) + result.bytes;
            Object.assign(item, result);
          } catch (error) {
            manifest.transferredBytes = (manifest.transferredBytes || 0) + (error.provenance?.receivedBytes || 0);
            if (controller.signal.aborted) break;
            Object.assign(item, error.provenance || {}, { status: 'failed', error: error.message });
          }
          if (item.status === 'downloaded') this.publishImage(job, attempt, item);
          this.publish(job, attempt, manifest);
        }
        const paused = attempt.pauseRequested || queue.closing;
        manifest.status = paused ? 'paused' : manifest.resources.some(r => ['failed','unsupported'].includes(r.status)) ? 'ready_with_issues' : 'complete';
        this.publish(job, attempt, manifest); attempt.status = paused ? 'paused' : 'complete';
        attempt.finishedAt = new Date().toISOString();
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
