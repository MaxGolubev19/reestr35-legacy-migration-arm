'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { APP_ROOT, dataSubdir } = require('../../../data-dir.cjs');
const { safeFile } = require('../../../infrastructure/files.cjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// The site wire contract enters staging as a byte-identical copy of the ARM
// snapshot, so the builder can never see a drifted model of the target site.
const CONTRACT_SNAPSHOT = path.join(APP_ROOT, 'src', 'resources', 'company-block-contract.v1.json');

// Only verified copies enter the builder cwd: every PNG is re-checked against
// the immutable capture manifest and source.html against the step 2 manifest.
// The staged AGENTS.md shadows parent directories, so no surrounding project
// instructions can reach the session; staging belongs to the portable data root.
function stageBuilder(root, { hostDir, files, htmlDir, htmlSha256, catalogs }) {
  const dir = fs.mkdtempSync(path.join(dataSubdir('builder-staging', root), 'run-'));
  try {
    for (const file of files) {
      const source = safeFile(hostDir, path.join(hostDir, file.name));
      const data = fs.readFileSync(source);
      if (sha256(data) !== file.sha256) throw new Error('PNG изменён до передачи сборщику');
      fs.writeFileSync(path.join(dir, file.name), data, { flag: 'wx' });
    }
    const html = fs.readFileSync(safeFile(htmlDir, path.join(htmlDir, 'source.html')));
    if (sha256(html) !== htmlSha256) throw new Error('source.html не соответствует manifest шага 2');
    fs.writeFileSync(path.join(dir, 'source.html'), html, { flag: 'wx' });
    for (const [name, value] of Object.entries(catalogs)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(path.join(dir, 'block-contract.json'), fs.readFileSync(CONTRACT_SNAPSHOT), { flag: 'wx' });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'),
      'This temporary directory is the page-builder staging area of the Reestr35 ARM.\nIt contains only the staged PNG captures, source.html and the JSON catalogs\nserving the current message. Read only the whitelisted files through the\nread_file tool and follow the instructions of the current message; there are\nno project instructions here.\n', { flag: 'wx' });
    return dir;
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
}

function cleanupBuilder(run) {
  const dir = run?.stagingDir;
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (error) { console.error(`Не удалось удалить временный каталог сборщика: ${error.message}`); }
}
module.exports = { stageBuilder, cleanupBuilder };
