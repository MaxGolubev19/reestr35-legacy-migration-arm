'use strict';
const fs = require('node:fs');
const path = require('node:path');
function createShutdownController({ queue, server, unlock, exitFn = code => process.exit(code),
  waitFn = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = Date.now, timeoutMs = 5000,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let shutdownPromise;
  return (requestedCode = 0) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let exitCode = requestedCode;
      try {
        let shutdownTimer;
        try {
          await Promise.race([
            queue.shutdown(),
            new Promise((_, reject) => {
              shutdownTimer = setTimeoutFn(() => reject(new Error(`Queue.shutdown превысил ${timeoutMs} ms`)), timeoutMs);
            })
          ]);
        } finally { clearTimeoutFn(shutdownTimer); }
        const deadline = clock() + timeoutMs;
        while (queue.active.size && clock() < deadline) await waitFn(100);
        if (queue.active.size) exitCode = 1;
      } catch (error) { console.error('Queue shutdown:', error.message); exitCode = 1; }
      // Even when queue teardown times out, do not release ownership or exit
      // while the native dialog process is still alive. Its adapter completes
      // only after the child close event, never merely after a kill request.
      await queue.mediaPicker?.shutdown();
      try { unlock(); } catch (error) { console.error('Unlock:', error.message); exitCode = 1; }
      try {
        if (server.listening) {
          await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            // EventSource is intentionally long-lived; after queue teardown and
            // lock release, close it and every remaining local HTTP connection.
            server.closeAllConnections?.();
          });
        }
      } catch (error) { console.error('HTTP shutdown:', error.message); exitCode = 1; }
      exitFn(exitCode);
      return exitCode;
    })();
    return shutdownPromise;
  };
}

function acquireLock(root) {
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, 'server.lock');
  try {
    const fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Повреждён server.lock; проверьте отсутствие работающего АРМ');
    try { process.kill(pid, 0); throw new Error(`АРМ уже работает (PID ${pid})`); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    fs.unlinkSync(lock);
    return acquireLock(root);
  }
  return () => { if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); };
}

module.exports = { createShutdownController, acquireLock };
