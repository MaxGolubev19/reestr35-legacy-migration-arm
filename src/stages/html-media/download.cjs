'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const http = require('node:http'), https = require('node:https'), dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');
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
function validateContent(mime, header) {
  const text = header.toString('utf8').trimStart();
  if (/^(?:<!doctype\s+html|<html|<script|<iframe)/i.test(text) || /(?:text\/html|javascript|ecmascript)/i.test(mime)) throw new Error('Активный HTML/script вместо ресурса');
  if (/flash|shockwave|(?:^|\/)x-flv$/.test(mime)) throw new Error('Flash MIME не поддерживается');
  const starts = hex => header.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  const ascii = (offset, length) => header.toString('latin1', offset, offset + length);
  const riff = format => header.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === format;
  const bmff = allowed => {
    if (header.length < 16 || ascii(4, 4) !== 'ftyp') return false;
    const size = header.readUInt32BE(0);
    if (size < 16 || size > header.length || size % 4) return false;
    const brands = [ascii(8, 4)];
    for (let offset = 16; offset < size; offset += 4) brands.push(ascii(offset, 4));
    return brands.some(brand => allowed.includes(brand));
  };
  if (mime === 'image/png') return header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/jpeg') return header[0] === 255 && header[1] === 216 && header[2] === 255;
  if (mime === 'image/gif') return /^GIF8[79]a/.test(ascii(0, 6));
  if (mime === 'image/webp') return riff('WEBP');
  if (mime === 'image/bmp') {
    if (header.length < 26 || ascii(0, 2) !== 'BM') return false;
    const dibSize = header.readUInt32LE(14), offset = header.readUInt32LE(10);
    if (![12,40,52,56,108,124].includes(dibSize) || header.length < 14 + dibSize || offset < 14 + dibSize || header.readUInt32LE(2) < offset) return false;
    return dibSize === 12 ? header.readUInt16LE(18) > 0 && header.readUInt16LE(20) > 0 && header.readUInt16LE(22) === 1
      : header.readInt32LE(18) > 0 && header.readInt32LE(22) !== 0 && header.readUInt16LE(26) === 1;
  }
  if (mime === 'image/avif') return bmff(['avif','avis']);
  if (mime === 'image/tiff') return starts('49492a00') || starts('4d4d002a');
  if (['image/vnd.microsoft.icon','image/x-icon'].includes(mime)) return header.length >= 6 && starts('00000100') && header.readUInt16LE(4) > 0;
  if (mime === 'application/pdf') return ascii(0, 5) === '%PDF-';
  if (mime === 'image/svg+xml') return /<svg[\s>]/i.test(text); // Download only; never inline.
  if (['application/zip','application/x-zip-compressed'].includes(mime) || /^application\/vnd\.(?:openxmlformats-officedocument\.|oasis\.opendocument\.)[a-z0-9.+-]+$/.test(mime)) return starts('504b0304') || starts('504b0506') || starts('504b0708');
  if (['application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint'].includes(mime)) return starts('d0cf11e0a1b11ae1');
  if (['application/rtf','text/rtf'].includes(mime)) return /^\{\\rtf[1-9]/.test(text);
  if (['application/gzip','application/x-gzip'].includes(mime)) return starts('1f8b08');
  if (['application/vnd.rar','application/x-rar-compressed'].includes(mime)) return starts('526172211a0700') || starts('526172211a070100');
  if (mime === 'application/x-7z-compressed') return starts('377abcaf271c');
  if (mime === 'application/x-tar') return header.length >= 512 && ascii(257, 5) === 'ustar';
  if (['audio/wav','audio/x-wav','audio/vnd.wave'].includes(mime)) return riff('WAVE');
  if (mime === 'audio/mpeg') return ascii(0, 3) === 'ID3' || header.length >= 4 && header[0] === 255 && (header[1] & 0xe0) === 0xe0 && (header[1] & 6) !== 0 && (header[2] & 0xf0) !== 0xf0;
  if (['audio/ogg','video/ogg','application/ogg'].includes(mime)) return starts('4f67675300');
  if (['video/webm','audio/webm'].includes(mime)) return starts('1a45dfa3') && header.includes(Buffer.from('webm'));
  if (['video/mp4','audio/mp4','video/quicktime'].includes(mime)) return bmff(['isom','iso2','iso3','iso4','iso5','iso6','mp41','mp42','avc1','dash','M4A ','M4V ','qt  ']);
  if (['text/plain','text/csv'].includes(mime)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(header, { stream: true }); } catch { return false; }
    return !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
  }
  // Unknown/binary MIME is not evidence of a supported asset. For octet-stream,
  // recognize an explicit binary format; never accept arbitrary bytes.
  if (mime === 'application/octet-stream') return ['image/png','image/jpeg','image/gif','image/webp','image/bmp','image/avif','image/tiff','image/vnd.microsoft.icon','application/pdf','application/zip','application/msword','application/gzip','application/vnd.rar','application/x-7z-compressed','application/x-tar','audio/wav','audio/mpeg','audio/ogg','video/webm','video/mp4'].some(type => validateContent(type, header));
  return false;
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
    return { status: 'downloaded', finalUrl: current.href, redirects, mime, bytes, sha256, object };
  } catch (error) { error.provenance = { finalUrl: current.href, redirects, receivedBytes: bytes }; throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); response?.destroy(); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
module.exports = { LIMITS, publicAddress, resolvePublic, validateContent, download };
