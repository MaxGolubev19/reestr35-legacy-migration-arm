'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { APP_ROOT } = require('../data-dir.cjs');
const { safeFile } = require('../infrastructure/files.cjs');
const { attemptDir } = require('../pipeline/paths.cjs');
const conflict = message => Object.assign(new Error(message), { statusCode: 409 });
function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Нужен Content-Type application/json'), { statusCode: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 150 * 1024) throw new Error('Слишком большой запрос'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createServer(queue, { onShutdown = async () => {} } = {}) {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  let shutdownRequested = false;
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/app.css', ['app.css', 'text/css; charset=utf-8']],
    ['/vendor/css/tabler.css', ['vendor/css/tabler.css', 'text/css; charset=utf-8']], ['/vendor/js/tabler.js', ['vendor/js/tabler.js', 'text/javascript; charset=utf-8']],
    ['/assets/astronaut.png', ['assets/astronaut.png', 'image/png']],
    ['/assets/html-media-in-development.png', ['assets/html-media-in-development.png', 'image/png']],
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
        if (url.pathname === '/api/shutdown' && (req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] !== 'same-origin')) {
          return json(res, 403, { error: 'Отключение разрешено только из локального интерфейса' });
        }
        const data = await body(req);
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
        const action = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})\/(retry|pause|resume|continue-qa)$/);
        if (action) {
          if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) throw new Error('Этот запрос не принимает параметры');
          await queue[action[2]](action[1]); return json(res, 200, { ok: true });
        }
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Метод не поддерживается' });
      if (url.pathname === '/api/health') return json(res, 200, { app: 'Reestr35 ARM', version: '3.0.1', instance: process.env.ARM_INSTANCE_ID || '', pid: process.pid });
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

module.exports = { createServer };
