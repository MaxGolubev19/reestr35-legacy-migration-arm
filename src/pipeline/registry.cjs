'use strict';
const { CaptureQaStage } = require('../stages/capture-qa/index.cjs');
// Composition boundary: one real stage today, no invented future state schema.
function createStage(queue, options) { return new CaptureQaStage(queue, options); }
module.exports = { createStage };
