'use strict';
// Compatibility exports for persisted capture and QA contracts.
module.exports = {
  ...require('./infrastructure/hash.cjs'), atomicJson: require('./infrastructure/files.cjs').atomicJson,
  paths: require('./stages/capture-qa/paths.cjs').paths,
  ...require('./stages/capture-qa/capture/manifest.cjs'),
  ...require('./stages/capture-qa/qa/policy.cjs'), ...require('./stages/capture-qa/qa/staging.cjs'),
  ...require('./stages/capture-qa/qa/progress.cjs'),
};
