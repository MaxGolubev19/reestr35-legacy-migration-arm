'use strict';
const { dataRoot } = require('./data-dir.cjs');
const { PageQueue } = require('./pipeline/queue.cjs');
const { createStage } = require('./pipeline/registry.cjs');
const { createServer } = require('./http/server.cjs');
const { acquireLock, createShutdownController } = require('./infrastructure/server-lifecycle.cjs');

// Public Queue API remains compatible while the page scheduler owns no stage implementation.
class Queue extends PageQueue {
  constructor(options = {}) { super({ ...options, stageFactory: options.stageFactory || createStage }); }
  get reviewListeners() { return this.listenersFor('qa-review'); }
  set reviewListeners(listeners) { this.listeners.set('qa-review', listeners); }
  subscribeReviews(listener) { return this.subscribe('qa-review', listener); }
  notifyReviewAccepted(event) { return this.emit('qa-review', event); }
  qaState(...args) { return this.stage.qaState(...args); }
  launchFinished(...args) { return this.stage.launchFinished(...args); }
  ownsLaunch(...args) { return this.stage.ownsLaunch(...args); }
  ownsStopCompletion(...args) { return this.stage.ownsStopCompletion(...args); }
  confirmStopped(...args) { return this.stage.confirmStopped(...args); }
  refreshArtifacts(...args) { return this.stage.refreshArtifacts(...args); }
  outcome(...args) { return this.stage.outcome(...args); }
  canContinueQa(...args) { return this.stage.canContinueQa(...args); }
  ['continue-qa'](...args) { return this.stage['continue-qa'](...args); }
  queueQa(...args) { return this.stage.queueQa(...args); }
  recoverQa(...args) { return this.stage.recoverQa(...args); }
  launchQa(...args) { return this.stage.launchQa(...args); }
}

if (require.main === module) {
  let unlock;
  try {
    const root = dataRoot();
    unlock = acquireLock(root);
    const port = Number(process.env.ARM_PORT || 4318);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ARM_PORT должен быть 1–65535');
    const queue = new Queue({ root, concurrency: Number(process.env.ARM_CONCURRENCY || 2), codex: process.env.ARM_CODEX_EXE || 'codex', autoStart: false });
    let stop;
    const server = createServer(queue, { onShutdown: () => stop() });
    stop = createShutdownController({ queue, server, unlock });
    server.on('error', error => { console.error(error.message); void stop(1); });
    server.listen(port, '127.0.0.1', () => {
      console.log(`АРМ: http://127.0.0.1:${port} (параллельность ${queue.concurrency})`);
      queue.autoStart = true; queue.pump();
    });
    process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); }); process.on('exit', unlock);
  } catch (error) { console.error(error.message); if (unlock) unlock(); process.exitCode = 1; }
}
module.exports = { Queue, createServer, acquireLock, createShutdownController };
