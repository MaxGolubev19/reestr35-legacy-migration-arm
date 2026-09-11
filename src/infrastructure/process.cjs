'use strict';
const { spawn } = require('node:child_process');
function stopTree(child, platform = process.platform, spawnFn = spawn) {
  if (!child?.pid) return Promise.resolve();
  if (platform === 'win32') return new Promise((resolve, reject) => {
    const killer = spawnFn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.once('error', reject);
    killer.once('exit', code => code === 0 ? resolve({ treeStopped: true }) : reject(new Error(`taskkill завершился с кодом ${code}`)));
  });
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') return Promise.reject(error); }
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
  timer.unref();
  return Promise.resolve();
}

module.exports = { stopTree };
