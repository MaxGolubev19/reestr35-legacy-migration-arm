'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { APP_ROOT } = require('../data-dir.cjs');
function resolveRuntime() {
  const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node');
  const bundledNode = path.join(bundled, 'bin', 'node.exe');
  const explicit = process.env.ARM_RUNTIME_DIR;
  const localModules = path.join(APP_ROOT, 'node_modules');
  const node = explicit ? path.join(explicit, 'node.exe') : fs.existsSync(localModules) ? process.execPath : fs.existsSync(bundledNode) ? bundledNode : process.execPath;
  const modules = explicit ? path.join(explicit, 'node_modules') : fs.existsSync(localModules) ? localModules : process.env.NODE_PATH || (fs.existsSync(path.join(bundled, 'node_modules')) ? path.join(bundled, 'node_modules') : '');
  if (explicit && (!path.isAbsolute(explicit) || !fs.existsSync(node) || !fs.existsSync(modules))) throw new Error('Invalid ARM_RUNTIME_DIR: ' + explicit);
  const chrome = process.env.ARM_CHROME_EXE || [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')]
    .map(base => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(file => fs.existsSync(file));
  const env = { ...process.env, NODE_PATH: modules };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = path.dirname(node) + path.delimiter + (env[pathKey] || '');
  return { node, modules, chrome, env };
}

module.exports = { resolveRuntime };
