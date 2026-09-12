'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), esbuild = require('esbuild');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'public/vendor/editors');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function bundle(check = false) {
  const result = await esbuild.build({ absWorkingDir: root, entryPoints: ['src/ui/editors.js'], bundle: true, format: 'iife', globalName: 'ArmEditors', platform: 'browser', target: ['chrome120'], minify: true, legalComments: 'inline', metafile: true, write: false, outfile: 'public/vendor/editors/editors.js' });
  const files = new Map(result.outputFiles.map(file => [path.basename(file.path), file.contents]));
  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory.startsWith(path.join(root, 'node_modules'))) {
      const name = path.join(directory, 'package.json');
      if (fs.existsSync(name)) { const pkg = JSON.parse(fs.readFileSync(name)); if (pkg.name && pkg.version) { packages.set(pkg.name, { pkg, directory }); break; } }
      directory = path.dirname(directory);
    }
  }
  const components = [];
  // vanilla-jsoneditor's published index already embeds Svelte/Floating UI.
  // Its source map identifies these upstream packages, invisible to esbuild.
  const upstream = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/vanilla-jsoneditor/index.js.map')));
  const embedded = new Set(upstream.sources.filter(source => source.includes('node_modules/')).map(source => { const name = source.split('node_modules/').pop(); return name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/'); }));
  for (const name of embedded) if (!packages.has(name)) { const directory = path.join(root, 'node_modules', name), pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))); packages.set(name, { pkg, directory }); }
  for (const [name, { pkg, directory }] of [...packages].sort(([a],[b]) => a.localeCompare(b, 'en'))) {
    const licenses = fs.readdirSync(directory).filter(file => /^(?:licen[sc]e|copying|notice|third-party-notices)(?:[.-]|$)/i.test(file) && fs.statSync(path.join(directory, file)).isFile()).sort();
    if (!licenses.length) throw new Error(`Missing license: ${name}`);
    const names = licenses.map(file => { const name = `licenses/${pkg.name.replaceAll('/', '__')}-${file}`; files.set(name, fs.readFileSync(path.join(directory, file))); return name; });
    components.push({ name, version: pkg.version, license: pkg.license, files: names, ...(embedded.has(name) ? { embeddedBy: 'vanilla-jsoneditor@3.13.0', versionNote: 'Pinned license-source package version; upstream prebundled version may differ.' } : {}) });
  }
  const sources = Object.fromEntries(['src/ui/editors.js','build/bundle-editors.cjs','package.json','package-lock.json'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  const manifest = { version: 1, esbuild: esbuild.version, sources, components, files: Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)])) };
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  for (const [name, bytes] of files) {
    const file = path.join(output, name);
    if (check) { if (!fs.existsSync(file) || !Buffer.from(bytes).equals(fs.readFileSync(file))) throw new Error(`Stale editor bundle: ${name}; run npm run build:editors`); }
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  }
  console.log(`${check ? 'Verified' : 'Built'} offline editors: ${components.length} licensed packages, ${files.size} files`);
}
if (require.main === module) bundle(process.argv.includes('--check')).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { bundle };
