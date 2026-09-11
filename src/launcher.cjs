'use strict';
// Stable trusted process wrapper CLI and CommonJS entrypoint.
const launcher = require('./infrastructure/launcher.cjs');
module.exports = launcher;
if (require.main === module) launcher.run(process.argv[2], process.argv[3]).then(code => { process.exitCode = code; }).catch(error => { console.error(error.stack); process.exitCode = 1; });
