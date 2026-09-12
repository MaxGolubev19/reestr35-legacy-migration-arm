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
for (const file of ['src/server.cjs','src/capture.cjs','src/qa.cjs','src/qa-instructions.txt','src/qa-models.json','public/index.html','public/assets/html-media-in-development.png','runtime/node.exe','runtime/NODE-LICENSE.txt','runtime/ARM-LICENSE.txt','runtime/GO-LICENSE.txt','runtime/node_modules/playwright/LICENSE','runtime/node_modules/sharp/LICENSE']) assert(fs.statSync(path.join(root,file)).isFile(), file);
const moduleFiles = [
  "src/compat/legacy-v1.cjs",
  "src/http/server.cjs",
  "src/infrastructure/files.cjs",
  "src/infrastructure/hash.cjs",
  "src/infrastructure/launcher.cjs",
  "src/infrastructure/process.cjs",
  "src/infrastructure/runtime.cjs",
  "src/infrastructure/server-lifecycle.cjs",
  "src/pipeline/paths.cjs",
  "src/pipeline/queue.cjs",
  "src/pipeline/registry.cjs",
  "src/pipeline/status.cjs",
  "src/pipeline/url.cjs",
  "src/stages/capture-qa/capture/artifacts.cjs",
  "src/stages/capture-qa/capture/helper.cjs",
  "src/stages/capture-qa/capture/manifest.cjs",
  "src/stages/capture-qa/capture/naming.cjs",
  "src/stages/capture-qa/capture/png.cjs",
  "src/stages/capture-qa/capture/runner.cjs",
  "src/stages/capture-qa/index.cjs",
  "src/stages/capture-qa/paths.cjs",
  "src/stages/capture-qa/qa/app-server.cjs",
  "src/stages/capture-qa/qa/config.cjs",
  "src/stages/capture-qa/qa/policy.cjs",
  "src/stages/capture-qa/qa/progress.cjs",
  "src/stages/capture-qa/qa/runner.cjs",
  "src/stages/capture-qa/qa/staging.cjs"
];
for (const file of moduleFiles) assert(fs.statSync(path.join(root, file)).isFile(), file);
const exe = fs.readFileSync(path.join(root,'Reestr35 ARM.exe')), pe = exe.readUInt32LE(0x3c);
assert.equal(exe.readUInt16LE(pe + 4), 0x8664, 'x64');
assert.equal(exe.readUInt16LE(pe + 24 + 68), 2, 'Windows GUI subsystem');
assert.equal(require(path.join(root,'runtime/node_modules/playwright/package.json')).version, '1.62.1');
assert.equal(require(path.join(root,'runtime/node_modules/sharp/package.json')).version, '0.35.4');
for (const [name, version] of [['parse5','7.3.0'],['ipaddr.js','2.2.0'],['postcss-value-parser','4.2.0']]) {
  assert.equal(require(path.join(root, 'runtime/node_modules', name, 'package.json')).version, version);
  assert.ok(fs.readdirSync(path.join(root, 'runtime/node_modules', name)).some(file => /^licen[cs]e/i.test(file)), `${name} license`);
}
for (const file of ['src/stages/workflow.cjs','src/stages/html-media/index.cjs','src/stages/html-media/inventory.cjs','src/stages/html-media/download.cjs','src/resources/domains.json','public/html-media.js','public/modal-actions.js']) assert(fs.statSync(path.join(root, file)).isFile(), file);
const sourceReport = JSON.parse(fs.readFileSync(path.join(root, 'src/resources/import-report.json')));
const editors = JSON.parse(fs.readFileSync(path.join(root, 'public/vendor/editors/manifest.json'))), runtimePackage = JSON.parse(fs.readFileSync(path.join(root, 'runtime/package.json')));
for (const [name, sha] of Object.entries(editors.files)) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, 'public/vendor/editors', name))).digest('hex'), sha, `editor bundle/license: ${name}`);
for (const [name, version] of Object.entries(runtimePackage.devDependencies)) {
  if (name === 'esbuild') assert.equal(editors.esbuild, version);
  else assert.equal(editors.components.find(component => component.name === name)?.version, version, `editor component ${name}`);
}
for (const name of ['src/ui/editors.js','package.json','package-lock.json']) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, name.startsWith('src/') ? name : 'runtime/' + name))).digest('hex'), editors.sources[name], `editor source ${name}`);
for (const component of editors.components) assert.ok(component.files.length && component.files.every(file => editors.files[file]), `bundled licenses: ${component.name}`);
assert.equal(sourceReport.copied.length, 92); assert.equal(sourceReport.missing.length, 33); assert.equal(sourceReport.unmatched.length, 3);
for (const source of sourceReport.copied) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, 'src/resources/html', source.hostname + '.html'))).digest('hex'), source.sha256);
const resourceOffset = pe + 24 + 112 + 16;
assert(exe.readUInt32LE(resourceOffset) > 0, 'embedded icon/version resources');
console.log('Package structure, runtime versions, licenses and GUI PE resources validated.');
