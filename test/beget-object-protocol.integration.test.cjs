'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { validateConfig } = require('../src/stages/beget/config.cjs');
const { sshCommand } = require('../src/stages/beget/ssh.cjs');

// PHP is optional locally. A explicitly supplied SSH config uses only PHP stdin:
// the fixture supplies in-memory Bitrix/DB fakes and never loads the live site.
// ARM_TEST_PHP=<php binary> or ARM_TEST_PHP_SSH_CONFIG=<local private config path>
const php = process.env.ARM_TEST_PHP, configFile = process.env.ARM_TEST_PHP_SSH_CONFIG;
test('PHP object protocol: actual journal/transaction flow with in-memory Bitrix adapter', {
  skip: php || configFile ? false : 'Set ARM_TEST_PHP or ARM_TEST_PHP_SSH_CONFIG to run PHP integration.',
}, () => {
  const sourceFile = process.env.ARM_TEST_BEGET_PROTOCOL_FILE || path.resolve(__dirname, '../../../Beget/website/rest/arm_sync.php');
  const source = fs.readFileSync(sourceFile);
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/arm-object-protocol.php'), 'utf8')
    .replace('__ARM_SOURCE_B64__', source.toString('base64'));
  let command = php, args = ['-d', 'display_errors=stderr'];
  if (configFile) {
    const config = validateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
    ({ command, args } = sshCommand(config));
    args[args.length - 1] = `exec '${config.phpBinary}' -d display_errors=stderr`;
  }
  const result = spawnSync(command, args, { input: fixture, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS: object CRUD\/move, ownership, unchanged rows, idempotency\/status, transactional rollback, commit uncertainty, legacy receipts\s*$/);
});
