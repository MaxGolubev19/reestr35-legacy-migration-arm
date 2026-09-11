'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../../../infrastructure/hash.cjs');
const { atomicJson, readJson, safeFile } = require('../../../infrastructure/files.cjs');
const { readPng } = require('./png.cjs');
const { captureInventory, captureCoverage } = require('./artifacts.cjs');

const checkpointPath = directory => path.join(directory, 'capture-checkpoint.json');
function capturePlan(report, settings) {
  const coverage = captureCoverage(captureInventory({ ...report, segments: [] }), []);
  const invalid = coverage.issues.filter(issue => !issue.startsWith('Отсутствует сегмент:'));
  if (invalid.length || !coverage.expected.length) throw new Error('Invalid capture plan: ' + invalid.join('; '));
  return { model: report.model, viewport: report.viewport, finalUrl: report.finalUrl, settings, segments: coverage.expected };
}
function commitCheckpoint(directory, identity, plan, report) {
  const data = { version: 1, identity, plan, planHash: hash(plan), completed: report.segments.length, report };
  const checkpoint = { ...data, hash: hash(data) };
  atomicJson(checkpointPath(directory), checkpoint);
  return checkpoint;
}
function readCheckpoint(directory, identity, currentPlan, { allowNextOrphan = false } = {}) {
  const checkpoint = readJson(safeFile(directory, checkpointPath(directory)));
  const { hash: checksum, ...data } = checkpoint;
  const fail = message => { throw new Error('Capture checkpoint: ' + message); };
  if (data.version !== 1 || hash(data) !== checksum || hash(data.identity) !== hash(identity)) fail('повреждён или принадлежит другой попытке');
  if (hash(data.plan) !== data.planHash || (currentPlan && hash(currentPlan) !== data.planHash)) fail('структура страницы или план изменились');
  const { report, plan, completed } = data;
  if (!report || !Array.isArray(report.segments) || !Number.isInteger(completed) || completed < 0 || completed !== report.segments.length || completed > plan.segments.length || report.url !== identity.url || report.finished || !Array.isArray(report.errors) || report.errors.length) fail('некорректный прогресс');
  if (hash(capturePlan(report, plan.settings)) !== data.planHash) fail('план не соответствует отчёту');
  const names = [];
  for (let index = 0; index < completed; index++) {
    const entry = report.segments[index], expected = plan.segments[index];
    if (!entry || hash(entry.spec) !== hash(expected.spec) || hash(entry.chain) !== hash(expected.chain)) fail('нарушен порядок сегментов');
    if (entry.status === 'absent') {
      if (!expected.optional || !entry.absent || entry.meaningful !== 0 || entry.file || entry.png) fail('неподтверждённый absent');
      continue;
    }
    if (!['ok', 'incomplete'].includes(entry.status) || entry.file !== expected.name || entry.absent || !entry.png || !entry.box || (expected.empty && !entry.empty)) fail('некорректный завершённый сегмент');
    const png = readPng(safeFile(directory, path.join(directory, entry.file))).png;
    if (!['bytes', 'sha256', 'width', 'height'].every(key => png[key] === entry.png[key]) || !['width', 'height'].every(key => png[key] === entry.box[key])) fail('PNG подменён, повреждён или изменил размеры: ' + entry.file);
    names.push(entry.file);
  }
  const confirmed = names.sort();
  const actual = fs.readdirSync(directory).filter(name => /\.png$/i.test(name)).sort();
  let orphan = null;
  if (allowNextOrphan && completed < plan.segments.length) {
    const next = plan.segments[completed];
    const expectedWithOrphan = next?.name ? [...confirmed, next.name].sort() : [];
    if (expectedWithOrphan.length && hash(actual) === hash(expectedWithOrphan)) orphan = next.name;
  }
  if (!orphan && hash(actual) !== hash(confirmed)) fail('неучтённые или отсутствующие PNG');
  return orphan ? { ...checkpoint, orphan } : checkpoint;
}
function captureIdentity(directory, url, attemptId = directory) {
  return { directory: fs.realpathSync(directory), url: new URL(url).href, attemptId };
}
module.exports = { checkpointPath, capturePlan, commitCheckpoint, readCheckpoint, captureIdentity };
