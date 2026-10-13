'use strict';
// Compatibility exports. New modules depend on their owning layers directly.
const { safeFile, readJson, stableRead } = require('./infrastructure/files.cjs');
module.exports = {
  ...require('./pipeline/status.cjs'), ...require('./pipeline/url.cjs'),
  safeFile, readJson, stableRead,
  layout: require('./stages/capture-qa/paths.cjs').layout,
  ...(( { buildArgs, qaEnvironment }) => ({ buildArgs, qaEnvironment }))(require('./stages/capture-qa/qa/config.cjs')), ...require('./infrastructure/runtime.cjs'),
  ...require('./compat/legacy-v1.cjs'), ...require('./stages/capture-qa/capture/artifacts.cjs'),
  ...require('./infrastructure/process.cjs'),
};
