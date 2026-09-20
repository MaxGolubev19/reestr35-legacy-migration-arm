'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const http = require('node:http'), https = require('node:https'), dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');
const { validateContent, detectRasterMime } = require('../../infrastructure/media.cjs');
const LIMITS = Object.freeze({ maxResources: 3000, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, timeoutMs: 30000, maxRedirects: 5, maxHtmlBytes: 8 * 1024 * 1024 });
function publicAddress(address) {
  try { const ip = ipaddr.process(address); return ip.range() === 'unicast'; } catch { return false; }
}
async function resolvePublic(url, resolver = dns.lookup) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Запрещённый URL/protocol/credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || /\.(?:localhost|local|internal|test|invalid)$/.test(hostname) || !hostname.includes('.') && !ipaddr.isValid(hostname)) throw new Error('Непубличный hostname');
  const answers = ipaddr.isValid(hostname) ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4 }] : await resolver(hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some(a => !publicAddress(a.address))) throw new Error('DNS содержит непубличный IP');
  return answers;
}
async function download(input, directory, { limits = LIMITS, remaining = limits.maxTotalBytes, signal, resolver = dns.lookup, request = (url, options, callback) => (url.protocol === 'https:' ? https : http).request(url, options, callback) } = {}) {
  if (remaining <= 0) throw new Error('Лимит суммарного размера');
  const temp = path.join(directory, crypto.randomUUID() + '.tmp');
  let current = new URL(input), redirects = [], response, bytes = 0;
  const controller = new AbortController(), abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Таймаут ресурса')), limits.timeoutMs);
  const hash = crypto.createHash('sha256');
  try {
    for (;;) {
      const answers = await Promise.race([resolvePublic(current, resolver), new Promise((_, reject) => { controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); if (controller.signal.aborted) reject(controller.signal.reason); })]);
      response = await new Promise((resolve, reject) => {
        // Pin the vetted DNS answer into this socket; no second resolver/rebinding.
        const req = request(current, { method: 'GET', signal: controller.signal, agent: false, headers: { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'Reestr35-ARM/3 HTML-media' }, lookup: (_hostname, options, callback) => options.all ? callback(null, answers) : callback(null, answers[0].address, answers[0].family) }, resolve);
        req.on('error', reject); req.end();
      });
      if (![301,302,303,307,308].includes(response.statusCode)) break;
      response.destroy();
      if (redirects.length >= limits.maxRedirects || !response.headers.location) throw new Error('Лимит/некорректный redirect');
      const next = new URL(response.headers.location, current); redirects.push({ from: current.href, status: response.statusCode, to: next.href }); current = next;
    }
    if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);
    const mime = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const max = Math.min(limits.maxFileBytes, remaining);
    if (Number(response.headers['content-length']) > max || max <= 0) throw new Error('Лимит размера ресурса/суммарного размера');
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Сжатая передача не поддерживается');
    const file = await fs.promises.open(temp, 'wx'); let header = Buffer.alloc(0);
    try {
      for await (const chunk of response) {
        bytes += chunk.length; if (bytes > max) throw new Error('Лимит размера ресурса/суммарного размера');
        if (header.length < 4096) header = Buffer.concat([header, chunk.subarray(0, 4096 - header.length)]);
        hash.update(chunk); await file.writeFile(chunk);
      }
      if (!bytes || !validateContent(mime, header)) throw new Error('MIME/signature ресурса не прошли проверку');
      await file.sync();
    } finally { await file.close(); }
    const sha256 = hash.digest('hex'), object = `objects/${sha256}`;
    await fs.promises.rename(temp, path.join(directory, sha256));
    const detectedMime = detectRasterMime(header);
    return { status: 'downloaded', finalUrl: current.href, redirects, mime, ...(detectedMime ? { detectedMime } : {}), bytes, sha256, object };
  } catch (error) { error.provenance = { finalUrl: current.href, redirects, receivedBytes: bytes }; throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); response?.destroy(); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
module.exports = { LIMITS, publicAddress, resolvePublic, validateContent, download };
