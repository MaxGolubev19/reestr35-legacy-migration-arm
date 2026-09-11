'use strict';
const path = require('node:path');
function attemptDir(root, job, attempt) {
  return path.join(root, 'runs', job.id, `attempt-${String(attempt.number).padStart(3, '0')}`);
}
module.exports = { attemptDir };
