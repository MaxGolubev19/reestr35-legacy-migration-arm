'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dataRoot, dataSubdir } = require('../../../data-dir.cjs');
const { safeFile } = require('../../../infrastructure/files.cjs');
function stageBatch(hostDir, batch, root = dataRoot()) {
  // Only verified image copies enter this cwd. CLI flags disable inherited
  // project instructions and tools; staging belongs to the portable data root.
  const dir = fs.mkdtempSync(path.join(dataSubdir('qa-staging', root), 'session-'));
  try {
    for (const file of batch.files) {
      const source = safeFile(hostDir, path.join(hostDir, file.name));
      const data = fs.readFileSync(source);
      if (crypto.createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('PNG изменён до передачи QA');
      fs.writeFileSync(path.join(dir, file.name), data, { flag: 'wx' });
    }
    return dir;
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
}
module.exports = { stageBatch };
