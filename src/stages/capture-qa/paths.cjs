'use strict';
const path = require('node:path');
const { attemptDir } = require('../../pipeline/paths.cjs');
const { slug } = require('./capture/naming.cjs');
function layout(root, job, attempt) {
  const dir = attemptDir(root, job, attempt);
  const output = path.join(dir, 'output');
  const host = slug(new URL(job.url).hostname);
  return { dir, output, hostDir: path.join(output, host), report: path.join(output, host, 'capture-report.json'), final: path.join(dir, 'final.json') };
}

function paths(root, job, attempt) {
  const base = layout(root, job, attempt);
  return { ...base, manifest: path.join(base.dir, 'capture-manifest.json'), progress: path.join(base.dir, 'qa-progress.json') };
}
module.exports = { layout, paths };
