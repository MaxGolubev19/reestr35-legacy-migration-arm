'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFormatDuration() {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const code = source.match(/function formatDuration\(attempt, timestamp = Date.now\(\)\) \{[\s\S]*?(?=\n  function renderDuration)/)?.[0];
  assert.ok(code, 'the UI formatDuration function remains present');
  return vm.runInNewContext(`${code}; formatDuration`);
}

module.exports = { loadFormatDuration };
