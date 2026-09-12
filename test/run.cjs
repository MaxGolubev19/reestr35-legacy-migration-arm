'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { dataRoot, dataSubdir } = require('../src/data-dir.cjs');
const { resolveRuntime } = require('../src/lib.cjs');

const suites = {
  full: ['architecture', 'arm', 'duration', 'qa', 'app-server', 'html-media', 'ui', 'capture', 'capture-resume', 'portability', 'cli-isolation'],
  backend: ['architecture', 'arm', 'duration', 'qa', 'app-server', 'html-media'],
  'html-media': ['html-media'],
  ui: ['ui'], capture: ['capture', 'capture-resume'], portability: ['portability'], cli: ['cli-isolation'],
};
function configuration(suite = 'full', environment = process.env) {
  if (!Object.hasOwn(suites, suite)) throw new Error(`Unknown test suite: ${suite}`);
  const runtime = resolveRuntime();
  const root = dataRoot(environment), temp = dataSubdir('tmp', root);
  const env = { ...runtime.env, ...environment, TMP: temp, TEMP: temp, TMPDIR: temp };
  // Pass the environment before Node workers import Playwright: its temporary
  // browser profiles and artifacts must use the same portable data directory.
  return { command: runtime.node, args: ['--test', ...suites[suite].map(name => path.join(__dirname, `${name}.test.cjs`))],
    options: { cwd: path.join(__dirname, '..'), env, windowsHide: true, stdio: 'inherit' } };
}
if (require.main === module) {
  const config = configuration(process.argv[2]);
  const result = spawnSync(config.command, config.args, config.options);
  if (result.error) { console.error(result.error.message); process.exitCode = 1; }
  else process.exitCode = result.status ?? 1;
}
module.exports = { configuration };
