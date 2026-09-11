'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(process.argv[2]);
assert.deepEqual(fs.readdirSync(root).sort(), ['Reestr35 ARM.exe', 'public', 'runtime', 'src']);
const nodeVersion = spawnSync(path.join(root,'runtime/node.exe'), ['--version'], { encoding: 'utf8', windowsHide: true });
assert.equal(nodeVersion.status, 0); assert.equal(nodeVersion.stdout.trim(), 'v24.21.0');
const { createHash } = require('node:crypto');
const licenseRoot = path.join(root, 'runtime/licenses');
const licenseSources = JSON.parse(fs.readFileSync(path.join(licenseRoot, 'SOURCES.json'), 'utf8'));
for (const [name, source] of Object.entries(licenseSources)) {
  const content = fs.readFileSync(path.join(licenseRoot, name));
  assert.equal(createHash('sha256').update(content).digest('hex'), source.sha256, `complete pinned license: ${name}`);
}
assert.match(fs.readFileSync(path.join(licenseRoot,'SHARP-LIBVIPS-NOTICE.txt'),'utf8'), /libvips 8\.18\.6/);
for (const file of ['src/server.cjs','src/capture.cjs','src/qa.cjs','src/qa-instructions.txt','src/qa-models.json','public/index.html','runtime/node.exe','runtime/NODE-LICENSE.txt','runtime/ARM-LICENSE.txt','runtime/GO-LICENSE.txt','runtime/node_modules/playwright/LICENSE','runtime/node_modules/sharp/LICENSE']) assert(fs.statSync(path.join(root,file)).isFile(), file);
const exe = fs.readFileSync(path.join(root,'Reestr35 ARM.exe')), pe = exe.readUInt32LE(0x3c);
assert.equal(exe.readUInt16LE(pe + 4), 0x8664, 'x64');
assert.equal(exe.readUInt16LE(pe + 24 + 68), 2, 'Windows GUI subsystem');
assert.equal(require(path.join(root,'runtime/node_modules/playwright/package.json')).version, '1.62.1');
assert.equal(require(path.join(root,'runtime/node_modules/sharp/package.json')).version, '0.35.4');
const resourceOffset = pe + 24 + 112 + 16;
assert(exe.readUInt32LE(resourceOffset) > 0, 'embedded icon/version resources');
console.log('Package structure, runtime versions, licenses and GUI PE resources validated.');
