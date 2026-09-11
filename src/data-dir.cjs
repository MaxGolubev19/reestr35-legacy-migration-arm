'use strict';
const path = require('node:path');
const fs = require('node:fs');

const APP_ROOT = path.resolve(__dirname, '..');

// Relative overrides are anchored to this portable application, never the caller's cwd.
function dataRoot(environment = process.env, appDir = APP_ROOT) {
  const override = environment.ARM_DATA_DIR;
  return path.resolve(appDir, typeof override === 'string' && override.trim() ? override : 'local');
}
function dataSubdir(name, root = dataRoot()) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
module.exports = { APP_ROOT, dataRoot, dataSubdir };
