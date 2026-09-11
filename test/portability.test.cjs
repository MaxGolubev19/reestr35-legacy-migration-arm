'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { APP_ROOT, dataRoot } = require('../src/data-dir.cjs');
const { acquireLock } = require('../src/server.cjs');
const { testTempRoot } = require('./support.cjs');
const { configuration } = require('./run.cjs');

test('data root is anchored to the application and supports an optional override', () => {
  assert.equal(APP_ROOT, path.resolve(__dirname, '..'));
  assert.equal(dataRoot({}), path.resolve(__dirname, '../local'));
  const app = path.resolve('portable-fixture');
  assert.equal(dataRoot({}, app), path.join(app, 'local'));
  assert.equal(dataRoot({ ARM_DATA_DIR: '   ' }, app), path.join(app, 'local'));
  assert.equal(dataRoot({ ARM_DATA_DIR: 'custom-data' }, app), path.join(app, 'custom-data'));
  const absolute = path.resolve('another-data');
  assert.equal(dataRoot({ ARM_DATA_DIR: absolute }, app), absolute);
});

test('start.ps1 creates logs under relative and absolute data roots from a foreign cwd', t => {
  const sandbox = fs.mkdtempSync(path.join(testTempRoot(), 'portable-start-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const app = path.join(sandbox, 'app'), foreign = path.join(sandbox, 'foreign');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(foreign);
  fs.copyFileSync(path.join(__dirname, '..', 'start.ps1'), path.join(app, 'start.ps1'));
  fs.writeFileSync(path.join(app, 'src', 'server.cjs'), "console.log(JSON.stringify({root:process.env.ARM_DATA_DIR,cwd:process.cwd()}));\n");

  const roots = [path.join(app, 'relative-data'), path.join(sandbox, 'absolute-data')];
  for (const [index, override] of ['relative-data', roots[1]].entries()) {
    const root = roots[index];
    assert.equal(fs.existsSync(path.join(root, 'logs')), false);
    assert.equal(fs.existsSync(path.join(root, 'qa-servers')), false);
    const env = { ...process.env, ARM_DATA_DIR: override, ARM_CODEX_EXE: 'fixture' };
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-File', path.join(app, 'start.ps1')],
      { cwd: foreign, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const logs = path.join(root, 'logs');
    assert.equal(fs.existsSync(path.join(root, 'qa-servers')), false);
    assert.equal(fs.existsSync(logs), true);
    assert.equal(fs.readdirSync(root).some(name => /^server-.*\.log$/.test(name)), false);
    const logFiles = fs.readdirSync(logs).filter(name => /^server-.*\.log$/.test(name));
    assert.equal(logFiles.length, 1);
    const record = JSON.parse(fs.readFileSync(path.join(logs, logFiles[0]), 'utf8').trim());
    assert.equal(record.root, root);
    assert.equal(record.cwd, foreign);
  }
});

test('standalone application starts clean and captures with its bundled helper from a foreign cwd', t => {
  const sandbox = fs.mkdtempSync(path.join(testTempRoot(), 'portable-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const app = path.join(sandbox, 'app'), foreign = path.join(sandbox, 'foreign');
  fs.mkdirSync(app); fs.mkdirSync(foreign);
  for (const name of fs.readdirSync(path.join(__dirname, '..'))) {
    if (name === 'local' || name === 'test' || name === '.git') continue;
    fs.cpSync(path.join(__dirname, '..', name), path.join(app, name), { recursive: true });
  }
  assert.equal(fs.existsSync(path.join(app, 'local')), false);
  const script = `
    const fs=require('node:fs'),path=require('node:path');
    const {Queue,acquireLock}=require(process.argv[1]);
    let spawned;
    const queue=new Queue({autoStart:false,spawnFn(command,args,config){spawned={command,args,cwd:config.cwd,temp:config.env.TEMP};throw Error('fixture-no-launch');}});
    const initial=queue.jobs.length,unlock=acquireLock(queue.root);
    queue.add('https://portable.reestr35.ru');queue.pump();unlock();
    queue.shutdown().then(()=>console.log(JSON.stringify({initial,root:queue.root,workspace:queue.workspace,spawned,status:queue.jobs[0].attempts[0].status})));
  `;
  const env = { ...process.env }; delete env.ARM_DATA_DIR;
  for (const override of [undefined, 'separate-data']) {
    if (override) env.ARM_DATA_DIR = override;
    const result = spawnSync(process.execPath, ['-e', script, path.join(app, 'src', 'server.cjs')], { cwd: foreign, env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout), root = path.join(app, override || 'local');
    assert.equal(state.initial, 0); assert.equal(state.root, root); assert.equal(state.workspace, app);
    assert.equal(state.spawned.args[0], path.join(app, 'src', 'capture.cjs'));
    assert.equal(state.spawned.args[4].startsWith(path.join(root, 'runs') + path.sep), true);
    assert.equal(state.spawned.temp, path.join(root, 'tmp'));
    assert.equal(fs.existsSync(path.join(root, 'state.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'server.lock')), false);
    assert.equal(state.status, 'failed');
  }
  assert.deepEqual(fs.readdirSync(foreign), []);
});

test('lock acquisition creates a missing data directory and rejects a live owner', t => {
  const sandbox = fs.mkdtempSync(path.join(testTempRoot(), 'portable-lock-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'absent', 'local'), unlock = acquireLock(root);
  try { assert.throws(() => acquireLock(root), /уже работает/); }
  finally { unlock(); }
  assert.equal(fs.existsSync(path.join(root, 'server.lock')), false);
});

test('test runner overrides ambient temp paths before Playwright creates its browser profile', t => {
  const sandbox = fs.mkdtempSync(path.join(testTempRoot(), 'runner-env-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'custom-data');
  const config = configuration('capture', { ...process.env, ARM_DATA_DIR: root, TMP: 'unused-ambient', TEMP: 'unused-ambient', TMPDIR: 'unused-ambient' });
  const expected = path.join(root, 'tmp');
  assert.equal(config.options.env.TMP, expected); assert.equal(config.options.env.TEMP, expected); assert.equal(config.options.env.TMPDIR, expected);
  const script = `
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const {chromium}=require('playwright');
    (async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});
      try {console.log(JSON.stringify({tmp:os.tmpdir(),profiles:fs.readdirSync(process.env.TEMP).filter(name=>name.startsWith('playwright_chromiumdev_profile-')).map(name=>path.join(process.env.TEMP,name))}));}
      finally {await browser.close();}
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const result = spawnSync(config.command, ['-e', script], { ...config.options, stdio: 'pipe', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.tmp, expected); assert.equal(observed.profiles.length, 1);
  assert.equal(path.dirname(observed.profiles[0]), expected);
});
