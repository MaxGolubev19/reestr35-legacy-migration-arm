'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

// Resolve every link/junction before serving; a report cannot grant access outside its attempt.
function safeFile(root, target) {
  const actualRoot = fs.realpathSync(root);
  const actual = fs.realpathSync(target);
  if (!inside(actualRoot, actual) || !fs.statSync(actual).isFile()) throw new Error('Файл вне разрешённой папки');
  return actual;
}

function readJson(file) {
  return JSON.parse(stableRead(file, 10 * 1024 * 1024).toString('utf8'));
}

function stableRead(file, limit = Infinity) {
  return stableReadWithIdentity(file, limit).data;
}

// Use nanosecond timestamps and the filesystem identity, including change time:
// restoring mtime alone must not make changed bytes appear unchanged.
function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}

function stableReadWithIdentity(file, limit = Infinity) {
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error('Ожидался обычный файл');
    if (before.size > limit) throw new Error('Файл превышает допустимый размер');
    const data = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), current = fs.statSync(file, { bigint: true });
    const identity = fileIdentity(before);
    if (!after.isFile() || !current.isFile() || BigInt(data.length) !== before.size || identity !== fileIdentity(after) || identity !== fileIdentity(current)) throw new Error('Файл изменяется; повторите чтение');
    return { data, identity };
  } finally { fs.closeSync(fd); }
}

function atomicJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
module.exports = { safeFile, readJson, stableRead, stableReadWithIdentity, fileIdentity, atomicJson };
