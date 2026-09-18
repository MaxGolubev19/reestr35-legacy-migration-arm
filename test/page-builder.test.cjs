'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testTempRoot } = require('./support.cjs');
const { Queue, createServer } = require('../src/server.cjs');

function root(t) { const value = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-')); t.after(() => fs.rmSync(value, { recursive: true, force: true })); return value; }
async function fixture(t) {
  const queue = new Queue({ root: root(t), autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0];
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  const base = `http://127.0.0.1:${server.address().port}`, state = await (await fetch(`${base}/api/state`)).json();
  return { queue, job, base, headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrfToken, origin: base, 'sec-fetch-site': 'same-origin' } };
}

test('step 3 has separate atomic per-company JSON seeded from local Mori HTML', async t => {
  const { queue, job, base } = await fixture(t), response = await fetch(`${base}/api/page-builder/${job.id}`), stored = await response.json();
  assert.equal(response.status, 200); assert.equal(stored.revision, 1); assert.equal(stored.document.source.hostname, 'mori-cinema.reestr35.ru');
  assert.match(stored.document.source.htmlSha256, /^[a-f0-9]{64}$/); assert.deepEqual(stored.document.tabs.map(tab => tab.title), ['Акции/новости', 'Афиша', 'Цены', 'О нас']);
  assert.ok(stored.document.tabs.flatMap(tab => tab.blocks).some(block => block.type === 'gallery'));
  const file = path.join(queue.root, 'page-builder', `${job.id}.json`); assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(path.join(queue.root, 'state.json')), true);
  assert.equal(JSON.parse(fs.readFileSync(queue.stateFile)).version, 2, 'step 1 state schema stays unchanged');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), []);
});

test('step 3 API validates CSRF, revision, fail reason and serves only allowlisted local media', async t => {
  const { queue, job, base, headers } = await fixture(t), url = `${base}/api/page-builder/${job.id}`, stored = await (await fetch(url)).json();
  const document = structuredClone(stored.document); document.common.title = 'Общая часть изменена'; document.common.review = { status: 'passed', reason: '' };
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, document }) })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision: 1, document, extra: true }) })).status, 400);
  const savedResponse = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision: 1, document }) }), saved = await savedResponse.json();
  assert.equal(savedResponse.status, 200); assert.equal(saved.revision, 2); assert.equal(saved.document.common.title, document.common.title);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision: 1, document }) })).status, 409);
  const invalid = structuredClone(saved.document); invalid.tabs[0].review = { status: 'failed', reason: '' };
  const invalidResponse = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision: 2, document: invalid }) }); assert.equal(invalidResponse.status, 400); assert.match((await invalidResponse.json()).error, /нужна причина/i);
  const forged = structuredClone(saved.document); forged.source.htmlSha256 = '0'.repeat(64);
  const forgedResponse = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision: 2, document: forged }) }); assert.equal(forgedResponse.status, 400); assert.match((await forgedResponse.json()).error, /неизменяемо/);
  const asset = saved.document.common.blocks[0].media[0]; const media = await fetch(`${url}/media/${asset.id}`); assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'image/svg+xml; charset=utf-8'); assert.match(await media.text(), /локальный макет медиа/);
  assert.equal((await fetch(`${url}/media/not-allowlisted`)).status, 404);
  assert.equal(queue.snapshot('token').jobs[0].pageBuilder.status, 'failed', 'seed includes a visible failed review distinct from a system error');
});

test('corrupt step 3 JSON is isolated as a red system error and does not corrupt state v2', async t => {
  const { queue, job } = await fixture(t); queue.pageBuilder.read(job.id); fs.writeFileSync(queue.pageBuilder.file(job.id), '{bad');
  const snapshot = queue.snapshot('token'); assert.equal(snapshot.jobs[0].pageBuilder.status, 'system_error'); assert.match(snapshot.jobs[0].pageBuilder.error, /JSON/);
  assert.equal(JSON.parse(fs.readFileSync(queue.stateFile)).version, 2);
});

test('section reviews and overall summary are derived only from block reviews', async t => {
  const { queue, job } = await fixture(t); const stored = queue.pageBuilder.read(job.id), document = structuredClone(stored.document);
  for (const section of [document.common, ...document.tabs]) {
    section.review = { status: 'failed', reason: 'Устаревший ручной статус раздела.' };
    section.blocks.forEach(block => { block.review = { status: 'passed', reason: '' }; });
  }
  const saved = queue.pageBuilder.write(job.id, stored.revision, document), summary = queue.pageBuilder.summary(job.id);
  assert.ok([saved.document.common, ...saved.document.tabs].every(section => section.review.status === 'passed' && section.review.reason === ''));
  assert.deepEqual(summary, { status: 'passed', total: 10, passed: 10, failed: 0, unreviewed: 0, revision: 2 });

  const failed = structuredClone(saved.document); failed.common.review = { status: 'passed', reason: '' };
  failed.common.blocks[0].review = { status: 'failed', reason: 'Нужно исправить блок.' };
  const normalized = queue.pageBuilder.write(job.id, saved.revision, failed);
  assert.equal(normalized.document.common.review.status, 'failed'); assert.match(normalized.document.common.review.reason, /исправить блок/);
  assert.deepEqual(queue.pageBuilder.summary(job.id), { status: 'failed', total: 10, passed: 9, failed: 1, unreviewed: 0, revision: 3 });
});
