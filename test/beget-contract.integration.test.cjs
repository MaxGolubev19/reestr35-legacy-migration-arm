'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BLOCK_TYPES } = require('../src/stages/page-builder/store.cjs');

const enabled = process.env.ARM_TEST_BEGET_CONTRACT === '1';
const snapshot = path.resolve(__dirname, '../src/resources/company-block-contract.v1.json');
test('portable block catalog matches the current Beget contract 1.0', {
  skip: enabled ? false : 'Opt in with node test/run.cjs beget-contract; the Beget checkout is external to ARM.'
}, () => {
  const source = process.env.ARM_TEST_BEGET_CONTRACT_FILE ||
    path.resolve(__dirname, '../../../Beget/website/local/php_interface/config/company-block-contract.v1.json');
  assert.ok(fs.existsSync(source), `Beget contract requested but not found: ${source}`);
  // The bundled snapshot must stay a byte-identical copy of the site contract.
  assert.deepEqual(fs.readFileSync(snapshot), fs.readFileSync(source), 'src/resources/company-block-contract.v1.json diverged from the Beget checkout');
  const contract = JSON.parse(fs.readFileSync(source, 'utf8'));
  assert.equal(contract.version, '1.0');
  const fields = ({ name, id, views, default_view }) => ({ name, id, views, default_view });
  assert.deepEqual(BLOCK_TYPES.map(fields), contract.types.map(fields));
});
