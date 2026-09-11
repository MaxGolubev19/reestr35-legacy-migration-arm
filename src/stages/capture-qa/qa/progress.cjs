'use strict';
const fs = require('node:fs');
const { readJson, safeFile } = require('../../../infrastructure/files.cjs');
const { paths } = require('../paths.cjs');
const { validManifest } = require('../capture/manifest.cjs');
const { QA_POLICY, isCurrentPolicy } = require('./policy.cjs');
function loadQa(root, job, attempt) {
  const p = paths(root, job, attempt);
  if (!fs.existsSync(p.manifest)) return null;
  const manifest = validManifest(readJson(safeFile(root, safeFile(p.dir, p.manifest))), job, attempt);
  const progress = fs.existsSync(p.progress) ? readJson(safeFile(root, safeFile(p.dir, p.progress))) : { version: 2, manifestHash: manifest.hash, generation: 0, checkpoints: [] };
  if (progress.version !== 2 || progress.manifestHash !== manifest.hash || !Number.isInteger(progress.generation) || progress.generation < 0 || !Array.isArray(progress.checkpoints)) throw new Error('Некорректный qa-progress');
  const validPolicy = policy => policy && Number.isInteger(policy.version) && policy.version > 0 && /^[a-f0-9]{64}$/.test(policy.hash);
  if (progress.policy !== undefined && !validPolicy(progress.policy)) throw new Error('Некорректная QA policy progress');
  const namesByPolicy = new Map(), batchIds = new Set(), usedPolicies = new Set(); let generation = 0, identity, priorPolicy;
  for (const checkpoint of progress.checkpoints) {
    const policy = checkpoint.policy;
    if (policy !== undefined && !validPolicy(policy)) throw new Error('Некорректная QA policy checkpoint');
    const policyKey = policy ? `${policy.version}:${policy.hash}` : 'legacy';
    const checkpointGeneration = checkpoint.review ? checkpoint.generation : checkpoint.batch?.generation;
    if (priorPolicy !== policyKey) {
      if (usedPolicies.has(policyKey) || (priorPolicy !== undefined && checkpointGeneration <= generation)) throw new Error('Некорректный переход QA policy');
      usedPolicies.add(policyKey); priorPolicy = policyKey;
    }
    if (!namesByPolicy.has(policyKey)) namesByPolicy.set(policyKey, new Set());
    const names = namesByPolicy.get(policyKey);
    if (checkpoint.review) {
      validateReview(checkpoint.review);
      if (!Number.isInteger(checkpoint.generation) || checkpoint.generation < 1 || checkpoint.generation < generation || checkpoint.generation > progress.generation || typeof checkpoint.threadId !== 'string' || !checkpoint.threadId || typeof checkpoint.turnId !== 'string' || !checkpoint.turnId || checkpoint.manifestHash !== manifest.hash || (checkpoint.generation === generation && identity !== `${checkpoint.threadId}/${checkpoint.turnId}`)) throw new Error('Некорректная identity QA checkpoint');
      const expected = manifest.files.find(f => !names.has(f.name));
      if (!expected || expected.name !== checkpoint.review.name || expected.sha256 !== checkpoint.review.sha256) throw new Error('Нарушен порядок или hash QA checkpoint');
      generation = checkpoint.generation; identity = `${checkpoint.threadId}/${checkpoint.turnId}`; names.add(expected.name); continue;
    }
    // Read-only compatibility for already accepted v2 batch checkpoints.
    validateBatch(checkpoint.batch, checkpoint.result);
    if (checkpoint.batch.manifestHash !== manifest.hash || checkpoint.batch.generation <= generation || checkpoint.batch.generation > progress.generation || batchIds.has(checkpoint.batch.batchId)) throw new Error('Некорректная последовательность QA checkpoints');
    generation = checkpoint.batch.generation; batchIds.add(checkpoint.batch.batchId);
    for (const file of checkpoint.batch.files) {
      const expected = manifest.files.find(f => f.name === file.name);
      if (!expected || expected.sha256 !== file.sha256 || names.has(file.name)) throw new Error('Посторонний или повторный QA checkpoint');
      names.add(file.name);
    }
  }
  if (priorPolicy !== undefined) {
    const activePolicy = progress.policy ? `${progress.policy.version}:${progress.policy.hash}` : 'legacy';
    if ((generation === progress.generation && activePolicy !== priorPolicy) || (activePolicy === 'legacy' && priorPolicy !== 'legacy')) throw new Error('Policy последнего checkpoint не соответствует generation progress');
  }
  return { manifest, progress };
}
function reviews(progress) {
  return new Map(progress.checkpoints.filter(c => isCurrentPolicy(c.policy)).flatMap(c => (c.review ? [c.review] : c.result.files).map(file => [file.name, file])));
}
function segments(manifest, progress) {
  const accepted = reviews(progress);
  return manifest.files.map(file => {
    const review = accepted.get(file.name);
    return { name: file.name, status: review?.sha256 === file.sha256 ? review.status : 'pending' };
  });
}
function counts(manifest, progress) {
  const projected = segments(manifest, progress);
  const passed = projected.filter(file => file.status === 'passed').length;
  const issues = projected.filter(file => file.status === 'issues').length;
  const pending = projected.filter(file => file.status === 'pending').length;
  return { policy: QA_POLICY, historicalReviews: progress.checkpoints.filter(c => !isCurrentPolicy(c.policy)).reduce((count, c) => count + (c.review ? 1 : c.result.files.length), 0), total: projected.length, reviewed: passed + issues, passed, issues, pending, unreviewed: pending, segments: projected };
}
function nextReview(manifest, progress) {
  const accepted = reviews(progress);
  const files = manifest.files.filter(file => !accepted.has(file.name));
  return files.length ? { generation: progress.generation + 1, manifestHash: manifest.hash, policy: QA_POLICY, files } : null;
}
function validateReview(file) {
  const keys = ['issues', 'name', 'sha256', 'status'];
  if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).sort().join('|') !== keys.join('|') || typeof file.name !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !['passed', 'issues'].includes(file.status) || !Array.isArray(file.issues) || !file.issues.every(x => typeof x === 'string' && x.trim().length > 0) || (file.status === 'passed' ? file.issues.length !== 0 : file.issues.length === 0)) throw new Error('Некорректные name/sha256/status/issues record_review');
}
function validateBatch(batch, result) {
  const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === names.sort().join('|');
  if (!batch || !Array.isArray(batch.files) || !batch.files.length || batch.files.length > 5 || !Number.isInteger(batch.generation) || batch.generation < 1 || typeof batch.batchId !== 'string') throw new Error('Некорректный legacy batch');
  if (!keys(result, ['batchId', 'generation', 'manifestHash', 'files', 'summary']) || result.batchId !== batch.batchId || result.generation !== batch.generation || result.manifestHash !== batch.manifestHash || typeof result.summary !== 'string' || !Array.isArray(result.files) || result.files.length !== batch.files.length) throw new Error('QA result не соответствует batch id / generation / manifest / coverage');
  const seen = new Set();
  for (const file of result.files) {
    const expected = batch.files.find(item => item.name === file?.name);
    if (!keys(file, ['name', 'sha256', 'status', 'issues']) || !expected || expected.sha256 !== file.sha256 || seen.has(file.name) || !['passed', 'issues'].includes(file.status) || !Array.isArray(file.issues) || !file.issues.every(x => typeof x === 'string') || (file.status === 'passed' ? file.issues.length !== 0 : file.issues.length === 0)) throw new Error('QA result содержит посторонние, повторные, непроверенные файлы или несовпадающий hash');
    seen.add(file.name);
  }
}
module.exports = { loadQa, reviews, segments, counts, nextReview, validateReview };
