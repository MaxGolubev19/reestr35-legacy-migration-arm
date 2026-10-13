'use strict';
const { dataRoot } = require('./data-dir.cjs');
const { PageQueue } = require('./pipeline/queue.cjs');
const { createStage } = require('./pipeline/registry.cjs');
const { createServer } = require('./http/server.cjs');
const { acquireLock, createShutdownController } = require('./infrastructure/server-lifecycle.cjs');
const { PageBuilderStore } = require('./stages/page-builder/store.cjs');
const { MediaPicker } = require('./stages/page-builder/media-picker.cjs');
const { FramePicker } = require('./stages/page-builder/frame-picker.cjs');
const { DocumentPicker } = require('./stages/page-builder/document-picker.cjs');
const { BegetSync } = require('./stages/beget/sync.cjs');

// Public Queue API remains compatible while the page scheduler owns no stage implementation.
class Queue extends PageQueue {
  constructor(options = {}) {
    super({ ...options, stageFactory: options.stageFactory || createStage }); this.pageBuilder = options.pageBuilder || new PageBuilderStore(this.root, jobId => this.get(jobId));
    this.mediaPicker = new MediaPicker(this);
    this.framePicker = new FramePicker(this);
    this.documentPicker = new DocumentPicker(this);
    // Capture-only stage factories remain supported. If media is installed,
    // its deletion guard and recovery are mandatory (not optional methods).
    this.pageBuilder.assertWritable = () => this.stage.media?.deletion.assertReady();
    this.pageBuilder.validateMedia = (...args) => { this.mediaPicker.validateDocument(...args); this.framePicker.validateDocument(...args); this.documentPicker.validateDocument(...args); };
    // Bind legacy pages before any subsequent retry can change the latest attempt.
    for (const job of this.jobs) { try { this.pageBuilder.migrateLegacy(job.id); } catch { /* surfaced by the page summary; retry also refuses incomplete migration */ } }
    this.stage.media?.deletion.recoverAll();
    if (options.beget !== false) { this.beget = new BegetSync(this, options.beget || {}); this.pageBuilder.sync = this.beget; }
  }
  retry(id) { this.stage.media?.deletion.assertReady(); this.pageBuilder.migrateLegacy(id); return super.retry(id); }
  async shutdown() {
    const pickerStopped = this.mediaPicker.shutdown();
    const syncStopped = this.beget?.shutdown();
    try { await super.shutdown(); } finally { await pickerStopped; await syncStopped; }
  }
  snapshot(csrfToken) { const result = super.snapshot(csrfToken); if (this.beget) result.beget = this.beget.snapshot(); return result; }
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
    const { resolveRuntime } = require('./infrastructure/runtime.cjs');
    const { resolveZcodeLaunch } = require('./stages/capture-qa/qa/config.cjs');
    // QA transport is resolved best-effort: capture, page builder and sync keep
    // working without ZCode credentials; QA attempts fail with this message.
    let zcode = null, zcodeError = null;
    try { zcode = resolveZcodeLaunch(process.env, { node: resolveRuntime().node, root }); }
    catch (error) { zcodeError = error.message; console.error(`QA-агент ZCode недоступен: ${zcodeError}`); }
    const queue = new Queue({ root, concurrency: Number(process.env.ARM_CONCURRENCY || 2), zcode, autoStart: false });
    queue.zcodeError = zcodeError;
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
