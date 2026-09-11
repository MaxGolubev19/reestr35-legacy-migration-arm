'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fileIdentity, stableReadWithIdentity } = require('../../../infrastructure/files.cjs');
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readPng(file) {
  const { data, identity } = stableReadWithIdentity(file), header = data.subarray(0, 24);
  if (header.length !== 24 || !header.subarray(0, 8).equals(PNG) || header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR' || !header.readUInt32BE(16) || !header.readUInt32BE(20)) throw new Error('неверная PNG signature/IHDR');
  return { identity, png: Object.freeze({ bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), width: header.readUInt32BE(16), height: header.readUInt32BE(20) }) };
}

// Display-only cache, owned by one stage. Callers must resolve containment on
// every read. Action-boundary verification always uses readPng directly.
class SnapshotPngCache {
  constructor() { this.entries = new Map(); this.seen = new Set(); }
  begin() { this.seen.clear(); }
  end() {
    for (const file of this.entries.keys()) if (!this.seen.has(file)) this.entries.delete(file);
    this.seen.clear();
  }
  read(file) {
    this.seen.add(file);
    try {
      const stat = fs.statSync(file, { bigint: true });
      if (!stat.isFile()) throw new Error('Ожидался обычный файл');
      const cached = this.entries.get(file);
      if (cached?.identity === fileIdentity(stat)) return cached.png;
      const result = readPng(file);
      this.entries.set(file, result);
      return result.png;
    } catch (error) { this.entries.delete(file); throw error; }
  }
}

module.exports = { readPng, SnapshotPngCache };
