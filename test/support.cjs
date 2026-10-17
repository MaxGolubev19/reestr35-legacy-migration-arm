'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { dataSubdir } = require('../src/data-dir.cjs');
function testTempRoot() { return dataSubdir('test-temp'); }
function testOutput() { return dataSubdir('test-output'); }
// Recursive copy over plain reads/writes: the test tree can live behind sync
// filters (OneDrive) where CopyFile-based fs.cpSync fails or crashes outright.
function copyTree(source, destination) {
  if (fs.statSync(source).isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, fs.readFileSync(source));
    return;
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile()) fs.writeFileSync(path.join(destination, entry.name), fs.readFileSync(path.join(source, entry.name)));
    else if (entry.isDirectory()) copyTree(path.join(source, entry.name), path.join(destination, entry.name));
  }
}
module.exports = { testTempRoot, testOutput, copyTree };
