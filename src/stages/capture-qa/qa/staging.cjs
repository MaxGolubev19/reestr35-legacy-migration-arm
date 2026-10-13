'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dataRoot, dataSubdir } = require('../../../data-dir.cjs');
const { safeFile } = require('../../../infrastructure/files.cjs');
function stageBatch(hostDir, batch, root = dataRoot()) {
  // Only verified image copies enter this cwd. The staged AGENTS.md shadows
  // every parent directory, so no surrounding project instructions can reach
  // the QA session; staging belongs to the portable data root.
  const dir = fs.mkdtempSync(path.join(dataSubdir('qa-staging', root), 'session-'));
  try {
    for (const file of batch.files) {
      const source = safeFile(hostDir, path.join(hostDir, file.name));
      const data = fs.readFileSync(source);
      if (crypto.createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('PNG изменён до передачи QA');
      fs.writeFileSync(path.join(dir, file.name), data, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(dir, 'AGENTS.md'),
      'This temporary directory is the visual QA staging area of the Reestr35 ARM.\nIt contains only the PNG captures attached to the current message. Follow the\nQA instructions of the current message; there are no project instructions here.\n', { flag: 'wx' });
    return dir;
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
}
module.exports = { stageBatch };
