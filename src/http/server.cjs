'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { APP_ROOT } = require('../data-dir.cjs');
const { safeFile, stableRead } = require('../infrastructure/files.cjs');
const { extensions, mediaMime, verifiedRasterMime } = require('../infrastructure/media.cjs');
const { attemptDir } = require('../pipeline/paths.cjs');
const { origins: embedOrigins } = require('../../public/embed-policy.js');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Нужен Content-Type application/json'), { statusCode: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 150 * 1024) throw new Error('Слишком большой запрос'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function imageBody(req, limit) {
  if (!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Нужен application/octet-stream'), { statusCode: 415 });
  if (Number(req.headers['content-length']) > limit) throw Object.assign(new Error('Изображение превышает допустимый размер'), { statusCode: 413 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Изображение превышает допустимый размер'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
function mediaPlaceholder(asset) {
  let name = 'Медиа';
  if (asset.originalUrl || asset.bigUrl) { const filename = new URL(asset.originalUrl || asset.bigUrl).pathname.split('/').at(-1); if (filename) { try { name = decodeURIComponent(filename); } catch { name = filename; } } }
  const label = (asset.alt || name).slice(0, 80), hue = parseInt(crypto.createHash('sha256').update(asset.id).digest('hex').slice(0, 4), 16) % 360;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" role="img" aria-label="${xml(label)}"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="hsl(${hue} 70% 34%)"/><stop offset="1" stop-color="hsl(${(hue + 45) % 360} 75% 17%)"/></linearGradient></defs><rect width="800" height="450" fill="url(#g)"/><path d="M0 360 180 210l105 90 125-140 230 200 80-70 80 70v90H0z" fill="white" opacity=".18"/><circle cx="650" cy="105" r="48" fill="white" opacity=".2"/><text x="40" y="385" fill="white" font-family="Segoe UI,Arial,sans-serif" font-size="28" font-weight="600">${xml(name.slice(0, 42))}</text><text x="40" y="420" fill="white" opacity=".8" font-family="Segoe UI,Arial,sans-serif" font-size="18">Предпросмотр изображения недоступен</text></svg>`);
}
const INLINE_IMAGES = new Set(Object.keys(extensions));
function readMediaObject(queue, dir, item) {
  if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.object !== `objects/${item.sha256}`) throw new Error('Object identity mismatch');
  const bytes = stableRead(safeFile(queue.root, safeFile(dir, path.join(dir, item.object))), queue.stage.media.limits.maxFileBytes);
  if (bytes.length !== item.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('Object checksum mismatch');
  return { bytes, mime: verifiedRasterMime(item, bytes) };
}
function pageBuilderMediaFile(queue, job, asset, kind = 'original', attemptNumber) {
  const reference = asset[`${kind}Media`];
  if (reference) return queue.mediaPicker.resolve(job.id, reference, asset[`${kind}Url`]);
  const attempt = job.attempts.find(item => item.number === attemptNumber);
  if (!attempt?.htmlMedia?.revision) return null;
  let manifest;
  try { manifest = queue.stage.media.read(job, attempt, true); } catch { return null; }
  const urls = new Set([asset[`${kind}Url`]].filter(Boolean));
  const item = manifest.resources.find(resource => resource.status === 'downloaded' && INLINE_IMAGES.has(mediaMime(resource))
    && [resource.originalUrl, resource.resolvedUrl, resource.finalUrl].some(value => urls.has(value)));
  if (!item) return null;
  const dir = queue.stage.media.directory(job, attempt);
  const local = readMediaObject(queue, dir, item);
  if (!local.mime) throw new Error('Object MIME mismatch');
  return local;
}

function createServer(queue, { onShutdown = async () => {} } = {}) {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  let shutdownRequested = false;
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/app.css', ['app.css', 'text/css; charset=utf-8']],
    ['/html-media.js', ['html-media.js', 'text/javascript; charset=utf-8']],
    ['/page-builder.js', ['page-builder.js', 'text/javascript; charset=utf-8']],
    ['/builder-markdown.js', ['builder-markdown.js', 'text/javascript; charset=utf-8']],
    ['/embed-policy.js', ['embed-policy.js', 'text/javascript; charset=utf-8']],
    ['/modal-actions.js', ['modal-actions.js', 'text/javascript; charset=utf-8']],
    ['/vendor/editors/editors.js', ['vendor/editors/editors.js', 'text/javascript; charset=utf-8']],
    ['/vendor/css/tabler.css', ['vendor/css/tabler.css', 'text/css; charset=utf-8']], ['/vendor/js/tabler.js', ['vendor/js/tabler.js', 'text/javascript; charset=utf-8']],
    ['/assets/astronaut.png', ['assets/astronaut.png', 'image/png']],
    ['/assets/html-media-in-development.png', ['assets/html-media-in-development.png', 'image/png']],
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src ${embedOrigins.join(' ')}; base-uri 'none'; frame-ancestors 'none'`);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const host = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(res, 403, { error: 'Разрешён только локальный origin' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site запрос запрещён' });
      const url = new URL(req.url, `http://${host}`);
      const builderAttempt = (jobId, writing = false) => {
        const job = queue.get(jobId), value = url.searchParams.get('attempt');
        if (value === null && writing && job.attempts.length > 1) throw conflict('Требуется номер попытки шага 3');
        if (value !== null && !/^[1-9][0-9]*$/.test(value)) throw conflict('Некорректный номер попытки шага 3');
        return queue.pageBuilder.attempt(jobId, value === null ? undefined : Number(value));
      };
      if (req.method === 'POST') {
        if (req.headers['x-csrf-token'] !== csrfToken) return json(res, 403, { error: 'Неверный CSRF token; обновите страницу' });
        if (url.pathname === '/api/shutdown' && (req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] !== 'same-origin')) {
          return json(res, 403, { error: 'Отключение разрешено только из локального интерфейса' });
        }
        const upload = url.pathname.match(/^\/api\/html-media\/([a-f0-9-]{36})\/([1-9][0-9]*)\/upload$/);
        if (upload) {
          if (req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Для загрузки требуется локальный Origin' });
          if (!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Нужен application/octet-stream' });
          const job = queue.get(upload[1]), attempt = job.attempts.find(a => a.number === Number(upload[2]));
          if (!attempt) return json(res, 404, { error: 'Попытка не найдена' });
          const revision = Number(req.headers['x-html-revision']);
          if (!Number.isSafeInteger(revision) || revision < 0 || req.headers['x-html-revision'] === undefined) throw conflict('Требуется revision');
          req.setTimeout(60000, () => req.destroy());
          return json(res, 200, await queue.stage.media.upload(job, attempt, revision, req));
        }
        const picker = url.pathname.match(/^\/api\/page-builder\/([a-f0-9-]{36})\/pick-media$/);
        if (picker) {
          if (req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] !== 'same-origin') return json(res, 403, { error: 'Выбор разрешён только из локального интерфейса' });
          const number = key => { const value = req.headers[key]; if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Некорректный контекст выбора изображения'); return Number(value); };
          const request = { revision: number('x-page-revision'), attempt: number('x-media-attempt'), htmlRevision: number('x-html-revision') };
          const encoded = req.headers['x-image-name'];
          if (typeof encoded !== 'string' || encoded.length > 1024) throw new Error('Некорректное имя изображения');
          let name; try { name = decodeURIComponent(encoded); } catch { throw new Error('Некорректное имя изображения'); }
          // Check CAS before accepting bytes, then check it again after the read.
          queue.mediaPicker.selectionContext(picker[1], request);
          req.setTimeout(60000, () => req.destroy());
          const bytes = await imageBody(req, queue.stage.media.limits.maxFileBytes);
          return json(res, 200, queue.mediaPicker.choose(picker[1], request, name, bytes));
        }
        const data = await body(req);
        const preparedMedia = url.pathname.match(/^\/api\/page-builder\/([a-f0-9-]{36})\/pick-prepared-media$/);
        if (preparedMedia) {
          if (req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] !== 'same-origin') return json(res, 403, { error: 'Выбор изображения разрешён только из локального интерфейса' });
          const controller = new AbortController();
          const disconnect = () => { if (!res.writableEnded) controller.abort(); };
          res.once('close', disconnect);
          try {
            const selected = await queue.mediaPicker.pickPrepared(preparedMedia[1], data, controller.signal);
            if (controller.signal.aborted || res.destroyed) return;
            return json(res, 200, selected);
          } catch (error) {
            if (controller.signal.aborted || res.destroyed) return;
            throw error;
          } finally { res.removeListener('close', disconnect); }
        }
        if (url.pathname === '/api/shutdown') {
          if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) throw new Error('Этот запрос принимает только пустой JSON-объект');
          if (shutdownRequested) throw conflict('Отключение уже выполняется');
          shutdownRequested = true;
          // Do not begin teardown until Node has completely flushed the success
          // response. The next turn also lets the client consume the final bytes.
          res.once('finish', () => setImmediate(() => {
            Promise.resolve().then(onShutdown).catch(error => console.error('Shutdown:', error.message));
          }));
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/settings') {
          if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'concurrency')) throw new Error('Разрешено только поле concurrency');
          return json(res, 200, queue.setConcurrency(data.concurrency));
        }
        if (url.pathname === '/api/jobs') {
          if (!data || Object.keys(data).some(key => key !== 'urls')) throw new Error('Разрешено только поле urls');
          return json(res, 200, queue.add(data.urls));
        }
        const pageBuilder = url.pathname.match(/^\/api\/page-builder\/([a-f0-9-]{36})$/);
        if (pageBuilder) {
          queue.get(pageBuilder[1]);
          if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['revision', 'document'].includes(key)) || Object.keys(data).length !== 2) throw new Error('Разрешены только revision и document');
          return json(res, 200, queue.pageBuilder.write(pageBuilder[1], data.revision, data.document, builderAttempt(pageBuilder[1], true)));
        }
        const action = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(retry|pause|resume|continue-qa)$/);
        if (action) {
          if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) throw new Error('Этот запрос не принимает параметры');
          await queue[action[2]](action[1]); return json(res, 200, { ok: true });
        }
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Метод не поддерживается' });
      if (url.pathname === '/api/health') return json(res, 200, { app: 'Reestr35 ARM', version: '3.2.0', instance: process.env.ARM_INSTANCE_ID || '', pid: process.pid });
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
      const pageBuilder = url.pathname.match(/^\/api\/page-builder\/([a-f0-9-]{36})$/);
      if (pageBuilder) { const job = queue.get(pageBuilder[1]), number = builderAttempt(job.id), attempt = job.attempts.find(item => item.number === number); return json(res, 200, { ...queue.pageBuilder.read(job.id, { attempt: number }), mediaContext: { attempt: number, htmlRevision: attempt.htmlMedia?.revision || 0 } }); }
      const selectedMedia = url.pathname.match(/^\/api\/page-builder\/([a-f0-9-]{36})\/selection\/([a-f0-9]{64})$/);
      if (selectedMedia) {
        const local = queue.mediaPicker.preview(selectedMedia[1], selectedMedia[2]);
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
        res.writeHead(200, { 'Content-Type': local.mime, 'Content-Disposition': 'inline' }); res.end(local.bytes); return;
      }
      const pageBuilderMedia = url.pathname.match(/^\/api\/page-builder\/([a-f0-9-]{36})\/media\/([a-z0-9][a-z0-9-]{0,63})$/);
      if (pageBuilderMedia) {
        const job = queue.get(pageBuilderMedia[1]), number = builderAttempt(job.id), asset = queue.pageBuilder.media(job.id, pageBuilderMedia[2], number);
        if (!asset) return json(res, 404, { error: 'Медиа не найдено' });
        const kind = url.searchParams.get('kind') || 'original';
        if (!['original', 'big'].includes(kind)) throw new Error('Неизвестный тип изображения');
        const local = pageBuilderMediaFile(queue, job, asset, kind, number);
        if (local) {
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
          res.writeHead(200, { 'Content-Type': local.mime, 'Content-Disposition': 'inline' });
          if (local.bytes) { res.end(local.bytes); return; }
          const stream = fs.createReadStream(local.file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
        }
        const svg = mediaPlaceholder(asset);
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': svg.length }); res.end(svg); return;
      }
      const media = url.pathname.match(/^\/api\/html-media\/([a-f0-9-]{36})\/([1-9][0-9]*)\/([1-9][0-9]*)\/(manifest|source|code|objects\/[a-f0-9]{64})$/);
      if (media) {
        const job = queue.get(media[1]), attempt = job.attempts.find(a => a.number === Number(media[2]));
        if (!attempt || attempt.htmlMedia?.revision !== Number(media[3])) return json(res, 404, { error: 'Revision недоступна' });
        const stage = queue.stage.media, manifest = stage.read(job, attempt), dir = stage.directory(job, attempt);
        if (media[4] === 'manifest') return json(res, 200, manifest);
        if (media[4] === 'code') {
          const bytes = fs.readFileSync(safeFile(queue.root, safeFile(dir, path.join(dir, 'source.html'))));
          let text; try { text = new TextDecoder(manifest.source.encoding || 'utf-8').decode(bytes); } catch { text = bytes.toString('utf8'); }
          return json(res, 200, { text });
        }
        const source = media[4] === 'source', item = source ? null : manifest.resources.find(r => r.status === 'downloaded' && r.object === media[4]);
        if (!source && !item) return json(res, 404, { error: 'Object не входит в manifest' });
        const file = safeFile(queue.root, safeFile(dir, path.join(dir, source ? 'source.html' : item.object)));
        const local = item ? readMediaObject(queue, dir, item) : null, inlineImage = !!local?.mime;
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
        res.writeHead(200, { 'Content-Type': inlineImage ? local.mime : 'application/octet-stream', 'Content-Disposition': `${inlineImage ? 'inline' : 'attachment'}; filename="${source ? 'source.html' : item.sha256}"` });
        if (local) { res.end(local.bytes); return; }
        const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      const logs = url.pathname.match(/^\/api\/logs\/([a-f0-9-]{36})\/([1-9][0-9]*)$/);
      if (logs) {
        const job = queue.get(logs[1]), attempt = job.attempts.find(a => a.number === Number(logs[2]));
        if (!attempt) return json(res, 404, { error: 'Попытка не найдена' });
        const stream = url.searchParams.get('stream');
        if (!['stdout', 'stderr'].includes(stream)) throw new Error('Неизвестный поток');
        const dir = attemptDir(queue.root, job, attempt);
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
        const dir = attemptDir(queue.root, job, attempt);
        const file = safeFile(queue.root, safeFile(dir, queue.stage.artifactPath(job, attempt, name)));
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

module.exports = { createServer, INLINE_IMAGES };
