'use strict';
// Stable standalone capture CLI and CommonJS entrypoint.
const helper = require('./stages/capture-qa/capture/helper.cjs');
module.exports = helper;
if (require.main === module) helper.run(helper.parseArgs(process.argv.slice(2))).then(report => { process.exitCode = report.resumeRejected ? 3 : report.status === 'complete' ? 0 : 2; }).catch(error => { console.error(error.stack); process.exitCode = 1; });
