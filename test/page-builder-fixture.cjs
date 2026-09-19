'use strict';
const fs = require('node:fs');
const { sourceData } = require('../src/stages/page-builder/store.cjs');

function seedMoriPage(queue, job) {
  queue.pageBuilder.read(job.id);
  fs.writeFileSync(queue.pageBuilder.file(job.id), JSON.stringify({
    revision: 1, updatedAt: new Date().toISOString(), document: sourceData()
  }));
}

module.exports = { seedMoriPage };
