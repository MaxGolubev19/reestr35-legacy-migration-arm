'use strict';
const { Workflow } = require('../stages/workflow.cjs');
function createStage(queue, options) { return new Workflow(queue, options); }
module.exports = { createStage };
