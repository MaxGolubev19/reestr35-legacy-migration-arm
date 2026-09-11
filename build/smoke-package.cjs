'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(process.argv[2]);
const watchdog = setTimeout(() => { console.error('Packaged smoke did not complete'); process.exit(1); }, 60000);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function exited(child, timeout = 15000) {
  const end = Date.now() + timeout;
  while (child.exitCode === null && Date.now() < end) await wait(100);
  assert.notEqual(child.exitCode, null, 'launcher must exit'); return child.exitCode;
}
(async () => {
 const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ARM smoke Кириллица '));
 const data = path.join(sandbox, 'Reestr35 ARM'), profile = path.join(sandbox, 'empty-profile');
 fs.mkdirSync(profile); const port = await freePort();
 const fakeCodex = path.join(sandbox, 'OpenAI/Codex/bin/fake-install/codex.exe');
 const fakeChrome = path.join(sandbox, 'Google/Chrome/Application/chrome.exe');
 for (const file of [fakeCodex, fakeChrome]) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.copyFileSync(path.join(root,'runtime/node.exe'),file); }
 const env = { ...process.env };
 for (const key of Object.keys(env)) if (['NODE_PATH', 'NODE_OPTIONS', 'ARM_DATA_DIR', 'ARM_RUNTIME_DIR', 'ARM_CODEX_EXE', 'ARM_CHROME_EXE', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PATH', 'ARM_PORT', 'ARM_NO_BROWSER'].includes(key.toUpperCase())) delete env[key];
 Object.assign(env, { LOCALAPPDATA: sandbox, USERPROFILE: profile, HOME: profile, ProgramFiles: profile, 'ProgramFiles(x86)': profile, ARM_CHROME_EXE: fakeChrome, ARM_PORT: String(port), ARM_NO_BROWSER: '1', PATH: path.join(process.env.SystemRoot, 'System32') });
 const children = [];
 const launch = () => { const child = spawn(path.join(root, 'Reestr35 ARM.exe'), [], { cwd: sandbox, env, windowsHide: true, stdio: 'ignore' }); children.push(child); return child; };
 try {
  const deps = spawnSync(path.join(root, 'runtime/node.exe'), ['-e', "const p=require('path');const r=process.argv[1];const s=require(p.join(r,'node_modules/sharp'));require(p.join(r,'node_modules/playwright'));s({create:{width:2,height:2,channels:4,background:'#fff'}}).png().toBuffer().then(b=>{if(b.length<10)process.exit(2)});", path.join(root,'runtime')], { env, cwd: sandbox, encoding: 'utf8', windowsHide: true });
  assert.equal(deps.status, 0, deps.stderr);
  console.log('Native dependencies loaded.');
  const first = launch(); let state;
  for (let i = 0; i < 200; i++) { try { state = JSON.parse(fs.readFileSync(path.join(data,'launcher.json'),'utf8')); break; } catch {} await wait(100); }
  assert(state, 'launcher publishes readiness');
  console.log('Launcher ready.');
  const health = await (await fetch(state.URL + '/api/health')).json(); assert.equal(health.instance, state.Instance);
  const second = launch(); assert.equal(await exited(second), 0);
  assert.equal(first.exitCode, null, 'owner observes backend');
  assert.equal((await (await fetch(state.URL + '/api/health')).json()).pid, health.pid, 'second launch reuses backend');
  const snapshot = await (await fetch(state.URL + '/api/state')).json();
  const shutdown = await fetch(state.URL + '/api/shutdown', { method: 'POST', headers: { 'Content-Type':'application/json', 'X-CSRF-Token':snapshot.csrfToken, Origin:state.URL, 'Sec-Fetch-Site':'same-origin' }, body:'{}' });
  assert.equal(shutdown.status, 200); assert.equal(await exited(first), 0);
  console.log('Repeat launch and UI shutdown passed.');
  assert(!fs.existsSync(path.join(data,'launcher.json'))); assert(!fs.existsSync(path.join(data,'server.lock')));
  assert(!fs.existsSync(path.join(root,'local')), 'package directory stays immutable');
  // An unrelated service occupying the port must never be mistaken for ARM.
  const occupied = net.createServer(socket => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'));
  await new Promise(r => occupied.listen(port,'127.0.0.1',r));
  try { assert.equal(await exited(launch()), 1); } finally { occupied.close(); }
  const logs = fs.readdirSync(path.join(data,'logs')).map(f => fs.readFileSync(path.join(data,'logs',f),'utf8')).join('\n');
  assert.match(logs, /EADDRINUSE/);
  assert(logs.includes('Codex CLI: ' + fakeCodex), 'Codex desktop installation discovered without PATH');
  assert(logs.includes('Chrome: ' + fakeChrome), 'Chrome preflight validates the selected executable');
  fs.unlinkSync(fakeCodex);
  assert.equal(await exited(launch()), 1, 'missing Codex fails before backend startup');
  fs.copyFileSync(path.join(root,'runtime/node.exe'),fakeCodex); fs.unlinkSync(fakeChrome);
  assert.equal(await exited(launch()), 1, 'missing Chrome fails before backend startup');
  const preflightLogs = fs.readdirSync(path.join(data,'logs')).map(f => fs.readFileSync(path.join(data,'logs',f),'utf8')).join('\n');
  assert.match(preflightLogs, /Codex CLI was not found/); assert.match(preflightLogs, /ARM_CHROME_EXE does not point to an existing Chrome executable/);
  assert(!fs.existsSync(path.join(data,'server.lock'))); assert(!fs.existsSync(path.join(data,'launcher.json')));
  console.log('Packaged smoke passed: isolated runtime, native sharp, Codex discovery, dependency preflight failures, readiness, repeat launch, UI shutdown, occupied-port failure.');
 } finally {
  for (const child of children) if (child.exitCode === null) spawnSync(path.join(process.env.SystemRoot,'System32/taskkill.exe'), ['/pid',String(child.pid),'/T','/F'], { windowsHide:true });
  fs.rmSync(sandbox, { recursive:true, force:true });
 }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
