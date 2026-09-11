'use strict';
// Trusted process wrapper. Recovery needs an exclusive never-started claim or
// confirmed death of both recorded processes; heartbeat expiry alone is not proof.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { atomicJson } = require('./qa.cjs');
const { readJson, safeFile } = require('./lib.cjs');
function readLaunch(dir) {
  const file = path.join(dir, 'launch-current.json');
  if (!fs.existsSync(file)) return null;
  const launch = readJson(safeFile(dir, file));
  if (!/^[a-f0-9-]{36}$/.test(launch.token) || !Number.isInteger(launch.generation) || launch.generation < 1 || !['capture', 'qa'].includes(launch.phase)) throw new Error('Некорректная launch identity');
  return launch;
}
function leasePath(dir, launch) { return path.join(dir, `launch-${launch.token}-lease.json`); }
function claimLaunch(dir, launch, owner) {
  // Launcher and recovery compete for this one atomic claim. A delayed launcher
  // cannot start its target after recovery has declared a missing lease abandoned.
  fs.writeFileSync(path.join(dir, `launch-${launch.token}-claim.json`), JSON.stringify({ token: launch.token, generation: launch.generation, owner, pid: process.pid }), { flag: 'wx' });
}
function readLease(dir, launch) {
  const lease = readJson(safeFile(dir, leasePath(dir, launch)));
  if (lease.token !== launch.token || lease.generation !== launch.generation || !['running', 'finished'].includes(lease.status)) throw new Error('Lease не принадлежит текущему запуску');
  return lease;
}
function publishLease(dir, launch, fields) {
  const current = readLaunch(dir);
  if (current?.token !== launch.token || current.generation !== launch.generation) throw new Error('Запуск потерял launch lease');
  atomicJson(leasePath(dir, launch), { token: launch.token, generation: launch.generation, ...fields, heartbeat: new Date().toISOString() });
}
function recoverLease(dir, launch, { timestamp, graceMs, isPidAlive }) {
  const createdAtMs = Number.isFinite(launch.createdAtMs) ? launch.createdAtMs : fs.statSync(path.join(dir, 'launch-current.json')).mtimeMs;
  if (timestamp - createdAtMs < graceMs) return false;
  const file = leasePath(dir, launch);
  if (!fs.existsSync(file)) {
    if (launch.leaseProtocol !== 2) return false; // old launchers lack the exclusive claim fence
    try { claimLaunch(dir, launch, 'never-started-recovery'); }
    catch {
      const claimFile = path.join(dir, `launch-${launch.token}-claim.json`);
      const claim = readJson(safeFile(dir, claimFile));
      if (claim.token !== launch.token || claim.generation !== launch.generation) return false;
      // A recovery process may itself die after winning the claim but before
      // writing finished. Its persistent tombstone already excludes a launcher.
      if (claim.owner !== 'never-started-recovery' && (claim.owner !== 'wrapper' || !Number.isInteger(claim.pid) || claim.pid < 1 || isPidAlive(claim.pid))) return false;
      // Check again after proving the owner dead: it may have published running
      // between our first read and its exit, and then its target must be checked.
      if (fs.existsSync(file)) return recoverLease(dir, launch, { timestamp, graceMs, isPidAlive });
    }
    publishLease(dir, launch, { status: 'finished', proof: 'never-started', finishedAt: new Date(timestamp).toISOString() });
    return true;
  }
  const lease = readLease(dir, launch); // corrupt/foreign leases must not be repaired
  const wrapperPid = lease.wrapperPid ?? lease.pid;
  if (lease.status === 'running' && Number.isInteger(wrapperPid) && wrapperPid > 0 && Number.isInteger(lease.childPid) && lease.childPid > 0 &&
      !isPidAlive(wrapperPid) && !isPidAlive(lease.childPid)) {
    publishLease(dir, launch, { ...lease, status: 'finished', proof: 'abandoned-both-pids-dead', finishedAt: new Date(timestamp).toISOString() });
    return true;
  }
  return lease.status === 'finished';
}
function launchWorker(command, args, config) {
  const { armLaunch, ...options } = config;
  return spawn(process.execPath, [__filename, armLaunch.descriptor, armLaunch.token], options);
}
async function run(descriptor, token) {
  const dir = path.dirname(descriptor), spec = readJson(safeFile(dir, descriptor)), launch = readLaunch(dir);
  if (spec.token !== token || launch?.token !== token || launch.generation !== spec.generation) throw new Error('Устаревший launcher');
  claimLaunch(dir, launch, 'wrapper');
  // Publish wrapper PID before spawning the target. If the wrapper dies in any
  // later spawn window, running/missing lease remains uncertain and blocks reuse.
  const state = { status: 'running', pid: process.pid, wrapperPid: process.pid, childPid: null };
  publishLease(dir, launch, state);
  let child;
  try { child = spawn(spec.command, spec.args, { cwd: spec.cwd, shell: false, windowsHide: true, stdio: 'inherit' }); }
  catch (error) { publishLease(dir, launch, { ...state, status: 'finished', exitCode: 1, error: error.message }); return 1; }
  state.childPid = child.pid || null;
  publishLease(dir, launch, state);
  const timer = setInterval(() => { try { publishLease(dir, launch, state); } catch { /* Preserve the last durable lease; never invent completion. */ } }, 1000);
  let error;
  child.once('error', value => { error = value.message; });
  return new Promise((resolve, reject) => child.once('close', (exitCode, signal) => {
    clearInterval(timer);
    try { publishLease(dir, launch, { ...state, status: 'finished', exitCode, signal, ...(error ? { error } : {}), finishedAt: new Date().toISOString() }); }
    catch (failure) { reject(failure); return; }
    resolve(Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : 1);
  }));
}
if (require.main === module) run(process.argv[2], process.argv[3]).then(code => { process.exitCode = code; }).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { readLaunch, readLease, publishLease, recoverLease, launchWorker, run };
