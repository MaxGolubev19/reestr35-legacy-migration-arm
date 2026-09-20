'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { MediaPicker, WindowsDialogWorker } = require('../src/stages/page-builder/media-picker.cjs');
const { validateDocument, PageBuilderStore, BLOCK_TYPES } = require('../src/stages/page-builder/store.cjs');
const { seedMoriPage } = require('./page-builder-fixture.cjs');
const { testTempRoot } = require('./support.cjs');
const { Queue, createServer } = require('../src/server.cjs');

function root(t) { const value = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-')); t.after(() => fs.rmSync(value, { recursive: true, force: true })); return value; }
async function fixture(t, { existing = true, mediaPicker, onShutdown } = {}) {
  const queue = new Queue({ root: root(t), autoStart: false, mediaPicker }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0];
  if (existing) seedMoriPage(queue, job);
  const server = createServer(queue, { onShutdown }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  const base = `http://127.0.0.1:${server.address().port}`, state = await (await fetch(`${base}/api/state`)).json();
  return { queue, job, server, base, headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrfToken, origin: base, 'sec-fetch-site': 'same-origin' } };
}

test('new step 3 pages are empty and existing documents remain intact', async t => {
  const { queue, job, base } = await fixture(t, { existing: false }), response = await fetch(`${base}/api/page-builder/${job.id}`), stored = await response.json();
  assert.equal(response.status, 200); assert.equal(stored.revision, 1); assert.equal(stored.document.source.hostname, 'mori-cinema.reestr35.ru');
  assert.equal(stored.document.source.htmlSha256, '0'.repeat(64)); assert.deepEqual(stored.document.common.blocks, []); assert.deepEqual(stored.document.tabs, []);
  const file = queue.pageBuilder.file(job.id); assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(path.join(queue.root, 'state.json')), true);
  assert.equal(JSON.parse(fs.readFileSync(queue.stateFile)).version, 2, 'step 1 state schema stays unchanged');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), []);
  const before = fs.readFileSync(file), fresh = new PageBuilderStore(queue.root).read(job.id, { attempt: 1 });
  assert.deepEqual(fresh.document, stored.document); assert.deepEqual(fs.readFileSync(file), before, 'reading an existing page never replaces its JSON');
});

test('retry isolates documents, revisions, progress and media while historical attempts remain editable', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const first = queue.pageBuilder.read(job.id), asset = first.document.common.blocks[0].media[0];
  job.attempts[0].status = 'paused'; queue.retry(job.id);
  const endpoint = `${base}/api/page-builder/${job.id}`;
  const fresh = await (await fetch(`${endpoint}?attempt=2`)).json();
  assert.equal(fresh.attempt, 2); assert.equal(fresh.revision, 1); assert.deepEqual(fresh.document.common.blocks, []); assert.deepEqual(fresh.document.tabs, []);
  assert.equal((await fetch(`${endpoint}/media/${asset.id}?attempt=2`)).status, 404);
  assert.equal((await fetch(`${endpoint}/media/${asset.id}?attempt=1`)).status, 200);
  const post = (suffix, document, revision = 1) => fetch(endpoint + suffix, { method: 'POST', headers, body: JSON.stringify({ revision, document }) });
  assert.equal((await post('', first.document)).status, 409, 'an old unscoped client cannot copy stale blocks to a new attempt');
  first.document.common.title = 'Историческая общая часть';
  assert.equal((await post('?attempt=1', first.document)).status, 200);
  assert.equal((await post('?attempt=1', first.document)).status, 409);
  assert.equal(queue.pageBuilder.read(job.id, { attempt: 2 }).revision, 1);
  const snapshot = queue.snapshot('token').jobs[0];
  assert.equal(snapshot.pageBuilder.total, 0); assert.equal(snapshot.attempts[0].pageBuilder.total, 10); assert.equal(snapshot.attempts[1].pageBuilder.total, 0);
  assert.equal((await fetch(`${endpoint}?attempt=999`)).status, 409);
});

test('legacy migration binds to the last existing attempt before retry and preserves original bytes', async t => {
  const { queue, job } = await fixture(t, { existing: false });
  job.attempts[0].status = 'paused'; queue.retry(job.id);
  const legacy = queue.pageBuilder.legacyFile(job.id), payload = { revision: 7, updatedAt: new Date().toISOString(), document: require('./page-builder-fixture.cjs').sourceData() };
  fs.writeFileSync(legacy, JSON.stringify(payload)); const bytes = fs.readFileSync(legacy);
  job.attempts[1].status = 'paused'; queue.retry(job.id);
  assert.equal(queue.pageBuilder.read(job.id, { attempt: 2 }).revision, 7);
  assert.equal(queue.pageBuilder.read(job.id, { attempt: 2 }).document.common.blocks.length, 2);
  assert.equal(queue.pageBuilder.read(job.id, { attempt: 1 }).document.common.blocks.length, 0);
  assert.equal(queue.pageBuilder.read(job.id, { attempt: 3 }).document.common.blocks.length, 0);
  assert.deepEqual(fs.readFileSync(legacy), bytes);
  const reopened = new PageBuilderStore(queue.root, () => job);
  reopened.write(job.id, 7, payload.document, 2); reopened.migrateLegacy(job.id);
  assert.equal(reopened.read(job.id, { attempt: 2 }).revision, 8, 'repeated migration never overwrites subsequent edits');
  assert.deepEqual(fs.readFileSync(legacy), bytes);
});

test('interrupted legacy publication recovers its fixed owner without overwriting a conflicting target', async t => {
  const { queue, job } = await fixture(t, { existing: false });
  const store = queue.pageBuilder, legacy = store.legacyFile(job.id);
  const payload = { revision: 4, updatedAt: new Date().toISOString(), document: require('./page-builder-fixture.cjs').sourceData() };
  fs.writeFileSync(legacy, JSON.stringify(payload));
  const marker = path.join(store.root, job.id, 'legacy-binding.json'); fs.mkdirSync(path.dirname(marker), { recursive: true });
  const binding = { attempt: 1, sha256: crypto.createHash('sha256').update(fs.readFileSync(legacy)).digest('hex'), complete: false };
  fs.writeFileSync(marker, JSON.stringify(binding));
  queue.newAttempt(job); // Emulate recovery with newer state after marker publication.
  store.migrateLegacy(job.id); assert.equal(store.read(job.id, { attempt: 1 }).revision, 4);
  assert.equal(store.read(job.id, { attempt: 2 }).document.common.blocks.length, 0);
  fs.writeFileSync(marker, JSON.stringify(binding)); // Crash after target rename, before completion marker.
  store.migrateLegacy(job.id); assert.equal(JSON.parse(fs.readFileSync(marker)).complete, true);
  fs.writeFileSync(marker, JSON.stringify(binding));
  const target = store.file(job.id, 1); fs.writeFileSync(target, JSON.stringify({ ...payload, revision: 5 }));
  const before = fs.readFileSync(target);
  assert.throws(() => store.migrateLegacy(job.id), /Конфликт переноса/);
  assert.deepEqual(fs.readFileSync(target), before); assert.equal(JSON.parse(fs.readFileSync(legacy)).revision, 4);
});

test('historical media selection uses its own page CAS and rejects media from another attempt', async t => {
  const { queue, job } = await fixture(t), { attempt, buffers } = seedPickerImages(queue, job);
  const request = { revision: 1, attempt: 1, htmlRevision: attempt.htmlMedia.revision };
  const directory = path.join(queue.stage.media.directory(job, attempt), 'images'), name = fs.readdirSync(directory).find(value => value.startsWith('photo-'));
  attempt.status = 'paused'; queue.retry(job.id);
  const selected = queue.mediaPicker.choose(job.id, request, name, buffers[0]);
  assert.deepEqual(queue.mediaPicker.preview(job.id, selected.preview.split('/').at(-1)).bytes, buffers[0]);
  const fresh = queue.pageBuilder.read(job.id), block = queue.pageBuilder.read(job.id, { attempt: 1 }).document.common.blocks[0];
  block.media = [{ id: 'cross-attempt-image', originalUrl: selected.url, originalMedia: selected.media, bigUrl: '', href: '', alt: '', caption: '' }];
  fresh.document.common.blocks.push(block);
  assert.throws(() => queue.pageBuilder.write(job.id, fresh.revision, fresh.document, 2), /устаревшей попытке/);
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks.length, 0);
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
  const asset = saved.document.common.blocks[0].media[0], attempt = job.attempts.at(-1);
  const manifest = queue.stage.media.create(job, attempt, Buffer.from(`<img src="${asset.originalUrl}">`), 'test');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R5sGAAAAAElFTkSuQmCC', 'base64'), sha256 = crypto.createHash('sha256').update(png).digest('hex');
  fs.writeFileSync(path.join(queue.stage.media.directory(job, attempt), 'objects', sha256), png);
  Object.assign(manifest.resources[0], { status: 'downloaded', finalUrl: asset.originalUrl, redirects: [], mime: 'image/png', bytes: png.length, sha256, object: `objects/${sha256}` }); queue.stage.media.publish(job, attempt, manifest);
  const media = await fetch(`${url}/media/${asset.id}`); assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await media.arrayBuffer()), png, 'preview serves the verified stage-2 object instead of a generated SVG');
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

test('block creation, reorder, cross-section movement and deletion persist with normalized reviews and CAS', async t => {
  const { queue, job, base, headers } = await fixture(t), url = `${base}/api/page-builder/${job.id}`;
  const initial = queue.pageBuilder.read(job.id), created = structuredClone(initial.document);
  const block = { id: `block-${crypto.randomUUID()}`, type: 'text', title: 'Новый текст', description: '', content: 'Содержимое', settings: '', media: [], review: { status: 'passed', reason: '' } };
  created.common.blocks.push(block);
  const post = (revision, document) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision, document }) });
  const createResponse = await post(initial.revision, created), saved = await createResponse.json();
  assert.equal(createResponse.status, 200); assert.equal(saved.document.common.blocks.at(-1).review.status, 'unreviewed');
  const reordered = structuredClone(saved.document); reordered.common.blocks.reverse();
  const ordered = await (await post(saved.revision, reordered)).json();
  assert.deepEqual(ordered.document.common.blocks.map(item => item.id), [block.id, 'common-actions', 'common-hero']);
  assert.equal(ordered.document.common.blocks.at(-1).review.status, 'passed', 'reordering preserves unchanged content review');
  const moved = structuredClone(ordered.document), hero = moved.common.blocks.pop(); moved.tabs[1].blocks.push(hero);
  const races = await Promise.all([post(ordered.revision, moved), post(ordered.revision, reordered)]);
  assert.deepEqual(races.map(response => response.status).sort(), [200, 409], 'one concurrent structural edit wins');
  const winner = queue.pageBuilder.read(job.id);
  assert.equal(winner.document.tabs[1].blocks.at(-1).id, hero.id);
  assert.equal(winner.document.tabs[1].blocks.at(-1).review.status, 'unreviewed', 'changed section requires review');
  assert.equal(winner.document.tabs[1].review.status, 'unreviewed');
  const removed = structuredClone(winner.document); removed.common.blocks = []; removed.tabs[1].blocks = [];
  const deleted = await (await post(winner.revision, removed)).json();
  assert.deepEqual(deleted.document.common.blocks, []); assert.equal(deleted.document.common.review.status, 'unreviewed');
  assert.deepEqual(new PageBuilderStore(queue.root).read(job.id, { attempt: 1 }), deleted, 'fresh store preserves exact structure and revision');
  assert.equal((await fetch(`${url}/media/${hero.media[0].id}`)).status, 404, 'deleted media is no longer exposed');
  assert.deepEqual(fs.readdirSync(queue.pageBuilder.root).filter(file => file.endsWith('.tmp')), []);
});

test('tab creation, rename, reorder and deletion through the API persist with CAS, including an empty tab list', async t => {
  const { queue, job, base, headers } = await fixture(t), url = `${base}/api/page-builder/${job.id}`;
  const post = (revision, document) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision, document }) });
  const initial = queue.pageBuilder.read(job.id), created = structuredClone(initial.document);
  const tab = { id: `tab-${crypto.randomUUID()}`, title: 'Новая вкладка', review: { status: 'unreviewed', reason: '' }, blocks: [] };
  created.tabs.push(tab);
  let response = await post(initial.revision, created), saved = await response.json();
  assert.equal(response.status, 200); assert.equal(saved.document.tabs.at(-1).id, tab.id);
  const renamed = structuredClone(saved.document); renamed.tabs.at(-1).title = 'Переименована';
  response = await post(saved.revision, renamed); saved = await response.json();
  assert.equal(response.status, 200); assert.equal(saved.document.tabs.at(-1).title, 'Переименована');
  const reordered = structuredClone(saved.document); reordered.tabs.unshift(reordered.tabs.pop());
  const stale = await post(initial.revision, reordered); assert.equal(stale.status, 409);
  response = await post(saved.revision, reordered); saved = await response.json();
  assert.equal(response.status, 200); assert.equal(saved.document.tabs[0].id, tab.id);
  const removed = structuredClone(saved.document); removed.tabs = [];
  response = await post(saved.revision, removed); saved = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(saved.document.tabs, []);
  assert.deepEqual(new PageBuilderStore(queue.root).read(job.id, { attempt: 1 }).document.tabs, [], 'fresh store accepts deletion of the final tab');
  assert.equal(queue.pageBuilder.summary(job.id).total, saved.document.common.blocks.length);
  assert.deepEqual(fs.readdirSync(queue.pageBuilder.root).filter(file => file.endsWith('.tmp')), []);
});

test('last empty tab can be deleted from a page with no blocks', async t => {
  const { queue, job, base, headers } = await fixture(t, { existing: false });
  const url = `${base}/api/page-builder/${job.id}`;
  let stored = await (await fetch(url)).json();
  const withTab = structuredClone(stored.document);
  withTab.tabs.push({ id: `tab-${crypto.randomUUID()}`, title: 'Новая вкладка', review: { status: 'unreviewed', reason: '' }, blocks: [] });
  let response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision: stored.revision, document: withTab }) });
  assert.equal(response.status, 200); stored = await response.json();
  const withoutTab = structuredClone(stored.document); withoutTab.tabs = [];
  response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision: stored.revision, document: withoutTab }) });
  assert.equal(response.status, 200, await response.clone().text()); stored = await response.json();
  assert.deepEqual(stored.document.tabs, []);
  assert.deepEqual((await (await fetch(url)).json()).document.tabs, []);
  assert.equal(queue.pageBuilder.summary(job.id).status, 'unreviewed');
});

test('structural validation rejects duplicate block IDs, unknown types and overfull destinations without writes', async t => {
  const { queue, job } = await fixture(t), initial = queue.pageBuilder.read(job.id);
  const duplicate = structuredClone(initial.document); duplicate.tabs[0].blocks.push(structuredClone(duplicate.common.blocks[0]));
  assert.throws(() => queue.pageBuilder.write(job.id, initial.revision, duplicate), /Дублирующийся id блока/);
  const invalidType = structuredClone(initial.document); invalidType.common.blocks[0].type = 'script'; assert.throws(() => validateDocument(invalidType), /Некорректный блок/);
  const numericId = structuredClone(initial.document); numericId.common.blocks[0].id = 123; assert.throws(() => validateDocument(numericId), /Некорректный блок/);
  const overfull = structuredClone(initial.document); overfull.common.blocks = Array.from({ length: 41 }, (_, index) => ({ ...structuredClone(initial.document.common.blocks[1]), id: `new-${index}`, media: [] }));
  assert.throws(() => queue.pageBuilder.write(job.id, initial.revision, overfull), /Некорректный раздел/);
  assert.deepEqual(queue.pageBuilder.read(job.id), initial, 'invalid structures do not consume revision or alter disk');
});

test('portable type catalog has fixed IDs, views and defaults; scalar and media schemas reject invalid writes', async t => {
  const expected = { 'big-media': ['default', 'hero', 'compact'], table: ['default'], service: ['default', 'media-left', 'media-right', 'plain'], content: ['default', 'narrow', 'note'], grid: ['default', 'gallery', 'catalog', 'compact', 'promo', 'news', 'services', 'list'], 'data-table': ['default', 'compact'], links: ['links', 'documents'], sections: ['list', 'columns', 'contacts'], embed: ['default', 'wide', 'map'], 'rich-content': ['default', 'wide', 'compact'] };
  assert.deepEqual(Object.fromEntries(BLOCK_TYPES.map(type => [type.name, type.views])), expected);
  assert.deepEqual(BLOCK_TYPES.map(({ name, id, default_view }) => ({ name, id, default_view })),
    Object.entries(expected).map(([name, views], index) => ({ name, id: index + 1, default_view: views[0] })));
  assert.deepEqual(BLOCK_TYPES.map(type => type.label), ['Изображение / баннер', 'Таблица с текстом и изображениями', 'Описание услуги', 'Текст с изображениями', 'Карточки / галерея', 'Таблица данных', 'Ссылки и документы', 'Список разделов', 'Видео, карта или виджет', 'HTML-фрагмент']);
  const { queue, job } = await fixture(t), initial = queue.pageBuilder.read(job.id);
  for (const type of BLOCK_TYPES) for (const view of type.views) {
    const doc = structuredClone(initial.document), block = doc.common.blocks[0]; Object.assign(block, { type: type.name, view, text: 'Текст' }); if (type.name === 'rich-content') block.reason = 'Сохранение разметки';
    assert.equal(validateDocument(doc).common.blocks[0].view, view); delete block.view; assert.equal(validateDocument(doc).common.blocks[0].view, type.default_view);
  }
  for (const change of [block => { block.type = 'unknown'; }, block => { block.view = 'unknown'; }, block => { block.link = 'javascript:alert(1)'; }, block => { block.media[0].bigUrl = 'file:///private'; }, block => { block.media[0].href = 'data:text/html,bad'; }, block => { block.media.push(structuredClone(block.media[0])); }, block => { block.media = Array.from({ length: 13 }, (_, index) => ({ ...block.media[0], id: `excess-${index}` })); }, block => { block.items = []; }]) {
    const doc = structuredClone(initial.document); change(doc.common.blocks[0]); assert.throws(() => queue.pageBuilder.write(job.id, initial.revision, doc)); assert.deepEqual(queue.pageBuilder.read(job.id), initial);
  }
});

test('legacy blocks normalize without rewriting bytes or revision and preserve legacy fields/media/reviews', async t => {
  const { queue, job } = await fixture(t), initial = queue.pageBuilder.read(job.id);
  const legacy = { hero: ['big-media', 'hero'], text: ['content', 'default'], buttons: ['links', 'links'], image: ['big-media', 'default'], gallery: ['grid', 'gallery'], table: ['table', 'default'], video: ['embed', 'default'] };
  const document = structuredClone(initial.document); document.common.blocks = Object.keys(legacy).map((type, index) => ({ id: `legacy-${index}`, type, title: type, description: 'Описание сохранено', content: 'Исходный текст', settings: 'Старые настройки', review: { status: 'passed', reason: '' }, media: [{ id: `legacy-media-${index}`, originalUrl: 'https://example.org/image.jpg', alt: 'Исходный alt' }] }));
  fs.writeFileSync(queue.pageBuilder.file(job.id), JSON.stringify({ revision: 7, updatedAt: initial.updatedAt, document })); const bytes = fs.readFileSync(queue.pageBuilder.file(job.id));
  const read = queue.pageBuilder.read(job.id); assert.equal(read.revision, 7); assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), bytes);
  read.document.common.blocks.forEach((block, index) => { const old = document.common.blocks[index]; assert.deepEqual([block.type, block.view], legacy[old.type]); assert.equal(block.text, old.content); for (const field of ['content', 'settings', 'review']) assert.deepEqual(block[field], old[field]); assert.equal(block.media[0].alt, old.media[0].alt); assert.equal(block.media[0].bigUrl, ''); });
  assert.ok(read.document.common.blocks.every(block => !Object.hasOwn(block, 'description')));
  assert.equal(queue.pageBuilder.write(job.id, 7, read.document).revision, 8);
  assert.ok(JSON.parse(fs.readFileSync(queue.pageBuilder.file(job.id))).document.common.blocks.every(block => !Object.hasOwn(block, 'description')));
});

test('all block content fields are optional, empty media is safe, and failed review alone requires a reason', async t => {
  const { queue, job, base, headers } = await fixture(t); let stored = queue.pageBuilder.read(job.id);
  for (const type of BLOCK_TYPES) for (const view of type.views) {
    const document = structuredClone(stored.document);
    document.common.blocks = [{ id: 'empty-block', type: type.name, view, title: '', text: '', content: '', settings: '', media: [{ id: 'empty-image', originalUrl: '', bigUrl: '', href: '', alt: '', caption: '' }], review: { status: 'unreviewed', reason: '' }, ...Object.fromEntries(type.fields.map(field => [field.name, ''])) }];
    stored = queue.pageBuilder.write(job.id, stored.revision, document);
    assert.equal(stored.document.common.blocks[0].title, ''); assert.equal(stored.document.common.blocks[0].text, '');
  }
  const url = `${base}/api/page-builder/${job.id}`;
  assert.equal((await fetch(`${url}/media/empty-image`)).status, 200, 'an empty saved image has a local placeholder');
  const invalid = structuredClone(stored.document); invalid.common.blocks[0].review = { status: 'failed', reason: '   ' };
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ revision: stored.revision, document: invalid }) })).status, 400);
  assert.equal(queue.pageBuilder.read(job.id).revision, stored.revision);
  invalid.common.blocks[0].review.reason = 'Нужно сверить с источником';
  const saved = queue.pageBuilder.write(job.id, stored.revision, invalid); assert.equal(saved.document.common.blocks[0].review.status, 'failed');
  assert.throws(() => queue.pageBuilder.write(job.id, stored.revision, invalid), /уже изменены/);
  const missing = structuredClone(saved.document); delete missing.common.blocks[0].title; delete missing.common.blocks[0].text; delete missing.common.blocks[0].reason;
  assert.equal(validateDocument(missing).common.blocks[0].title, '');
  missing.tabs[0].title = ''; assert.throws(() => validateDocument(missing), /title/);
});

test('content, type, view and media edits reset review unless explicitly reconfirmed at the submitted revision', async t => {
  const { queue, job } = await fixture(t); let stored = queue.pageBuilder.read(job.id);
  const changes = [block => { block.text += ' новый'; }, block => { block.view = 'compact'; }, block => { block.type = 'content'; block.view = 'note'; }, block => { block.media[0].caption = 'Подпись'; }];
  for (const change of changes) {
    const next = structuredClone(stored.document); change(next.common.blocks[0]); next.common.blocks[0].review = { status: 'passed', reason: '' };
    stored = queue.pageBuilder.write(job.id, stored.revision, next); assert.equal(stored.document.common.blocks[0].review.status, 'unreviewed');
  }
  const confirmed = structuredClone(stored.document); confirmed.common.blocks[0].text += ' подтверждено'; confirmed.common.blocks[0].review = { status: 'passed', reason: '' }; confirmed.common.blocks[0].reviewedRevision = stored.revision;
  stored = queue.pageBuilder.write(job.id, stored.revision, confirmed); assert.equal(stored.document.common.blocks[0].review.status, 'passed'); assert.equal(Object.hasOwn(stored.document.common.blocks[0], 'reviewedRevision'), false);
  const media = structuredClone(stored.document), item = { id: `media-${crypto.randomUUID()}`, originalUrl: 'https://example.org/a.jpg', bigUrl: 'https://example.org/b.jpg', href: '/image', alt: 'Альтернативный текст', caption: 'Подпись' };
  media.common.blocks[0].media.unshift(item); stored = queue.pageBuilder.write(job.id, stored.revision, media); assert.deepEqual(stored.document.common.blocks[0].media[0], item); assert.equal(stored.document.common.blocks[0].review.status, 'unreviewed');
});

function seedPickerImages(queue, job) {
  const attempt = job.attempts.at(-1), manifest = queue.stage.media.create(job, attempt, Buffer.from('<img src="https://example.org/photo.png"><img src="https://example.org/large.gif">'), 'test');
  const buffers = [Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R5sGAAAAAElFTkSuQmCC', 'base64'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')];
  manifest.resources.forEach((item, i) => { const bytes = buffers[i], sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); fs.writeFileSync(path.join(queue.stage.media.directory(job, attempt), 'objects', sha256), bytes); Object.assign(item, { status: 'downloaded', mime: i ? 'image/gif' : 'image/png', bytes: bytes.length, sha256, object: `objects/${sha256}` }); });
  for (const item of manifest.resources) queue.stage.media.publishImage(job, attempt, item);
  queue.stage.media.publish(job, attempt, manifest); return { manifest, buffers, attempt };
}

test('browser image upload uses stage-2 images and accepts an exact copy with verified preview and persisted provenance', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const { buffers, attempt } = seedPickerImages(queue, job), before = fs.readFileSync(queue.pageBuilder.file(job.id));
  const endpoint = `${base}/api/page-builder/${job.id}`, request = { revision: 1, attempt: attempt.number, htmlRevision: attempt.htmlMedia.revision };
  const binaryHeaders = (name, extra = {}) => ({ ...headers, 'content-type': 'application/octet-stream', 'x-page-revision': String(request.revision), 'x-media-attempt': String(request.attempt), 'x-html-revision': String(request.htmlRevision), 'x-image-name': encodeURIComponent(name), ...extra });
  const pick = (name, bytes, extra = {}) => fetch(`${endpoint}/pick-media`, { method: 'POST', headers: binaryHeaders(name, extra), body: bytes });
  const directory = path.join(queue.stage.media.directory(job, attempt), 'images');
  assert.equal(fs.existsSync(directory), true, 'stage 2 creates the image folder');
  const names = fs.readdirSync(directory), photoName = names.find(name => name.startsWith('photo-')), largeName = names.find(name => name.startsWith('large-'));
  assert.ok(photoName && largeName);
  assert.equal((await fetch(`${endpoint}/prepare-media`, { method: 'POST', headers, body: JSON.stringify(request) })).status, 405, 'separate preparation route is removed');
  const outside = path.join(queue.root, photoName); fs.copyFileSync(path.join(directory, photoName), outside);
  const smallResponse = await pick(photoName, fs.readFileSync(outside)); assert.equal(smallResponse.status, 200);
  const small = await smallResponse.json(); assert.equal(small.cancelled, false); assert.equal(small.media.filename, photoName);
  assert.deepEqual(Buffer.from(await (await fetch(base + small.preview)).arrayBuffer()), buffers[0]);
  const largeResponse = await pick(largeName, buffers[1]); assert.equal(largeResponse.status, 200);
  const large = await largeResponse.json(); assert.deepEqual(Buffer.from(await (await fetch(base + large.preview)).arrayBuffer()), buffers[1]);
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), before, 'selection changes no durable document');
  const document = queue.pageBuilder.read(job.id).document, asset = document.common.blocks[0].media[0];
  Object.assign(asset, { originalUrl: small.url, originalMedia: small.media, bigUrl: large.url, bigMedia: large.media });
  const saved = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: 1, document }) }); assert.equal(saved.status, 200);
  for (const [kind, bytes] of [['original', buffers[0]], ['big', buffers[1]]]) assert.deepEqual(Buffer.from(await (await fetch(`${endpoint}/media/${asset.id}?kind=${kind}`)).arrayBuffer()), bytes);
  queue.stage.media.create(job, attempt, Buffer.from('<p>new HTML</p>'), 'test');
  assert.deepEqual(Buffer.from(await (await fetch(`${endpoint}/media/${asset.id}?kind=big`)).arrayBuffer()), buffers[1], 'saved references survive subsequent HTML revisions');
});

test('native image selection is scoped to the stage-2 folder and current revisions', async t => {
  const opened = [], { queue, job, base, headers } = await fixture(t); let dialogSignal;
  queue.mediaPicker.openDialog = async (directory, signal) => { opened.push(directory); dialogSignal = signal; return null; };
  const { attempt } = seedPickerImages(queue, job), endpoint = `${base}/api/page-builder/${job.id}`;
  const request = { revision: 1, attempt: attempt.number, htmlRevision: attempt.htmlMedia.revision };
  const pick = (data = request, h = headers) => fetch(`${endpoint}/pick-prepared-media`, { method: 'POST', headers: h, body: JSON.stringify(data) });
  const directory = path.join(queue.stage.media.directory(job, attempt), 'images');
  fs.renameSync(directory, directory + '.missing');
  const missing = await pick(); assert.equal(missing.status, 400); assert.match((await missing.json()).error, /Папка изображений не найдена/);
  assert.equal(opened.length, 0);
  assert.equal(fs.existsSync(directory), false, 'opening does not recreate the folder');
  fs.renameSync(directory + '.missing', directory);
  assert.equal((await pick(request, { ...headers, 'x-csrf-token': '' })).status, 403);
  assert.equal((await pick(request, { ...headers, 'sec-fetch-site': 'none' })).status, 403);
  assert.equal((await pick({ ...request, directory: queue.root })).status, 400);
  assert.equal((await pick({ ...request, attempt: 2 })).status, 409);
  assert.equal((await pick({ ...request, htmlRevision: 2 })).status, 409);
  assert.equal((await pick({ ...request, revision: 2 })).status, 409);
  assert.equal(opened.length, 0);
  const response = await pick(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { cancelled: true });
  assert.deepEqual(opened, [directory]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(dialogSignal.aborted, false, 'response close after a successful selection does not abort the dialog');
  queue.mediaPicker.openDialog = async () => { throw new Error('Окно выбора недоступно'); };
  const failed = await pick(); assert.equal(failed.status, 400); assert.match((await failed.json()).error, /Окно выбора недоступно/);
  queue.mediaPicker.openDialog = async () => path.join(directory, fs.readdirSync(directory)[0]);
  const selected = await pick(); assert.equal(selected.status, 200); assert.equal((await selected.json()).cancelled, false);
  queue.mediaPicker.openDialog = async () => path.join(queue.root, 'outside.png');
  const outside = await pick(); assert.equal(outside.status, 400); assert.match((await outside.json()).error, /папки изображений шага 2/);
});

test('aborted native selection waits for dialog close before allowing another selection', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const { attempt } = seedPickerImages(queue, job), endpoint = `${base}/api/page-builder/${job.id}`;
  const request = { revision: 1, attempt: attempt.number, htmlRevision: attempt.htmlMedia.revision };
  let opened, closeDialog, dialogSignal;
  const dialogOpened = new Promise(resolve => { opened = resolve; });
  queue.mediaPicker.openDialog = (_directory, signal) => {
    dialogSignal = signal;
    const pending = new Promise((_, reject) => { closeDialog = () => reject(new Error('Диалог закрыт')); });
    pending.child = { pid: 12345 };
    opened();
    return pending;
  };
  const abort = new AbortController();
  const first = fetch(`${endpoint}/pick-prepared-media`, { method: 'POST', headers, body: JSON.stringify(request), signal: abort.signal });
  await dialogOpened;
  assert.equal(queue.mediaPicker.dialogBusy, true); assert.equal(queue.mediaPicker.dialogChild.pid, 12345);
  abort.abort(); await assert.rejects(first, { name: 'AbortError' });
  await new Promise((resolve, reject) => {
    if (dialogSignal.aborted) return resolve();
    const timer = setTimeout(() => reject(new Error('HTTP abort did not reach the dialog')), 3000);
    dialogSignal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  assert.equal(queue.mediaPicker.dialogBusy, true, 'dialog remains busy until the process closes');
  closeDialog();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => queue.mediaPicker.dialogBusy ? (Date.now() < deadline ? setTimeout(check, 10) : reject(new Error('dialog did not close'))) : resolve();
    check();
  });
  assert.equal(queue.mediaPicker.dialogChild, null); assert.equal(queue.mediaPicker.dialogPromise, null);
  queue.mediaPicker.openDialog = async () => null;
  const second = await fetch(`${endpoint}/pick-prepared-media`, { method: 'POST', headers, body: JSON.stringify(request) });
  assert.equal(second.status, 200); assert.deepEqual(await second.json(), { cancelled: true });
});

test('shutdown cancels an open native image dialog and waits for its process close', async t => {
  const { queue, job } = await fixture(t);
  const { attempt } = seedPickerImages(queue, job), request = { revision: 1, attempt: attempt.number, htmlRevision: attempt.htmlMedia.revision };
  let closeDialog, dialogSignal;
  queue.mediaPicker.openDialog = (_directory, signal) => {
    dialogSignal = signal;
    const pending = new Promise((_, reject) => { closeDialog = () => reject(new Error('Диалог закрыт')); });
    pending.child = { pid: 67890 };
    return pending;
  };
  const picked = queue.mediaPicker.pickPrepared(job.id, request);
  assert.equal(queue.mediaPicker.dialogBusy, true);
  let stopped = false;
  const stopping = queue.shutdown().then(() => { stopped = true; });
  assert.equal(dialogSignal.aborted, true); assert.equal(stopped, false);
  assert.equal(queue.mediaPicker.dialogBusy, true, 'shutdown waits for close before clearing busy state');
  closeDialog();
  await assert.rejects(picked, { name: 'AbortError' }); await stopping;
  assert.equal(stopped, true); assert.equal(queue.mediaPicker.dialogBusy, false);
  assert.equal(queue.mediaPicker.dialogChild, null); assert.equal(queue.mediaPicker.dialogPromise, null);
});

function fakePickerProcess({ brokenPipe = false } = {}) {
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    let finished = false;
    const close = signal => {
      if (finished) return;
      finished = true; child.signalCode = signal;
      queueMicrotask(() => child.emit('close', signal ? null : 0));
    };
    child.kill = () => { close('SIGTERM'); return true; };
    child.stdin.write = (line, callback) => {
      if (line === 'STOP\n') queueMicrotask(() => close(null));
      else if (brokenPipe) queueMicrotask(() => child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
      callback?.(); return true;
    };
    children.push(child);
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('READY\n')));
    return child;
  };
  return { children, spawnProcess };
}

test('picker helper handles stdin EPIPE without an uncaught stream error', async () => {
  const fake = fakePickerProcess({ brokenPipe: true });
  const worker = new WindowsDialogWorker({ spawnProcess: fake.spawnProcess, platform: 'win32' });
  await worker.start();
  await assert.rejects(worker.choose('C:\\images'), /broken pipe/);
  assert.equal(fake.children.length, 2, 'a new helper is ready after the failed write');
  await worker.shutdown();
  assert.equal(worker.child, null);
});

test('replacement warmup failure preserves selected FILE and next click retries startup', async () => {
  const children = []; let launches = 0;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    let finished = false;
    child.kill = () => {
      if (!finished) { finished = true; child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('close', null)); }
      return true;
    };
    child.stdin.write = (line, callback) => {
      if (line === 'STOP\n') queueMicrotask(() => child.kill());
      else queueMicrotask(() => child.stdout.emit('data', Buffer.from('FILE ' + Buffer.from('C:\\images\\chosen.png').toString('base64') + '\n')));
      callback?.(); return true;
    };
    children.push(child); launches++;
    if (launches === 2) queueMicrotask(() => { child.emit('error', new Error('replacement startup failed')); child.kill(); });
    else queueMicrotask(() => child.stdout.emit('data', Buffer.from('READY\n')));
    return child;
  };
  const worker = new WindowsDialogWorker({ spawnProcess, platform: 'win32' });
  try {
    assert.equal(await worker.choose('C:\\images'), 'C:\\images\\chosen.png');
    assert.equal(children.length, 2, 'replacement startup was attempted');
    assert.equal(worker.child, null, 'failed replacement was reaped');
    assert.equal(await worker.choose('C:\\images'), 'C:\\images\\chosen.png');
    assert.equal(children.length, 4, 'next click started a new helper');
  } finally { await worker.shutdown(); }
});

test('shutdown during an active picker never starts a replacement helper', async () => {
  const fake = fakePickerProcess();
  const worker = new WindowsDialogWorker({ spawnProcess: fake.spawnProcess, platform: 'win32' });
  const picker = new MediaPicker(null); picker.dialogWorker = worker;
  await picker.warmup();
  const abort = new AbortController(); picker.dialogAbort = abort;
  const selection = worker.choose('C:\\images', abort.signal);
  picker.dialogPromise = selection;
  await new Promise(resolve => setImmediate(resolve));
  await Promise.race([picker.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown hung waiting for replacement READY')), 1000))]);
  await assert.rejects(selection, { name: 'AbortError' });
  assert.equal(fake.children.length, 1, 'shutdown does not spawn a replacement');
  assert.equal(worker.child, null, 'shutdown waits for child close');
});

test('browser image upload rejects wrong name, bytes, MIME, stale CAS and oversized stream without changing data', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const { buffers, attempt, manifest } = seedPickerImages(queue, job), endpoint = `${base}/api/page-builder/${job.id}`, request = { revision: 1, attempt: 1, htmlRevision: 1 };
  const directory = path.join(queue.stage.media.directory(job, attempt), 'images'), name = fs.readdirSync(directory).find(value => value.startsWith('photo-'));
  const binaryHeaders = (filename = name, extra = {}) => ({ ...headers, 'content-type': 'application/octet-stream', 'x-page-revision': '1', 'x-media-attempt': '1', 'x-html-revision': '1', 'x-image-name': encodeURIComponent(filename), ...extra });
  const pick = (filename, bytes, extra) => fetch(`${endpoint}/pick-media`, { method: 'POST', headers: binaryHeaders(filename, extra), body: bytes });
  const beforeDocument = fs.readFileSync(queue.pageBuilder.file(job.id)), beforeCache = fs.readdirSync(directory).map(file => [file, fs.readFileSync(path.join(directory, file)).toString('hex')]);
  assert.equal((await pick(name, buffers[0], { origin: 'http://localhost' })).status, 403);
  assert.equal((await pick(name, buffers[0], { 'x-csrf-token': '' })).status, 403);
  assert.equal((await pick(name, buffers[0], { 'sec-fetch-site': 'none' })).status, 403);
  assert.equal((await pick('outside.png', buffers[0])).status, 400);
  const changed = Buffer.from(buffers[0]); changed[changed.length - 1] ^= 1;
  const error = await pick(name, changed); assert.equal(error.status, 400); assert.match((await error.json()).error, /не совпадает/);
  assert.equal((await pick(name, buffers[0], { 'x-html-revision': '2' })).status, 409);
  assert.equal((await pick(name, buffers[0], { 'x-page-revision': '2' })).status, 409);
  assert.equal((await fetch(`${endpoint}/pick-media`, { method: 'POST', headers: { ...binaryHeaders(), 'content-type': 'application/json' }, body: buffers[0] })).status, 415);
  assert.equal((await pick(name, Buffer.alloc(queue.stage.media.limits.maxFileBytes + 1))).status, 413);
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), beforeDocument);
  assert.deepEqual(fs.readdirSync(directory).map(file => [file, fs.readFileSync(path.join(directory, file)).toString('hex')]), beforeCache);
  manifest.resources[0].mime = 'image/jpeg'; queue.stage.media.publish(job, attempt, manifest);
  assert.equal((await pick(name, buffers[0])).status, 400, 'manifest MIME and filename must still match');
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), beforeDocument);
});

test('browser image upload accepts a generated Cyrillic filename longer than 300 encoded characters', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const { manifest, buffers, attempt } = seedPickerImages(queue, job);
  manifest.resources[0].resolvedUrl = `https://example.org/${'Я'.repeat(50)}.png`;
  queue.stage.media.publishImage(job, attempt, manifest.resources[0]);
  queue.stage.media.publish(job, attempt, manifest);
  const endpoint = `${base}/api/page-builder/${job.id}`, request = { revision: 1, attempt: 1, htmlRevision: 1 };
  const directory = path.join(queue.stage.media.directory(job, attempt), 'images'), name = fs.readdirSync(directory).find(value => value.startsWith('Я'));
  assert.ok(name); assert.ok(encodeURIComponent(name).length > 300);
  const response = await fetch(`${endpoint}/pick-media`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-page-revision': '1', 'x-media-attempt': '1', 'x-html-revision': '1', 'x-image-name': encodeURIComponent(name) }, body: buffers[0] });
  assert.equal(response.status, 200, await response.text());
});
