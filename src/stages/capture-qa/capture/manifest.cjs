'use strict';
const { hash } = require('../../../infrastructure/hash.cjs');
const { readJson, safeFile } = require('../../../infrastructure/files.cjs');
const { normalizeUrl } = require('../../../pipeline/url.cjs');
const { paths } = require('../paths.cjs');
const { inspectArtifacts, captureInventory, captureCoverage } = require('./artifacts.cjs');
function captureEvidence(artifacts) {
  const inventory = captureInventory(artifacts.report || {}), coverage = captureCoverage(inventory, artifacts.files);
  const issues = [...(artifacts.issues || []), ...(artifacts.error ? [artifacts.error] : [])];
  return { inventory, coverage, issues, technicalComplete: artifacts.report?.status === 'complete' && issues.length === 0 };
}
function sealedManifest(artifacts, job, attempt) {
  const report = artifacts.report;
  if (!report || ['paused', 'interrupted'].includes(report.status) || typeof report.finished !== 'string' || !Number.isFinite(Date.parse(report.finished))) return null;
  const pngs = artifacts.files.filter(file => file.kind === 'png');
  const evidence = captureEvidence(artifacts);
  const data = { version: 3, jobId: job.id, attempt: attempt.number, reportHash: hash(report),
    inventory: evidence.inventory,
    technicalComplete: report.status === 'complete' && !artifacts.error && !artifacts.issues?.length,
    summary: { url: job.url, finalUrl: report.finalUrl || '', status: report.status, finished: report.finished,
      layout: report.model?.layout || '', segments: report.segments?.length || 0, pngCount: pngs.length,
      issues: [...(artifacts.issues || []), ...(artifacts.error ? [artifacts.error] : [])] },
    files: pngs.map(file => {
      const segment = report.segments.find(s => s?.file === file.name);
      // Explicitly omit large resource snapshots, DOM/model data and error stacks.
      return { name: file.name, bytes: file.bytes, sha256: file.sha256, segment: {
        status: segment.status, spec: segment.spec || null, chain: segment.chain || [], box: segment.box || null,
        issues: (segment.issues || []).filter(x => typeof x === 'string').map(x => x.slice(0, 400)).slice(0, 10) } };
    }) };
  return { ...data, hash: hash(data) };
}
function validManifest(manifest, job, attempt) {
  if (!manifest || ![2, 3].includes(manifest.version) || manifest.jobId !== job.id || manifest.attempt !== attempt.number) throw new Error('Manifest другой попытки');
  const { hash: checksum, ...data } = manifest;
  if (hash(data) !== checksum || !Array.isArray(manifest.files) || new Set(manifest.files.map(f => f.name)).size !== manifest.files.length) throw new Error('Manifest повреждён');
  return manifest;
}
// Snapshots can reuse the artifacts just inspected in that same synchronous
// refresh. Every action-boundary caller omits this argument and reads all bytes.
function checkManifest(root, job, attempt, manifest, inspectedArtifacts) {
  const p = paths(root, job, attempt);
  const stored = validManifest(readJson(safeFile(root, safeFile(p.dir, p.manifest))), job, attempt);
  if (stored.hash !== manifest.hash) throw new Error('Immutable manifest изменён');
  const artifacts = inspectedArtifacts || inspectArtifacts(root, job, attempt);
  const identity = files => files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
  const pngs = artifacts.files.filter(file => file.kind === 'png');
  // Capture identity never changes when policy gains checks or a new inventory.
  // Legacy reports remain the authoritative immutable source of richer evidence.
  const actualNames = artifacts.actualNames;
  if (!artifacts.report || !Array.isArray(actualNames) || hash(artifacts.report) !== manifest.reportHash || hash(identity(pngs)) !== hash(identity(manifest.files)) || hash(actualNames) !== hash(manifest.files.map(file => file.name).sort())) throw new Error('Capture изменён после фиксации manifest: отсутствующий, посторонний, повреждённый PNG или изменённый отчёт');
  const evidence = captureEvidence(artifacts);
  if (manifest.version === 3 && hash(evidence.inventory) !== hash(manifest.inventory)) throw new Error('Inventory не соответствует immutable report');
  return evidence;
}
function effectiveManifest(manifest) {
  const legacyIssue = 'Отсутствует корректный canonical finalUrl того же origin';
  if (!manifest.summary.issues.includes(legacyIssue)) return manifest;
  try { if (new URL(normalizeUrl(manifest.summary.finalUrl)).origin !== new URL(manifest.summary.url).origin) return manifest; }
  catch { return manifest; }
  const summary = { ...manifest.summary, issues: manifest.summary.issues.filter(issue => issue !== legacyIssue) };
  return { ...manifest, summary, technicalComplete: summary.status === 'complete' && summary.issues.length === 0 };
}
module.exports = { captureEvidence, sealedManifest, validManifest, checkManifest, effectiveManifest };
