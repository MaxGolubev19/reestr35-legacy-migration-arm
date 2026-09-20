'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { stableRead } = require('./files.cjs');
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp' };
// Keep the server-declared MIME as evidence. Legacy manifests have no detectedMime.
const mediaMime = item => item.detectedMime || item.mime;
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

function detectRasterMime(header) {
  return Object.keys(extensions).find(mime => validateContent(mime, header));
}
function verifiedRasterMime(item, bytes) {
  const mime = mediaMime(item), header = bytes.subarray(0, 4096);
  if (!extensions[mime]) return null;
  // Manifest metadata alone never grants permission to render current bytes inline.
  return validateContent(item.mime, header) && validateContent(mime, header) ? mime : null;
}
function detectLegacyImages(root, directory, resources, limit) {
  const detected = [];
  for (const item of resources) {
    if (item.status !== 'downloaded' || item.mime !== 'application/octet-stream' || item.detectedMime !== undefined) continue;
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.object !== `objects/${item.sha256}`) throw new Error('Object identity mismatch');
    const bytes = readChecked(root, path.join(directory, item.object), limit);
    if (bytes.length !== item.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('Object checksum mismatch');
    const mime = detectRasterMime(bytes.subarray(0, 4096));
    // Enrich only this parsed manifest. Reading old evidence never rewrites it.
    if (mime) { item.detectedMime = mime; detected.push(item); }
  }
  return detected;
}
// Reject all links (including links that point back inside the root). Recheck
// around the descriptor-based read so a path substitution cannot grant access.
function checkedPath(root, target) {
  const base = path.resolve(root), absolute = path.resolve(target), relative = path.relative(base, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Файл вне разрешённой папки шага 2');
  let current = base;
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Ссылки и junction в папке медиа запрещены');
  }
  if (fs.realpathSync(absolute).toLowerCase() !== absolute.toLowerCase()) throw new Error('Подмена пути медиа');
  return absolute;
}
function readChecked(root, file, limit) {
  const checked = checkedPath(root, file), bytes = stableRead(checked, limit);
  checkedPath(root, file); return bytes;
}
function filename(item) {
  let basename = 'image';
  try { basename = decodeURIComponent(new URL(item.resolvedUrl || item.originalUrl).pathname.split('/').at(-1) || 'image'); } catch {}
  basename = basename.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 70) || 'image';
  return `${basename}-${item.sha256.slice(0, 16)}.${extensions[mediaMime(item)]}`;
}
function provenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'attempt,filename,revision,sha256' || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.filename !== 'string' || !/^[\p{L}\p{N}_-]+\.(png|jpg|gif|webp|avif|bmp)$/u.test(value.filename) || value.filename.length > 100) throw new Error('Некорректное происхождение медиа');
  return { attempt: value.attempt, revision: value.revision, sha256: value.sha256, filename: value.filename };
}

module.exports = { extensions, mediaMime, validateContent, detectRasterMime, verifiedRasterMime, detectLegacyImages, checkedPath, readChecked, filename, provenance };
