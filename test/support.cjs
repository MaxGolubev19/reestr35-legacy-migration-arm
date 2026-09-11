'use strict';
const { dataSubdir } = require('../src/data-dir.cjs');
function testTempRoot() { return dataSubdir('test-temp'); }
function testOutput() { return dataSubdir('test-output'); }
module.exports = { testTempRoot, testOutput };
