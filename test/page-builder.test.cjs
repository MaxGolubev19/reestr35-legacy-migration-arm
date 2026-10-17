'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { filename } = require('../src/stages/page-builder/media-picker.cjs');
const { validateDocument, PageBuilderStore, BLOCK_TYPES } = require('../src/stages/page-builder/store.cjs');
const { seedMoriPage } = require('./page-builder-fixture.cjs');
const { testTempRoot } = require('./support.cjs');
const { Queue, createServer } = require('../src/server.cjs');

function root(t) { const value = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-')); t.after(() => fs.rmSync(value, { recursive: true, force: true })); return value; }
async function fixture(t, { existing = true, mediaPicker, onShutdown } = {}) {
  const queue = new Queue({ root: root(t), autoStart: false, mediaPicker, beget: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0];
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

test('known company ID survives retry before the new attempt has a page-builder document', async t => {
  const queue = new Queue({ root: root(t), autoStart: false, beget: { autoStart: false,
    destination: { host: 'fixture.test', user: 'fixture', remoteScript: '/fixture/rest/arm_sync.php' }, transport: async () => ({ ok: true }) } });
  t.after(() => queue.shutdown());
  queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  const record = queue.beget.record(job.id, 1); record.destination = queue.beget.destination; record.company = { id: 203370 }; queue.beget.persist(record);
  assert.equal(queue.pageBuilder.summary(job.id, 1).companyId, 203370);
  job.attempts[0].status = 'paused'; queue.retry(job.id);
  const freshFile = queue.pageBuilder.file(job.id, 2);
  assert.equal(fs.existsSync(freshFile), false, 'retry does not create a step 3 document');
  assert.deepEqual(queue.pageBuilder.summary(job.id, 2), { status: 'unreviewed', total: 0, passed: 0, failed: 0, unreviewed: 0, revision: 0, companyId: 203370 });
  fs.mkdirSync(path.dirname(freshFile), { recursive: true }); fs.writeFileSync(freshFile, '{bad');
  const broken = queue.pageBuilder.summary(job.id, 2);
  assert.equal(broken.status, 'system_error'); assert.equal(broken.companyId, 203370, 'document read errors do not hide the known company ID');
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
  const name = filename(queue.stage.media.read(job, attempt).resources[0]);
  attempt.status = 'paused'; queue.retry(job.id);
  const selected = queue.mediaPicker.choose(job.id, request, name);
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
  const { frames, mediaContext, ...durable } = deleted;
  assert.deepEqual(new PageBuilderStore(queue.root).read(job.id, { attempt: 1 }), durable, 'fresh store preserves exact structure and revision');
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
    const doc = structuredClone(initial.document), block = doc.common.blocks[0]; Object.assign(block, { type: type.name, view, text: 'Текст' }); if (type.name === 'rich-content') block.reason = 'Сохранение разметки'; if (type.name === 'data-table') block.media = [];
    assert.equal(validateDocument(doc).common.blocks[0].view, view); delete block.view; assert.equal(validateDocument(doc).common.blocks[0].view, type.default_view);
  }
  for (const change of [block => { block.type = 'unknown'; }, block => { block.view = 'unknown'; }, block => { block.link = 'javascript:alert(1)'; }, block => { block.media[0].bigUrl = 'file:///private'; }, block => { block.media[0].href = 'data:text/html,bad'; }, block => { block.media.push(structuredClone(block.media[0])); }, block => { block.media = Array.from({ length: 13 }, (_, index) => ({ ...block.media[0], id: `excess-${index}` })); }, block => { block.items = []; }]) {
    const doc = structuredClone(initial.document); change(doc.common.blocks[0]); assert.throws(() => queue.pageBuilder.write(job.id, initial.revision, doc)); assert.deepEqual(queue.pageBuilder.read(job.id), initial);
  }
});

test('portable block catalog matches the bundled Beget contract snapshot', () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/resources/company-block-contract.v1.json'), 'utf8'));
  assert.equal(snapshot.version, '1.0');
  const fields = ({ name, id, views, default_view }) => ({ name, id, views, default_view });
  assert.deepEqual(BLOCK_TYPES.map(fields), snapshot.types.map(fields));
});

test('data-table round trips columns, group rows and literal HTML cells with stable IDs and CAS', async t => {
  const { queue, job, base, headers } = await fixture(t), initial = queue.pageBuilder.read(job.id), document = structuredClone(initial.document);
  const block = document.common.blocks[0]; Object.assign(block, { type: 'data-table', view: 'compact', media: [], review: { status: 'unreviewed', reason: '' }, caption: '  Подпись  ', meta: { striped: false, bordered: true, sticky_header: true, min_width: 640 },
    columns: [{ key: 'name', title: 'Название', width: 40, align: 'center', nowrap: true }, {}],
    rows: [{ group: 'Группа' }, { cells: [{ value: ' **Markdown**\n<b>x</b>\n<script>invalid()</script> ', key: 'unrelated-key', align: 'right', colspan: 2, rowspan: 3, is_header: true, nowrap: false }, { value: '' }] }] });
  const normalized = validateDocument(document), expected = normalized.common.blocks[0];
  assert.deepEqual(validateDocument(normalized), normalized); assert.deepEqual(validateDocument(document), normalized);
  assert.match(expected.columns[0].id, /^column-/); assert.match(expected.rows[0].id, /^row-/); assert.match(expected.rows[1].cells[0].id, /^cell-/);
  assert.equal(expected.rows[1].cells[0].value, block.rows[1].cells[0].value); assert.deepEqual(expected.rows[1].cells[1], { id: expected.rows[1].cells[1].id, value: '' });
  assert.deepEqual(expected.columns[1], { id: expected.columns[1].id, key: '', title: '' });
  const response = await fetch(`${base}/api/page-builder/${job.id}`, { method: 'POST', headers, body: JSON.stringify({ revision: initial.revision, document }) }); assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json(); assert.deepEqual(saved.document.common.blocks[0], expected); assert.deepEqual(queue.pageBuilder.read(job.id).document, saved.document);
  assert.throws(() => queue.pageBuilder.write(job.id, initial.revision, document), /уже изменены/);
  const reordered = structuredClone(saved.document), current = reordered.common.blocks[0]; current.columns.reverse(); current.rows.reverse(); current.rows[0].cells.reverse();
  const second = queue.pageBuilder.write(job.id, saved.revision, reordered).document.common.blocks[0];
  assert.deepEqual(second.columns.map(column => column.id), expected.columns.map(column => column.id).reverse()); assert.equal(second.rows[1].id, expected.rows[0].id); assert.equal(second.rows[0].cells[1].id, expected.rows[1].cells[0].id);
});

test('data-table legacy aliases normalize without rewriting disk; caption-only documents stay readable', async t => {
  const { queue, job } = await fixture(t), stored = queue.pageBuilder.read(job.id), block = stored.document.common.blocks[0];
  Object.assign(block, { type: 'data-table', view: 'default', media: [], meta: { caption: 'Старая подпись', columns: [{ key: 'a', title: 'A' }] }, rows: [{ group: 'Раздел' }, { cells: [{ value: '' }] }] });
  const file = queue.pageBuilder.file(job.id); fs.writeFileSync(file, JSON.stringify(stored)); const bytes = fs.readFileSync(file);
  const read = queue.pageBuilder.read(job.id), normalized = read.document.common.blocks[0]; assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(read.revision, stored.revision);
  assert.equal(normalized.caption, 'Старая подпись'); assert.deepEqual(normalized.meta, {}); assert.equal(normalized.columns[0].title, 'A');
  assert.deepEqual(queue.pageBuilder.read(job.id), read);
  const saved = queue.pageBuilder.write(job.id, read.revision, read.document); assert.deepEqual(saved.document.common.blocks[0], normalized);
  const legacy = structuredClone(stored.document); Object.assign(legacy.common.blocks[0], { caption: 'Только подпись' }); delete legacy.common.blocks[0].rows; delete legacy.common.blocks[0].meta;
  const captionOnly = validateDocument(legacy).common.blocks[0]; assert.deepEqual(captionOnly.columns, []); assert.deepEqual(captionOnly.rows, []); assert.deepEqual(captionOnly.meta, {});
  const alias = structuredClone(stored.document); alias.common.blocks[0].caption = 'Другой текст'; alias.common.blocks[0].columns = [];
  const preferred = validateDocument(alias).common.blocks[0]; assert.equal(preferred.caption, 'Другой текст'); assert.deepEqual(preferred.columns, []); assert.deepEqual(preferred.meta, {});
});

test('data-table rejects unknown fields, bad types, XOR violations, duplicate IDs and local resource limits without writes', async t => {
  const { DATA_TABLE_LIMITS: limits } = require('../src/stages/page-builder/store.cjs');
  assert.deepEqual(limits, { columns: 100, rows: 100, cells: 1000, key: 200, title: 500, value: 12000, caption: 1000 });
  const { queue, job } = await fixture(t), initial = queue.pageBuilder.read(job.id), document = structuredClone(initial.document);
  Object.assign(document.common.blocks[0], { type: 'data-table', view: 'default', media: [], caption: '', meta: {}, columns: [{ id: 'data-column', key: '', title: '' }], rows: [{ id: 'data-group', group: 'Группа' }, { id: 'data-row', cells: [{ id: 'data-cell', value: '' }] }] });
  const changes = [b => b.unknown = true, b => b.meta.unknown = true, b => b.columns[0].unknown = true, b => b.rows[1].unknown = true, b => b.rows[1].cells[0].unknown = true, b => b.rows[1].cells[0].text = 'Скрытый текст', b => b.rows[0].drafts = { cells: [{ value: 'Скрытая ячейка' }] },
    b => b.media = initial.document.common.blocks[0].media, b => b.columns = null, b => b.rows = null, b => b.meta = null, b => b.caption = null, b => { delete b.columns; b.meta = { columns: null }; },
    b => b.rows[0].cells = [], b => delete b.rows[0].group, b => b.rows[0].group = '  ', b => b.rows[0].group = 1, b => b.rows[1].cells = [], b => b.rows[1].cells = {},
    b => delete b.rows[1].cells[0].value, b => b.rows[1].cells[0].value = 2, b => b.columns[0].title = null, b => b.columns[0].key = 2,
    b => b.columns[0].id = 'BAD', b => b.columns[0].id = b.id, b => b.rows[0].id = 'data-column', b => b.rows[1].cells[0].id = 'data-group',
    b => b.caption = 'x'.repeat(limits.caption + 1), b => b.columns[0].title = 'x'.repeat(limits.title + 1), b => b.columns[0].key = 'x'.repeat(limits.key + 1), b => b.rows[0].group = 'x'.repeat(limits.title + 1), b => b.rows[1].cells[0].value = 'x'.repeat(limits.value + 1), b => b.rows[1].cells[0].key = 'x'.repeat(limits.key + 1),
    b => b.columns = Array.from({ length: limits.columns + 1 }, () => ({ key: '', title: '' })), b => b.rows = Array.from({ length: limits.rows + 1 }, () => ({ group: 'g' })), b => b.rows = [{ cells: Array.from({ length: limits.cells + 1 }, () => ({ value: '' })) }]];
  for (const key of ['striped', 'bordered', 'sticky_header']) for (const value of [0, 'true', null]) changes.push(b => b.meta[key] = value);
  for (const value of [479, 1601, 480.5, '640', null]) changes.push(b => b.meta.min_width = value);
  for (const value of [4, 81, 5.5, '40', null]) changes.push(b => b.columns[0].width = value);
  for (const value of ['', 'start', null]) { changes.push(b => b.columns[0].align = value); changes.push(b => b.rows[1].cells[0].align = value); }
  for (const key of ['colspan', 'rowspan']) for (const value of [0, key === 'colspan' ? 13 : 101, 1.5, '2', null]) changes.push(b => b.rows[1].cells[0][key] = value);
  for (const value of [0, 'false', null]) { changes.push(b => b.columns[0].nowrap = value); changes.push(b => b.rows[1].cells[0].nowrap = value); changes.push(b => b.rows[1].cells[0].is_header = value); }
  const bytes = fs.readFileSync(queue.pageBuilder.file(job.id));
  for (const change of changes) { const invalid = structuredClone(document); change(invalid.common.blocks[0]); assert.throws(() => queue.pageBuilder.write(job.id, initial.revision, invalid), undefined, change.toString()); }
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), bytes); assert.equal(queue.pageBuilder.read(job.id).revision, initial.revision);
  const maximum = structuredClone(document), block = maximum.common.blocks[0]; block.columns = Array.from({ length: limits.columns }, () => ({ key: 'x'.repeat(limits.key), title: 'x'.repeat(limits.title), width: 80, nowrap: false }));
  block.caption = 'x'.repeat(limits.caption); block.meta = { min_width: 1600, striped: true, bordered: false, sticky_header: false }; block.rows = Array.from({ length: limits.rows }, () => ({ cells: Array.from({ length: 10 }, () => ({ value: '', colspan: 12, rowspan: 100 })) })); block.rows[0].cells[0].value = 'x'.repeat(limits.value);
  assert.equal(validateDocument(maximum).common.blocks[0].rows.flatMap(row => row.cells).length, limits.cells);
});

test('grid gallery items and image settings round trip with bounded references', async t => {
  const { queue, job } = await fixture(t), initial = queue.pageBuilder.read(job.id), document = structuredClone(initial.document);
  const block = document.common.blocks[0];
  Object.assign(block, { type: 'grid', view: 'gallery', meta: { columns: 3, image_ratio: '4x3', image_fit: 'contain', show_border: true, item_max_width: 480, items_align: 'center', media_mode: 'intrinsic', media_width: 640, media_align: 'center' },
    items: [{ id: 'gallery-one', title: 'Снимок', text: 'Описание', link: 'https://example.com/', link_text: 'Подробнее', image_asset_id: block.media[0].id, badge: 'Новое', date: '21.09.2026', meta: { action_style: 'primary', media_mode: 'fill', media_width: 320, media_align: 'end' } }] });
  const saved = queue.pageBuilder.write(job.id, initial.revision, document).document.common.blocks[0];
  assert.deepEqual(saved.items, block.items); assert.deepEqual(saved.meta, block.meta);
  const invalid = change => { const copy = structuredClone(document); change(copy.common.blocks[0]); assert.throws(() => validateDocument(copy)); };
  invalid(value => { value.items[0].image_asset_id = 'missing'; });
  invalid(value => { value.items[0].link = 'javascript:alert(1)'; });
  invalid(value => { value.items[0].meta.media_width = 9; });
  invalid(value => { value.meta.columns = 7; });
});

test('table rows, cells and pooled media normalize to the canonical contract with bounded stable IDs', async t => {
  const { queue, job } = await fixture(t), initial = queue.pageBuilder.read(job.id), document = structuredClone(initial.document);
  const block = document.common.blocks[0], media = ['table-image-a', 'table-image-b', 'table-image-c'].map(id => ({ id, originalUrl: '', bigUrl: '', href: '', alt: '', caption: '' }));
  Object.assign(block, { type: 'table', view: 'default', media, show_border: true, meta: {}, rows: [
    { id: 'table-row-a', cells: [
      { id: 'table-cell-a', title: 'Одна', text: 'Текст', link: '/one', image_asset_id: media[0].id, meta: { colspan: 2, rowspan: 3, is_header: true, align: 'center', media_mode: 'fill', media_width: 640, media_align: 'end' } },
      { id: 'table-cell-b', title: 'Несколько', text: '', link: '', image_asset_ids: [media[1].id, media[2].id], meta: {} }
    ] }
  ] });
  const saved = queue.pageBuilder.write(job.id, initial.revision, document), table = saved.document.common.blocks[0];
  assert.equal(table.show_border, true); assert.deepEqual(table.meta, {}); assert.deepEqual(table.rows, block.rows);
  assert.deepEqual(table.rows[0].cells[0].image_asset_id, 'table-image-a'); assert.deepEqual(table.rows[0].cells[1].image_asset_ids, ['table-image-b', 'table-image-c']);

  const legacy = structuredClone(saved.document); legacy.common.blocks[0].rows = [[{ title: 'Без ID', image_asset_ids: ['table-image-a', 'table-image-b'], colspan: 4, align: 'right' }]];
  const normalizedA = validateDocument(legacy).common.blocks[0].rows[0], normalizedB = validateDocument(legacy).common.blocks[0].rows[0];
  assert.match(normalizedA.id, /^row-[a-f0-9]{16}$/); assert.match(normalizedA.cells[0].id, /^cell-[a-f0-9]{16}$/);
  assert.equal(normalizedA.id, normalizedB.id, 'legacy fallback IDs are deterministic until saved');
  assert.deepEqual(normalizedA.cells[0].meta, { colspan: 4, align: 'right' });

  const invalid = (change, pattern) => {
    const copy = structuredClone(saved.document); change(copy.common.blocks[0]); assert.throws(() => queue.pageBuilder.write(job.id, saved.revision, copy), pattern); assert.equal(queue.pageBuilder.read(job.id).revision, saved.revision);
  };
  invalid(value => { value.rows[0].cells[0].meta.align = 'start'; }, /Некорректное поле/);
  invalid(value => { value.rows[0].cells[0].meta.media_align = 'left'; }, /Некорректное поле/);
  invalid(value => { value.rows[0].cells[0].image_asset_ids = ['table-image-a', 'table-image-b']; }, /Конфликт изображений/);
  invalid(value => { delete value.rows[0].cells[1].image_asset_ids; value.rows[0].cells[1].image_asset_ids = ['table-image-a']; }, /Некорректное поле/);
  invalid(value => { value.rows[0].cells[1].image_asset_ids = ['table-image-a', 'table-image-a']; }, /Некорректное поле/);
  invalid(value => { value.rows[0].cells[1].image_asset_ids = ['table-image-a', 'missing-image']; }, /Неизвестное изображение/);
  invalid(value => { value.rows[0].cells[1].id = value.rows[0].id; }, /Дублирующийся id/);
  invalid(value => { value.rows[0].cells[0].meta.colspan = 13; }, /Некорректное поле/);
  invalid(value => { value.rows = [{ id: 'too-many-cells', cells: Array.from({ length: 101 }, (_, index) => ({ id: `cell-${index}`, title: '' })) }]; }, /Некорректная строка/);
});

test('sections items and settings round trip with bounded nested validation', async t => {
  const { queue, job } = await fixture(t), initial = queue.pageBuilder.read(job.id), document = structuredClone(initial.document);
  const block = document.common.blocks[0];
  Object.assign(block, { type: 'sections', view: 'contacts', media: [], meta: { columns: 2, compact: true, show_icons: true },
    items: [{ id: 'section-one', title: 'Контакты', text: '', link: '', link_text: '', meta: { kind: 'section' }, children: [
      { id: 'section-email', title: 'Почта', text: 'Напишите нам', link: 'mailto:office@example.com', link_text: 'office@example.com', meta: { kind: 'email', target: 'self' }, children: [] }
    ] }] });
  const saved = queue.pageBuilder.write(job.id, initial.revision, document);
  assert.deepEqual(saved.document.common.blocks[0].items, block.items);
  assert.deepEqual(saved.document.common.blocks[0].meta, block.meta);
  assert.deepEqual(queue.pageBuilder.read(job.id).document.common.blocks[0].items, block.items);
  const invalid = change => { const copy = structuredClone(saved.document); change(copy.common.blocks[0]); assert.throws(() => validateDocument(copy)); };
  invalid(value => { value.meta.columns = 5; });
  invalid(value => { value.meta.show_icons = 'yes'; });
  invalid(value => { value.items[0].meta.kind = 'image'; });
  invalid(value => { value.items[0].children[0].link = 'javascript:alert(1)'; });
  invalid(value => { value.items[0].children[0].id = value.items[0].id; });
  invalid(value => { value.items[0].children[0].image_asset_id = 'unsupported'; });
  invalid(value => { let node = value.items[0]; for (let depth = 2; depth <= 7; depth++) { const child = { id: `depth-${depth}`, title: 'Пункт', children: [] }; node.children = [child]; node = child; } });
  invalid(value => { value.items = Array.from({ length: 101 }, (_, index) => ({ id: `section-${index}`, title: 'Пункт' })); });
  assert.equal(queue.pageBuilder.read(job.id).revision, saved.revision);
});

test('big-media meta round trips through API and rejects invalid or foreign settings', async t => {
  const { queue, job, base, headers } = await fixture(t), initial = queue.pageBuilder.read(job.id);
  const original = initial.document.common.blocks[0]; assert.equal(original.type, 'big-media'); assert.equal(Object.hasOwn(original, 'meta'), false, 'older blocks need no meta');
  const document = structuredClone(initial.document), block = document.common.blocks[0];
  block.meta = { ratio: 'poster', fit: 'contain', media_mode: 'intrinsic', media_width: 720, media_align: 'end' };
  const endpoint = `${base}/api/page-builder/${job.id}`;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: initial.revision, document }) });
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json(); assert.deepEqual(saved.document.common.blocks[0].meta, block.meta);
  assert.deepEqual((await (await fetch(endpoint)).json()).document.common.blocks[0].meta, block.meta);
  assert.deepEqual(queue.pageBuilder.read(job.id).document.common.blocks[0].meta, block.meta);
  const invalid = [
    { ratio: 'wide' }, { fit: 'stretch' }, { media_mode: 'crop' }, { media_align: 'left' },
    { media_width: 47 }, { media_width: 1601 }, { media_width: 720.5 }, { media_width: '720' }, { other: true }
  ];
  for (const meta of invalid) {
    const changed = structuredClone(saved.document); changed.common.blocks[0].meta = meta;
    assert.throws(() => validateDocument(changed), /Некорректное поле common\.blocks\[0\]\.meta/);
  }
  const badRequest = structuredClone(saved.document); badRequest.common.blocks[0].meta.media_width = 47;
  const rejected = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision, document: badRequest }) });
  assert.equal(rejected.status, 400, 'HTTP write rejects an invalid width');
  const foreign = structuredClone(saved.document); foreign.common.blocks[0].type = 'content'; foreign.common.blocks[0].view = 'default';
  assert.throws(() => validateDocument(foreign), /Некорректное поле common\.blocks\[0\]\.meta/);
  assert.equal(queue.pageBuilder.read(job.id).revision, saved.revision, 'invalid meta never changes stored revision');
});

test('service meta round trips through API and preserves older blocks without meta', async t => {
  const { queue, job, base, headers } = await fixture(t), initial = queue.pageBuilder.read(job.id);
  const document = structuredClone(initial.document), block = document.common.blocks[0]; block.type = 'service'; block.view = 'default';
  assert.equal(Object.hasOwn(validateDocument(document).common.blocks[0], 'meta'), false);
  block.meta = { image_ratio: '3x2', image_fit: 'cover', action_style: 'primary', media_mode: 'fill', media_width: 800, media_align: 'center' };
  const endpoint = `${base}/api/page-builder/${job.id}`;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: initial.revision, document }) });
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json(); assert.deepEqual(saved.document.common.blocks[0].meta, block.meta);
  assert.deepEqual((await (await fetch(endpoint)).json()).document.common.blocks[0].meta, block.meta);
  for (const meta of [
    { image_ratio: '16x9' }, { image_fit: 'stretch' }, { action_style: 'button' },
    { media_mode: 'crop' }, { media_align: 'left' }, { media_width: 47 },
    { media_width: 1601 }, { media_width: 100.5 }, { media_width: '800' }, { other: true }
  ]) {
    const changed = structuredClone(saved.document); changed.common.blocks[0].meta = meta;
    assert.throws(() => validateDocument(changed), /Некорректное поле common\.blocks\[0\]\.meta/);
  }
  const foreign = structuredClone(saved.document); foreign.common.blocks[0].type = 'content';
  assert.throws(() => validateDocument(foreign), /Некорректное поле common\.blocks\[0\]\.meta/);
  const bad = structuredClone(saved.document); bad.common.blocks[0].meta.media_width = 47;
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision, document: bad }) })).status, 400);
  assert.equal(queue.pageBuilder.read(job.id).revision, saved.revision);
});

test('content meta round trips through API, supports unset placement, and rejects invalid settings', async t => {
  const { queue, job, base, headers } = await fixture(t), initial = queue.pageBuilder.read(job.id);
  const document = structuredClone(initial.document), block = document.common.blocks[0]; block.type = 'content'; block.view = 'default';
  assert.equal(Object.hasOwn(validateDocument(document).common.blocks[0], 'meta'), false, 'old content needs no meta');
  block.meta = { image_position: 'after', image_layout: 'flow', image_ratio: '3x2', image_fit: 'contain', media_mode: 'fill', media_width: 800, media_align: 'center' };
  const endpoint = `${base}/api/page-builder/${job.id}`;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: initial.revision, document }) });
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json(); assert.deepEqual(saved.document.common.blocks[0].meta, block.meta);
  assert.deepEqual((await (await fetch(endpoint)).json()).document.common.blocks[0].meta, block.meta);
  const unset = structuredClone(saved.document); delete unset.common.blocks[0].meta.image_position; delete unset.common.blocks[0].meta.image_layout;
  assert.equal(validateDocument(unset).common.blocks[0].meta.image_position, undefined);
  for (const meta of [
    { image_position: 'center' }, { image_layout: 'grid' }, { image_ratio: '16x9' },
    { image_fit: 'stretch' }, { media_mode: 'crop' }, { media_align: 'left' },
    { media_width: 47 }, { media_width: 1601 }, { media_width: 100.5 }, { media_width: '800' }, { other: true }
  ]) {
    const changed = structuredClone(saved.document); changed.common.blocks[0].meta = meta;
    assert.throws(() => validateDocument(changed), /Некорректное поле common\.blocks\[0\]\.meta/);
  }
  const bad = structuredClone(saved.document); bad.common.blocks[0].meta.media_width = 47;
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision, document: bad }) })).status, 400);
  assert.equal(queue.pageBuilder.read(job.id).revision, saved.revision);
});

test('embed map height round trips through API and older embed remains valid', async t => {
  const { queue, job, base, headers } = await fixture(t), initial = queue.pageBuilder.read(job.id);
  const document = structuredClone(initial.document), block = document.common.blocks[0];
  Object.assign(block, { type: 'embed', view: 'map', media: [], source_url: 'https://example.org/map', link: '/map', provider: 'map', ratio: '4:3', text: 'Старый текст' });
  assert.equal(Object.hasOwn(validateDocument(document).common.blocks[0], 'meta'), false);
  fs.writeFileSync(queue.pageBuilder.file(job.id), JSON.stringify({ ...initial, document })); // A pre-existing URL remains editable.
  block.meta = { map_height: 560 };
  const endpoint = `${base}/api/page-builder/${job.id}`;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: initial.revision, document }) });
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json(), actual = saved.document.common.blocks[0];
  assert.deepEqual([actual.meta, actual.source_url, actual.link, actual.provider, actual.ratio, actual.text], [block.meta, 'https://example.org/map', '/map', 'map', '4:3', 'Старый текст']);
  assert.deepEqual((await (await fetch(endpoint)).json()).document.common.blocks[0].meta, block.meta);
  for (const meta of [{ map_height: 279 }, { map_height: 721 }, { map_height: 420.5 }, { map_height: '420' }, { media_width: 500 }, { other: true }]) {
    const invalid = structuredClone(saved.document); invalid.common.blocks[0].meta = meta;
    assert.throws(() => validateDocument(invalid), /Некорректное поле common\.blocks\[0\]\.meta/);
  }
  const nonHttp = structuredClone(saved.document); nonHttp.common.blocks[0].source_url = 'mailto:test@example.org';
  assert.throws(() => validateDocument(nonHttp), /Некорректный URL common\.blocks\[0\]\.source_url/);
  const invalid = structuredClone(saved.document); invalid.common.blocks[0].meta.map_height = 721;
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision, document: invalid }) })).status, 400);
  assert.equal(queue.pageBuilder.read(job.id).revision, saved.revision);
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

test('ordinary block fields are optional, empty media is safe, and failed review requires a reason', async t => {
  const { queue, job, base, headers } = await fixture(t); let stored = queue.pageBuilder.read(job.id);
  for (const type of BLOCK_TYPES) for (const view of type.views) {
    const document = structuredClone(stored.document);
    document.common.blocks = [{ id: 'empty-block', type: type.name, view, title: '', text: '', content: '', settings: '', media: [{ id: 'empty-image', originalUrl: '', bigUrl: '', href: '', alt: '', caption: '' }], review: { status: 'unreviewed', reason: '' }, ...Object.fromEntries(type.fields.map(field => [field.name, ''])) }];
    if (type.name === 'rich-content') Object.assign(document.common.blocks[0], { text: '<p>Текст</p>', reason: 'Сохранить порядок разметки' });
    // The wire contract renders images only through type-specific references;
    // types without a rendering field keep no pool, grid binds its pool to an item.
    if (['data-table', 'table', 'links', 'sections', 'embed', 'rich-content'].includes(type.name)) document.common.blocks[0].media = [];
    if (type.name === 'grid') document.common.blocks[0].items = [{ id: 'empty-item', title: '', text: '', link: '', link_text: '', image_asset_id: 'empty-image', badge: '', date: '', meta: {} }];
    stored = queue.pageBuilder.write(job.id, stored.revision, document);
    assert.equal(stored.document.common.blocks[0].title, ''); assert.equal(stored.document.common.blocks[0].text, type.name === 'rich-content' ? '<p>Текст</p>' : '');
    if (document.common.blocks[0].media.length) assert.equal((await fetch(`${base}/api/page-builder/${job.id}/media/empty-image`)).status, 200, 'an empty saved image has a local placeholder');
  }
  const url = `${base}/api/page-builder/${job.id}`;
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

test('empty image variants accept a valid href and reject an invalid href', async t => {
  const { queue, job, base, headers } = await fixture(t), initial = queue.pageBuilder.read(job.id), endpoint = `${base}/api/page-builder/${job.id}`;
  const document = structuredClone(initial.document), asset = document.common.blocks[0].media[0];
  asset.originalUrl = ''; asset.bigUrl = ''; asset.href = '/promo'; asset.alt = 'Афиша'; asset.caption = 'Акция';
  const accepted = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: initial.revision, document }) });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const saved = await accepted.json(); assert.deepEqual(saved.document.common.blocks[0].media[0], asset);
  const invalid = structuredClone(saved.document); invalid.common.blocks[0].media[0].href = 'example.org/promo';
  const rejected = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision, document: invalid }) });
  assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /Некорректный URL common\.blocks\[0\]\.media\[0\]\.href/);
  invalid.common.blocks[0].media[0].href = `/${'a'.repeat(4096)}`;
  const tooLong = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision, document: invalid }) });
  assert.equal(tooLong.status, 400); assert.match((await tooLong.json()).error, /Некорректное поле common\.blocks\[0\]\.media\[0\]\.href/);
  assert.equal(queue.pageBuilder.read(job.id).revision, saved.revision);
});

test('rich-content requires HTML and justification on write while old empty blocks remain readable', async t => {
  const { queue, job, base, headers } = await fixture(t), initial = queue.pageBuilder.read(job.id), endpoint = `${base}/api/page-builder/${job.id}`;
  const request = document => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: queue.pageBuilder.read(job.id).revision, document }) });
  const changed = structuredClone(initial.document), block = changed.common.blocks[0]; block.type = 'rich-content'; block.view = 'default'; block.text = ''; block.reason = ''; block.media = []; // a type switch never carries media into a type that renders none
  assert.equal((await request(changed)).status, 400, 'new rich block needs HTML');
  block.text = '<p>Текст</p>'; assert.equal((await request(changed)).status, 400, 'new rich block needs justification');
  block.reason = 'Сохранить семантику'; const accepted = await request(changed); assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal((await accepted.json()).document.common.blocks[0].reason, block.reason);
  const legacy = structuredClone(queue.pageBuilder.read(job.id).document); legacy.common.blocks[0].text = ''; legacy.common.blocks[0].reason = '';
  const before = queue.pageBuilder.read(job.id), file = queue.pageBuilder.file(job.id); fs.writeFileSync(file, JSON.stringify({ revision: before.revision, updatedAt: before.updatedAt, document: legacy }));
  const bytes = fs.readFileSync(file), read = queue.pageBuilder.read(job.id); assert.equal(read.document.common.blocks[0].text, ''); assert.deepEqual(fs.readFileSync(file), bytes, 'read leaves old JSON untouched');
  const unrelated = structuredClone(read.document); unrelated.common.title = 'Другое название';
  assert.equal((await request(unrelated)).status, 200, 'unrelated changes can preserve an old empty rich block');
  const edited = structuredClone(queue.pageBuilder.read(job.id).document); edited.common.blocks[0].title = 'Изменённый HTML';
  assert.equal((await request(edited)).status, 400, 'editing old rich block requires filling both fields');
});

test('wire image mechanics reject edited blocks while old documents stay readable and savable', async t => {
  const { queue, job, base, headers } = await fixture(t), initial = queue.pageBuilder.read(job.id), endpoint = `${base}/api/page-builder/${job.id}`;
  const request = document => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: queue.pageBuilder.read(job.id).revision, document }) });
  const asset = id => ({ id, originalUrl: `https://mori-cinema.reestr35.ru/${id}.jpg`, bigUrl: '', href: '', alt: '', caption: '' });
  const document = structuredClone(initial.document);
  document.common.blocks = [
    { id: 'legacy-grid', type: 'grid', view: 'gallery', title: 'Галерея', text: '', content: '', settings: '', media: [asset('orphan-photo'), asset('card-photo')], items: [{ id: 'legacy-item', title: 'Кадр', text: '', link: '', link_text: '', image_asset_id: 'card-photo', badge: '', date: '', meta: {} }], review: { status: 'unreviewed', reason: '' }, meta: {} },
    { id: 'legacy-content', type: 'content', view: 'default', title: 'Текст', text: '', content: '', settings: '', media: [asset('left'), asset('right'), asset('invisible')], review: { status: 'unreviewed', reason: '' } },
    { id: 'legacy-links', type: 'links', view: 'links', title: 'Ссылки', text: '', content: '', settings: '', media: [asset('logo')], items: [], review: { status: 'unreviewed', reason: '' }, meta: {} },
    { id: 'legacy-rich', type: 'rich-content', view: 'default', title: 'Фрагмент', text: '<p>Старый HTML</p>', reason: 'Порядок разметки', content: '', settings: '', media: [asset('rich-photo')], review: { status: 'unreviewed', reason: '' } }
  ];
  fs.writeFileSync(queue.pageBuilder.file(job.id), JSON.stringify({ revision: initial.revision, updatedAt: initial.updatedAt, document }));
  const bytes = fs.readFileSync(queue.pageBuilder.file(job.id));
  const read = queue.pageBuilder.read(job.id);
  assert.equal(read.document.common.blocks.length, 4);
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), bytes, 'reading old documents with orphaned media never rewrites them');
  const unrelated = structuredClone(read.document); unrelated.common.title = 'Другая общая часть';
  assert.equal((await request(unrelated)).status, 200, 'untouched legacy blocks keep saving alongside unrelated edits');
  const reject = async edit => { const response = await request(edit()); assert.equal(response.status, 400); return (await response.json()).error; };
  const gridEdit = structuredClone(queue.pageBuilder.read(job.id).document); gridEdit.common.blocks[0].title = 'Изменённая галерея';
  assert.match(await reject(() => gridEdit), /блока legacy-grid[\s\S]*orphan-photo[\s\S]*item\.image_asset_id/);
  const contentEdit = structuredClone(queue.pageBuilder.read(job.id).document); contentEdit.common.blocks[1].text = 'Новый текст';
  assert.match(await reject(() => contentEdit), /Блок legacy-content отображает не более двух изображений/);
  const linksEdit = structuredClone(queue.pageBuilder.read(job.id).document); linksEdit.common.blocks[2].title = 'Изменённые ссылки';
  assert.match(await reject(() => linksEdit), /Блок legacy-links не отображает изображения/);
  const richEdit = structuredClone(queue.pageBuilder.read(job.id).document); richEdit.common.blocks[3].title = 'Изменённый фрагмент';
  assert.match(await reject(() => richEdit), /Блок legacy-rich не отображает изображения/);
  const fixed = structuredClone(queue.pageBuilder.read(job.id).document);
  fixed.common.blocks[0].items.push({ id: 'adopted-item', title: 'Фото', text: '', link: '', link_text: '', image_asset_id: 'orphan-photo', badge: '', date: '', meta: {} });
  fixed.common.blocks[1].media.pop(); fixed.common.blocks[2].media = []; fixed.common.blocks[3].media = [];
  const repaired = await request(fixed); assert.equal(repaired.status, 200, await repaired.clone().text());
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].items.length, 2);
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
  queue.stage.media.publish(job, attempt, manifest); return { manifest, buffers, attempt };
}

test('manual image, document and iframe join one durable step-2 manifest and remain selectable', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const { attempt, buffers } = seedPickerImages(queue, job);
  attempt.status = 'complete';
  const context = { revision: 1, attempt: 1, htmlRevision: attempt.htmlMedia.revision };
  const prefix = `${base}/api/page-builder/${job.id}`;
  const before = queue.stage.media.read(job, attempt), originalSource = before.source.sha256, initialIds = before.resources.map(item => item.id);
  const upload = (kind, name, bytes, request = context) => fetch(`${prefix}/add-${kind}`, { method: 'POST', headers: {
    ...headers, 'content-type': 'application/octet-stream', 'x-attempt': String(request.attempt), 'x-builder-revision': String(request.revision),
    'x-html-revision': String(request.htmlRevision), 'x-file-name': encodeURIComponent(name)
  }, body: bytes });
  const image = await upload('image', 'новая-картинка.png', buffers[0]); assert.equal(image.status, 200);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  const document = await upload('document', 'новый документ.pdf', pdf); assert.equal(document.status, 200);
  const frameCode = '  <iframe\n title="Ролик" src="https://rutube.ru/play/embed/test/"></iframe>\n';
  const frame = await fetch(`${prefix}/add-frame`, { method: 'POST', headers, body: JSON.stringify({ ...context, code: frameCode }) });
  assert.equal(frame.status, 200);
  const manifest = queue.stage.media.read(job, attempt, true), added = manifest.resources.slice(initialIds.length);
  assert.deepEqual(manifest.resources.slice(0, initialIds.length).map(item => item.id), initialIds);
  assert.equal(manifest.source.sha256, originalSource); assert.deepEqual(added.map(item => item.id), [3, 4, 5]);
  assert.equal(added[0].manual, true); assert.equal(added[1].occurrence.downloadFilename, 'новый документ.pdf');
  assert.equal(added[2].snippet, frameCode); assert.equal(manifest.checkpoint, before.checkpoint + 3);
  const imageCatalog = queue.mediaPicker.catalog(job.id, context), fileCatalog = queue.documentPicker.catalog(job.id, context), frameCatalog = queue.framePicker.catalog(job.id, context);
  const imageName = filename(added[0]); assert.ok(imageCatalog.images.some(item => item.name === imageName));
  const chosenImage = queue.mediaPicker.choose(job.id, context, imageName); assert.equal(chosenImage.url, added[0].originalUrl);
  const chosenDocument = queue.documentPicker.choose(job.id, context, added[1].id); assert.equal(chosenDocument.link, added[1].originalUrl);
  assert.equal(frameCatalog.frames.at(-1).selectable, true); const chosenFrame = queue.framePicker.choose(job.id, context, added[2].id); assert.equal(chosenFrame.source_url, added[2].resolvedUrl);
  assert.deepEqual(Buffer.from(await (await fetch(base + chosenDocument.link)).arrayBuffer()), pdf);
  const stored = queue.pageBuilder.read(job.id), page = structuredClone(stored.document), asset = page.common.blocks[0].media[0];
  Object.assign(asset, { originalUrl: chosenImage.url, originalMedia: chosenImage.media });
  const linkBlock = linksBlock(); linkBlock.items.push(selectedDocumentItem(chosenDocument)); page.common.blocks.push(linkBlock);
  page.common.blocks.push({ id: 'manual-frame-block', type: 'embed', view: 'default', title: 'Фрейм', text: '', content: '', settings: '', media: [],
    review: { status: 'unreviewed', reason: '' }, source_url: chosenFrame.source_url, sourceFrame: chosenFrame.sourceFrame, link: '', provider: 'iframe', ratio: '16:9' });
  const saved = queue.pageBuilder.write(job.id, stored.revision, page, 1);
  assert.equal(saved.document.common.blocks.at(-1).source_url, chosenFrame.source_url);
  assert.equal(saved.document.common.blocks.at(-2).items[0].link, chosenDocument.link);
  assert.deepEqual(queue.mediaPicker.resolve(job.id, saved.document.common.blocks[0].media[0].originalMedia, chosenImage.url).bytes, buffers[0]);
  assert.equal((await upload('image', 'wrong.jpg', pdf, { ...context, revision: saved.revision })).status, 400);
  assert.equal((await upload('document', 'wrong.pdf', buffers[0], { ...context, revision: saved.revision })).status, 400);
  assert.equal((await upload('image', 'stale.png', buffers[0], { ...context, revision: 99 })).status, 409);
  assert.equal(queue.stage.media.read(job, attempt, true).resources.length, initialIds.length + 3);
  const restarted = new Queue({ root: queue.root, autoStart: false }), restoredJob = restarted.get(job.id), restoredAttempt = restoredJob.attempts[0];
  assert.equal(restarted.stage.media.read(restoredJob, restoredAttempt, true).resources.length, initialIds.length + 3);
  assert.equal(restarted.pageBuilder.read(job.id).document.common.blocks.at(-1).source_url, chosenFrame.source_url);
});

test('manual iframe ignores unknown attributes in the persisted copy while requiring one safe source', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const { attempt } = seedPickerImages(queue, job);
  attempt.status = 'complete';
  const context = { revision: 1, attempt: 1, htmlRevision: attempt.htmlMedia.revision };
  const endpoint = `${base}/api/page-builder/${job.id}/add-frame`;
  const add = code => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...context, code }) });
  const before = queue.stage.media.read(job, attempt).resources.length;
  for (const code of [
    '<iframe title="No source" data-extra="ignored"></iframe>',
    '<iframe src="javascript:alert(1)" data-extra="ignored"></iframe>',
    '<iframe src="https://rutube.ru/play/embed/test/"></iframe><iframe src="https://rutube.ru/play/embed/other/"></iframe>'
  ]) assert.equal((await add(code)).status, 400);
  assert.equal(queue.stage.media.read(job, attempt).resources.length, before);
  const safeUrl = 'https://rutube.ru/play/embed/test/';
  const response = await add(`<iframe data-extra="discard" onload="alert(1)" src="${safeUrl}" title="Ролик" srcdoc="<script>alert(1)</script>" allowfullscreen></iframe>`);
  assert.equal(response.status, 200);
  const item = queue.stage.media.read(job, attempt, true).resources.at(-1);
  assert.equal(item.originalUrl, safeUrl);
  assert.equal(item.snippet, `<iframe src="${safeUrl}" title="Ролик" allowfullscreen=""></iframe>`);
  assert.equal(queue.framePicker.catalog(job.id, context).frames.at(-1).selectable, true);
  assert.equal((await add(`<iframe src="${safeUrl}" src="javascript:alert(1)" data-extra="discard"></iframe>`)).status, 200);
  assert.equal(queue.stage.media.read(job, attempt, true).resources.at(-1).snippet, `<iframe src="${safeUrl}"></iframe>`);
  const restored = new Queue({ root: queue.root, autoStart: false });
  assert.equal(restored.stage.media.read(restored.get(job.id), restored.get(job.id).attempts[0], true).resources.at(-2).snippet, item.snippet);
});

test('catalog lists only verified step-2 images and selection persists provenance without image copies', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const { manifest, buffers, attempt } = seedPickerImages(queue, job), before = fs.readFileSync(queue.pageBuilder.file(job.id));
  const endpoint = `${base}/api/page-builder/${job.id}`, request = { revision: 1, attempt: 1, htmlRevision: 1 };
  const query = new URLSearchParams(request), directory = queue.stage.media.directory(job, attempt);
  assert.equal(fs.existsSync(path.join(directory, 'images')), false);
  const listing = await fetch(`${endpoint}/media-catalog?${query}`), catalog = await listing.json();
  assert.equal(listing.status, 200); assert.equal(catalog.images.length, 2);
  assert.ok(catalog.images.every(item => item.preview.startsWith(`/api/page-builder/${job.id}/catalog/`)));
  assert.deepEqual(Buffer.from(await (await fetch(base + catalog.images[0].preview)).arrayBuffer()), buffers[0]);
  const pick = name => fetch(`${endpoint}/choose-media`, { method: 'POST', headers, body: JSON.stringify({ ...request, name }) });
  const smallResponse = await pick(catalog.images[0].name); assert.equal(smallResponse.status, 200);
  const small = await smallResponse.json(); assert.equal(small.media.filename, catalog.images[0].name);
  assert.deepEqual(Buffer.from(await (await fetch(base + small.preview)).arrayBuffer()), buffers[0]);
  const large = await (await pick(catalog.images[1].name)).json();
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), before, 'selection changes no durable document');
  const document = queue.pageBuilder.read(job.id).document, asset = document.common.blocks[0].media[0];
  Object.assign(asset, { originalUrl: small.url, originalMedia: small.media, bigUrl: large.url, bigMedia: large.media });
  const saved = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: 1, document }) }); assert.equal(saved.status, 200);
  for (const [kind, bytes] of [['original', buffers[0]], ['big', buffers[1]]]) assert.deepEqual(Buffer.from(await (await fetch(`${endpoint}/media/${asset.id}?kind=${kind}`)).arrayBuffer()), bytes);
  queue.stage.media.create(job, attempt, Buffer.from('<p>new HTML</p>'), 'test');
  assert.deepEqual(Buffer.from(await (await fetch(`${endpoint}/media/${asset.id}?kind=big`)).arrayBuffer()), buffers[1], 'saved references survive subsequent HTML revisions');
  assert.equal(fs.existsSync(path.join(directory, 'images')), false);
});

test('catalog preserves repeated image occurrences shown by step 2', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const attempt = job.attempts[0], url = 'https://example.org/photo.png';
  const manifest = queue.stage.media.create(job, attempt, Buffer.from(`<a href="${url}"><img src="${url}"></a>`), 'test');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R5sGAAAAAElFTkSuQmCC', 'base64');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(queue.stage.media.directory(job, attempt), 'objects', sha256), bytes);
  for (const item of manifest.resources) Object.assign(item, { status: 'downloaded', mime: 'image/png', bytes: bytes.length, sha256, object: `objects/${sha256}` });
  queue.stage.media.publish(job, attempt, manifest);
  const request = { revision: 1, attempt: 1, htmlRevision: 1 }, endpoint = `${base}/api/page-builder/${job.id}`;
  const response = await fetch(`${endpoint}/media-catalog?${new URLSearchParams(request)}`), catalog = await response.json();
  assert.equal(response.status, 200);
  assert.equal(catalog.images.length, 2);
  assert.equal(catalog.images[0].name, catalog.images[1].name, 'both occurrences resolve to the same verified object');
  assert.deepEqual(catalog.images.map(image => image.resourceId), manifest.resources.map(item => item.id), 'each catalog tile keeps its own occurrence ID');
  for (const image of catalog.images) assert.deepEqual(Buffer.from(await (await fetch(base + image.preview)).arrayBuffer()), bytes);
  const selected = await fetch(`${endpoint}/choose-media`, { method: 'POST', headers, body: JSON.stringify({ ...request, name: catalog.images[1].name, resourceId: catalog.images[1].resourceId }) });
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).media.resourceId, catalog.images[1].resourceId);
  const stale = await fetch(`${endpoint}/choose-media`, { method: 'POST', headers, body: JSON.stringify({ ...request, name: catalog.images[1].name, resourceId: 999 }) });
  assert.notEqual(stale.status, 200);
  const legacy = await fetch(`${endpoint}/choose-media`, { method: 'POST', headers, body: JSON.stringify({ ...request, name: catalog.images[0].name }) });
  assert.equal((await legacy.json()).media.resourceId, catalog.images[0].resourceId, 'old name-only clients remain compatible');
});

test('catalog and all previews read legacy objects in linear time', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const urls = Array.from({ length: 30 }, (_, index) => `https://example.org/image-${index}.png`);
  const attempt = job.attempts[0], manifest = queue.stage.media.create(job, attempt, Buffer.from(urls.map(url => `<img src="${url}">`).join('')), 'test');
  const dir = queue.stage.media.directory(job, attempt);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R5sGAAAAAElFTkSuQmCC', 'base64');
  manifest.resources.forEach((item, index) => {
    const bytes = Buffer.concat([png, Buffer.from([index])]), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(dir, 'objects', sha256), bytes);
    Object.assign(item, { status: 'downloaded', mime: 'application/octet-stream', bytes: bytes.length, sha256, object: `objects/${sha256}` });
  });
  queue.stage.media.publish(job, attempt, manifest);
  const originalOpen = fs.openSync; let objectReads = 0;
  fs.openSync = function(file, ...args) {
    if (typeof file === 'string' && file.startsWith(path.join(dir, 'objects') + path.sep)) objectReads++;
    return originalOpen.call(this, file, ...args);
  };
  let catalog;
  try {
    const endpoint = `${base}/api/page-builder/${job.id}`, request = { revision: 1, attempt: 1, htmlRevision: 1 };
    const listing = await fetch(`${endpoint}/media-catalog?${new URLSearchParams(request)}`);
    assert.equal(listing.status, 200); catalog = await listing.json();
    for (const image of catalog.images) {
      const preview = await fetch(base + image.preview);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('content-type'), 'image/png');
      await preview.arrayBuffer();
    }
    const chosen = await fetch(`${endpoint}/choose-media`, { method: 'POST', headers, body: JSON.stringify({ ...request, name: catalog.images[0].name }) });
    assert.equal(chosen.status, 200);
  }
  finally { fs.openSync = originalOpen; }
  assert.equal(catalog.images.length, 30);
  assert.equal(objectReads, 122, 'listing: 60 reads; 30 previews and one choice: two reads each');
});

test('catalog is empty without downloaded images and rejects stale context, foreign names and tampered objects', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const endpoint = `${base}/api/page-builder/${job.id}`;
  const empty = await fetch(`${endpoint}/media-catalog?revision=1&attempt=1&htmlRevision=1`);
  assert.equal(empty.status, 400, 'no step-2 revision is explicit');
  const emptyManifest = queue.stage.media.create(job, job.attempts[0], Buffer.from('<p>No images</p>'), 'test');
  assert.deepEqual(queue.mediaPicker.catalog(job.id, { revision: 1, attempt: 1, htmlRevision: emptyManifest.revision }), { images: [] });
  const { manifest, attempt } = seedPickerImages(queue, job), request = { revision: 1, attempt: 1, htmlRevision: 2 };
  const name = filename(manifest.resources[0]);
  const catalog = data => fetch(`${endpoint}/media-catalog?${new URLSearchParams(data)}`);
  const pick = (data, h = headers) => fetch(`${endpoint}/choose-media`, { method: 'POST', headers: h, body: JSON.stringify(data) });
  assert.equal((await catalog({ ...request, revision: 2 })).status, 409);
  assert.equal((await catalog({ ...request, htmlRevision: 3 })).status, 409);
  assert.equal((await pick({ ...request, name }, { ...headers, 'x-csrf-token': '' })).status, 403);
  assert.equal((await pick({ ...request, name }, { ...headers, 'sec-fetch-site': 'none' })).status, 403);
  assert.equal((await pick({ ...request, name: 'outside.png' })).status, 400);
  assert.equal((await pick({ ...request, name, directory: queue.root })).status, 400);
  assert.equal((await pick({ ...request, name, attempt: 2 })).status, 409);
  const before = fs.readFileSync(queue.pageBuilder.file(job.id));
  const file = path.join(queue.stage.media.directory(job, attempt), manifest.resources[0].object);
  fs.writeFileSync(file, Buffer.from('corrupted'));
  assert.equal((await catalog(request)).status, 400);
  assert.equal((await pick({ ...request, name })).status, 400);
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), before);
});

test('catalog keeps long Cyrillic generated names inside local preview routes', async t => {
  const { queue, job, base, headers } = await fixture(t);
  const { manifest, attempt } = seedPickerImages(queue, job);
  manifest.resources[0].resolvedUrl = `https://example.org/${'Я'.repeat(50)}.png`;
  queue.stage.media.publish(job, attempt, manifest);
  const endpoint = `${base}/api/page-builder/${job.id}`, request = { revision: 1, attempt: 1, htmlRevision: 1 };
  const catalog = await (await fetch(`${endpoint}/media-catalog?${new URLSearchParams(request)}`)).json();
  const image = catalog.images.find(item => item.name.startsWith('Я'));
  assert.ok(image); assert.ok(encodeURIComponent(image.name).length > 300);
  assert.equal((await fetch(base + image.preview)).status, 200);
  const response = await fetch(`${endpoint}/choose-media`, { method: 'POST', headers, body: JSON.stringify({ ...request, name: image.name }) });
  assert.equal(response.status, 200);
});

function seedFrames(queue, job, html = '<iframe src="https://rutube.ru/play/embed/first/"></iframe><iframe src="https://rutube.ru/play/embed/first/"></iframe><iframe src="https://yandex.ru/map-widget/v1/?ll=37,55&amp;z=13"></iframe><iframe src="javascript:alert(1)"></iframe><iframe srcdoc="hello"></iframe><iframe src="http://127.0.0.1/private"></iframe>') {
  const attempt = job.attempts.at(-1), manifest = queue.stage.media.create(job, attempt, Buffer.from(html), 'test');
  return { attempt, manifest, request: { revision: queue.pageBuilder.read(job.id).revision, attempt: attempt.number, htmlRevision: manifest.revision } };
}
test('frame catalog preserves occurrences, separates selectable URLs from preview policy, and saves verified provenance', async t => {
  const { queue, job, base, headers } = await fixture(t), { request, manifest } = seedFrames(queue, job);
  const endpoint = `${base}/api/page-builder/${job.id}`;
  const catalog = await (await fetch(`${endpoint}/frame-catalog?${new URLSearchParams(request)}`)).json();
  assert.equal(catalog.frames.length, 6); assert.deepEqual(catalog.frames.map(frame => frame.selectable), [true, true, true, false, false, false]);
  assert.equal(catalog.frames[0].resolvedUrl, catalog.frames[1].resolvedUrl); assert.notEqual(catalog.frames[0].resourceId, catalog.frames[1].resourceId);
  assert.match(catalog.frames[2].reason, /вне списка/); assert.equal(catalog.frames[2].selectable, true, 'a map may be chosen without loading a forbidden iframe');
  const chosenResponse = await fetch(`${endpoint}/choose-frame`, { method: 'POST', headers, body: JSON.stringify({ ...request, resourceId: 2 }) });
  assert.equal(chosenResponse.status, 200); const chosen = await chosenResponse.json();
  assert.deepEqual(chosen.sourceFrame, { attempt: 1, revision: 1, resourceId: 2, sourceSha256: manifest.source.sha256 });
  const stored = queue.pageBuilder.read(job.id), document = structuredClone(stored.document), block = document.common.blocks[0];
  Object.assign(block, { type: 'embed', view: 'default', media: [], source_url: chosen.source_url, sourceFrame: chosen.sourceFrame });
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ revision: stored.revision, document }) });
  assert.equal(response.status, 200, await response.clone().text()); const saved = await response.json();
  assert.deepEqual(saved.document.common.blocks[0].sourceFrame, chosen.sourceFrame); assert.equal(saved.frames[block.id].resourceId, 2);
  assert.equal(JSON.parse(fs.readFileSync(queue.pageBuilder.file(job.id))).document.common.blocks[0].source_url, chosen.source_url);
  for (const suffix of ['/embed-preview', '/embed-preview/draft/' + 'a'.repeat(64), '/embed-preview/saved/' + block.id]) assert.equal((await fetch(endpoint + suffix)).status, 404);
  assert.equal(Object.hasOwn(queue, 'embedPreview'), false);
});
test('frame API rejects stale context, foreign resources, unsafe entries and request injection', async t => {
  const { queue, job, base, headers } = await fixture(t), { request } = seedFrames(queue, job);
  const endpoint = `${base}/api/page-builder/${job.id}`, pick = (data, h = headers) => fetch(endpoint + '/choose-frame', { method: 'POST', headers: h, body: JSON.stringify(data) });
  for (const change of [{ revision: 999 }, { attempt: 999 }, { htmlRevision: 999 }]) assert.equal((await pick({ ...request, ...change, resourceId: 1 })).status, 409);
  for (const resourceId of [0, -1, 1.5, '1', 999, 4, 5, 6]) assert.equal((await pick({ ...request, resourceId })).status, 400);
  assert.equal((await pick({ ...request, resourceId: 1, source_url: 'https://rutube.ru/arbitrary' })).status, 400);
  assert.equal((await pick({ ...request, resourceId: 1 }, { ...headers, 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await pick({ ...request, resourceId: 1 }, { ...headers, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await fetch(endpoint + '/frame-catalog?' + new URLSearchParams({ ...request, extra: '1' }))).status, 400);
  queue.add('https://other.reestr35.ru/'); const other = queue.jobs[1]; seedFrames(queue, other, '<p>no frames</p>');
  assert.equal((await fetch(`${base}/api/page-builder/${other.id}/choose-frame`, { method: 'POST', headers, body: JSON.stringify({ ...request, resourceId: 1 }) })).status, 400);
});
test('frame writes reject URL and provenance forgery, HTML corruption and stale selection without changing durable document', async t => {
  const { queue, job } = await fixture(t), { request, attempt, manifest } = seedFrames(queue, job), chosen = queue.framePicker.choose(job.id, request, 1);
  const stored = queue.pageBuilder.read(job.id), document = structuredClone(stored.document), block = document.common.blocks[0];
  Object.assign(block, { type: 'embed', view: 'default', media: [], source_url: chosen.source_url, sourceFrame: chosen.sourceFrame });
  const before = fs.readFileSync(queue.pageBuilder.file(job.id));
  for (const change of [{ source_url: 'https://rutube.ru/forged' }, { sourceFrame: { ...chosen.sourceFrame, resourceId: 3 } }, { sourceFrame: { ...chosen.sourceFrame, sourceSha256: '0'.repeat(64) } }, { sourceFrame: { ...chosen.sourceFrame, attempt: 2 } }]) {
    const forged = structuredClone(document); Object.assign(forged.common.blocks[0], change);
    assert.throws(() => queue.pageBuilder.write(job.id, stored.revision, forged), /фрейм|Фрейм|происхождение/);
    assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), before);
  }
  const plain = structuredClone(document); delete plain.common.blocks[0].sourceFrame; assert.throws(() => queue.pageBuilder.write(job.id, stored.revision, plain), /Выберите источник/);
  const dir = queue.stage.media.directory(job, attempt), file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({ ...manifest, jobId: crypto.randomUUID() })); assert.throws(() => queue.framePicker.catalog(job.id, request), /manifest/);
  fs.writeFileSync(file, JSON.stringify(manifest)); fs.appendFileSync(path.join(dir, 'source.html'), 'changed'); assert.throws(() => queue.framePicker.choose(job.id, request, 1), /SHA256/);
  seedFrames(queue, job); assert.throws(() => queue.pageBuilder.write(job.id, stored.revision, document), /устаревшей/);
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), before);
});
test('empty, missing and unsupported frame inventories are explicit; legacy and unchanged historic sources remain editable', async t => {
  const { queue, job, base } = await fixture(t), stored = queue.pageBuilder.read(job.id), document = structuredClone(stored.document), block = document.common.blocks[0];
  Object.assign(block, { type: 'embed', view: 'map', media: [], source_url: 'https://rutube.ru/legacy-without-manifest' });
  fs.writeFileSync(queue.pageBuilder.file(job.id), JSON.stringify({ ...stored, document }));
  let read = await (await fetch(`${base}/api/page-builder/${job.id}`)).json(); assert.match(read.frames[block.id].reason, /не найден/); assert.equal(read.frames[block.id].resolvedUrl, undefined);
  block.title = 'Legacy edit'; let saved = queue.pageBuilder.write(job.id, stored.revision, document); assert.equal(saved.document.common.blocks[0].source_url, block.source_url);
  let seed = seedFrames(queue, job, '<p>no frames</p>'); assert.deepEqual(queue.framePicker.catalog(job.id, seed.request), { frames: [] });
  seed = seedFrames(queue, job, '<iframe srcdoc="hello"></iframe>'); assert.equal(queue.framePicker.catalog(job.id, seed.request).frames[0].selectable, false);
  seed = seedFrames(queue, job); const chosen = queue.framePicker.choose(job.id, seed.request, 1);
  Object.assign(saved.document.common.blocks[0], { source_url: chosen.source_url, sourceFrame: chosen.sourceFrame }); saved = queue.pageBuilder.write(job.id, saved.revision, saved.document);
  seedFrames(queue, job, '<p>new HTML</p>'); saved.document.common.title = 'Unrelated change'; saved = queue.pageBuilder.write(job.id, saved.revision, saved.document);
  assert.deepEqual(saved.document.common.blocks[0].sourceFrame, chosen.sourceFrame);
  read = await (await fetch(`${base}/api/page-builder/${job.id}`)).json(); assert.match(read.frames[block.id].reason, /прежней версии/); assert.equal(read.frames[block.id].resolvedUrl, undefined);
  job.attempts[0].status = 'paused'; queue.retry(job.id); seedFrames(queue, job); const fresh = queue.pageBuilder.read(job.id); fresh.document.common.blocks = [saved.document.common.blocks[0]];
  assert.throws(() => queue.pageBuilder.write(job.id, fresh.revision, fresh.document, 2), /устаревшей/);
});

function linksBlock(view = 'documents') {
  return { id: 'links-block', type: 'links', view, title: 'Документы', text: '', content: '', settings: '', media: [], review: { status: 'unreviewed', reason: '' }, items: [], meta: {} };
}
function selectedDocumentItem(chosen, id = 'document-one') {
  return { id, title: chosen.name, text: '', link: chosen.link, link_text: chosen.name,
    meta: { kind: 'document', file_type: chosen.fileType, size: String(chosen.bytes), download: true }, sourceDocument: chosen.sourceDocument };
}
function seedDocuments(queue, job) {
  const stored = queue.pageBuilder.read(job.id), attempt = job.attempts.at(-1);
  const manifest = queue.stage.media.create(job, attempt, Buffer.from('<a href="https://example.org/report.pdf" download="Отчёт.pdf">One</a><a href="https://example.org/report.pdf" download="Копия.pdf">Two</a><a href="https://example.org/map.svg">SVG</a><audio src="https://example.org/sound.wav"></audio><video src="https://example.org/movie.webm"></video><a href="https://example.org/archive.zip">ZIP</a><img src="https://example.org/image.png"><a href="https://example.org/missing.txt">Missing</a>'), 'test');
  const pdf = Buffer.from('%PDF-1.7\nexample\n%%EOF');
  const values = [
    [pdf, 'application/pdf'], [pdf, 'application/octet-stream'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'],
    [Buffer.from('RIFF0000WAVEfmt '), 'audio/wav'], [Buffer.from('1a45dfa37765626d', 'hex'), 'video/webm'],
    [Buffer.from('504b0506', 'hex'), 'application/zip'],
    [Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R5sGAAAAAElFTkSuQmCC', 'base64'), 'application/octet-stream']
  ];
  values.forEach(([bytes, mime], index) => {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(queue.stage.media.directory(job, attempt), 'objects', sha256), bytes);
    Object.assign(manifest.resources[index], { status: 'downloaded', mime, bytes: bytes.length, sha256, object: `objects/${sha256}` });
  });
  Object.assign(manifest.resources.at(-1), { status: 'failed', error: 'HTTP 404' }); queue.stage.media.publish(job, attempt, manifest);
  return { manifest, attempt, values, request: { revision: stored.revision, attempt: attempt.number, htmlRevision: manifest.revision } };
}

test('links model roundtrips items and meta with defaults, limits and globally unique stable IDs', async t => {
  const { queue, job } = await fixture(t, { existing: false }), stored = queue.pageBuilder.read(job.id), block = linksBlock('links');
  delete block.items; delete block.meta; stored.document.common.blocks = [block];
  let saved = queue.pageBuilder.write(job.id, stored.revision, stored.document);
  assert.deepEqual(saved.document.common.blocks[0].items, []); assert.deepEqual(saved.document.common.blocks[0].meta, {});
  const next = saved.document.common.blocks[0]; next.meta = { columns: 3, compact: true };
  next.items = [{ id: 'link-one', title: 'Сайт', text: '**Текст**', link: 'https://example.org/', link_text: 'Открыть', meta: { kind: 'link', target: '_blank', download: false, file_type: '', size: '' } }];
  saved = queue.pageBuilder.write(job.id, saved.revision, saved.document);
  assert.deepEqual(queue.pageBuilder.read(job.id).document, saved.document);
  assert.deepEqual(saved.document.common.blocks[0].items, next.items);
  const before = fs.readFileSync(queue.pageBuilder.file(job.id));
  const changes = [
    b => b.meta.columns = 0, b => b.meta.columns = 4, b => b.meta.columns = '2', b => b.meta.compact = 1, b => b.meta.unknown = true,
    b => b.items = null, b => b.items = Array.from({ length: 101 }, (_, i) => ({ ...b.items[0], id: `item-${i}` })),
    b => b.items.push(structuredClone(b.items[0])), b => b.items[0].id = b.id,
    b => b.items[0].other = 1, b => b.items[0].link = 'javascript:alert(1)', b => b.items[0].link = 'file:///private',
    b => b.items[0].meta.kind = 'other', b => b.items[0].meta.target = 'window', b => b.items[0].meta.file_id = 0,
    b => b.items[0].meta.file_type = 'x'.repeat(11), b => b.items[0].meta.size = 'x'.repeat(101), b => b.items[0].meta.download = 'true',
    b => b.items[0].meta = null, b => b.items[0].title = 'x'.repeat(501), b => b.items[0].link_text = 'x'.repeat(501), b => b.items[0].text = 'x'.repeat(12001),
    b => b.items[0].sourceDocument = { attempt: 1, revision: 1, resourceId: 1, sha256: 'x' }
  ];
  for (const change of changes) {
    const invalid = structuredClone(saved.document); change(invalid.common.blocks[0]);
    assert.throws(() => queue.pageBuilder.write(job.id, saved.revision, invalid));
    assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), before);
  }
  const injected = structuredClone(saved.document); injected.common.blocks[0].items[0].meta.file_id = 123;
  assert.throws(() => queue.pageBuilder.write(job.id, saved.revision, injected), /Bitrix/);
});

test('document catalog includes all downloaded non-raster files and preserves same-SHA occurrences without saving choices', async t => {
  const { queue, job, base, headers } = await fixture(t, { existing: false }), { request, manifest } = seedDocuments(queue, job);
  const endpoint = `${base}/api/page-builder/${job.id}`, before = fs.readFileSync(queue.pageBuilder.file(job.id));
  const response = await fetch(endpoint + '/document-catalog?' + new URLSearchParams(request)); assert.equal(response.status, 200);
  const { documents } = await response.json(); assert.deepEqual(documents.map(item => item.resourceId), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(documents.slice(0, 2).map(item => item.name), ['Отчёт.pdf', 'Копия.pdf']);
  assert.equal(manifest.resources[0].sha256, manifest.resources[1].sha256); assert.notEqual(documents[0].preview, documents[1].preview);
  const chosenResponse = await fetch(endpoint + '/choose-document', { method: 'POST', headers, body: JSON.stringify({ ...request, resourceId: 2 }) });
  assert.equal(chosenResponse.status, 200); const chosen = await chosenResponse.json();
  assert.deepEqual(Object.keys(chosen).sort(), ['bytes', 'fileType', 'link', 'name', 'preview', 'sourceDocument'].sort());
  assert.deepEqual(chosen.sourceDocument, { attempt: 1, revision: 1, resourceId: 2, sha256: manifest.resources[1].sha256 });
  assert.equal(chosen.fileType, 'PDF'); assert.equal(chosen.name, 'Копия.pdf');
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), before, 'opening, choosing and cancelling never write the page');
  const download = await fetch(base + documents[2].preview); assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream'); assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.match(download.headers.get('content-security-policy'), /sandbox/);
  const stored = queue.pageBuilder.read(job.id), block = linksBlock(); block.items.push(selectedDocumentItem(chosen)); stored.document.common.blocks.push(block);
  const save = await fetch(endpoint + '?attempt=1', { method: 'POST', headers, body: JSON.stringify({ revision: stored.revision, document: stored.document }) });
  assert.equal(save.status, 200, await save.clone().text());
  assert.deepEqual((await save.json()).document.common.blocks[0].items[0].sourceDocument, chosen.sourceDocument);
  assert.equal((await fetch(endpoint + '/choose-document', { method: 'POST', headers, body: JSON.stringify({ ...request, resourceId: 1 }) })).status, 409);
});

test('empty document drafts save without step-2 media and changing views preserves editable data', async t => {
  const { queue, job } = await fixture(t, { existing: false }), stored = queue.pageBuilder.read(job.id), block = linksBlock();
  block.items = [{ id: 'empty-document', title: 'Будущий файл', text: 'Описание', link: '', link_text: '', meta: { kind: 'document' } }];
  stored.document.common.blocks = [block];
  let saved = queue.pageBuilder.write(job.id, stored.revision, stored.document);
  assert.deepEqual(saved.document.common.blocks[0].items, block.items);
  for (const view of ['links', 'documents']) {
    saved.document.common.blocks[0].view = view;
    saved = queue.pageBuilder.write(job.id, saved.revision, saved.document);
    assert.deepEqual(saved.document.common.blocks[0].items, block.items);
  }
  const { request } = seedDocuments(queue, job), chosen = queue.documentPicker.choose(job.id, request, 1);
  saved.document.common.blocks[0].items = [selectedDocumentItem(chosen)];
  saved = queue.pageBuilder.write(job.id, saved.revision, saved.document);
  for (const view of ['links', 'documents']) {
    saved.document.common.blocks[0].view = view;
    saved = queue.pageBuilder.write(job.id, saved.revision, saved.document);
    assert.deepEqual(saved.document.common.blocks[0].items[0].sourceDocument, chosen.sourceDocument);
  }
});

test('document endpoints reject stale context, foreign resources, raster files and request injection', async t => {
  const { queue, job, base, headers } = await fixture(t, { existing: false }), { request } = seedDocuments(queue, job), endpoint = `${base}/api/page-builder/${job.id}`;
  const pick = (data, h = headers) => fetch(endpoint + '/choose-document', { method: 'POST', headers: h, body: JSON.stringify(data) });
  for (const change of [{ revision: 999 }, { attempt: 999 }, { htmlRevision: 999 }]) assert.equal((await pick({ ...request, ...change, resourceId: 1 })).status, 409);
  for (const resourceId of [0, -1, 1.5, '1', 999, 7, 8]) assert.equal((await pick({ ...request, resourceId })).status, 400);
  for (const change of [{ link: 'https://evil.example/file.pdf' }, { sha256: 'a'.repeat(64) }, { bytes: 1 }, { path: 'outside' }]) assert.equal((await pick({ ...request, resourceId: 1, ...change })).status, 400);
  assert.equal((await pick({ ...request, resourceId: 1 }, { ...headers, 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await pick({ ...request, resourceId: 1 }, { ...headers, 'sec-fetch-site': 'cross-site' })).status, 403);
  for (const suffix of ['&extra=1', '&attempt=1']) assert.equal((await fetch(endpoint + '/document-catalog?' + new URLSearchParams(request) + suffix)).status, 400);
  queue.add('https://other.reestr35.ru/'); const other = queue.jobs[1]; queue.pageBuilder.read(other.id); queue.stage.media.create(other, other.attempts[0], Buffer.from('<p>Empty</p>'), 'test');
  assert.equal((await fetch(`${base}/api/page-builder/${other.id}/choose-document`, { method: 'POST', headers, body: JSON.stringify({ ...request, resourceId: 1 }) })).status, 400);
  assert.deepEqual(queue.documentPicker.catalog(other.id, request), { documents: [] });
});

test('document selections revalidate manifest identity, membership, SHA, size, signature and safe paths', async t => {
  const { queue, job } = await fixture(t, { existing: false }), { request, manifest, attempt } = seedDocuments(queue, job);
  const dir = queue.stage.media.directory(job, attempt), manifestFile = path.join(dir, 'manifest.json'), object = path.join(dir, manifest.resources[0].object), bytes = fs.readFileSync(object);
  const choose = () => queue.documentPicker.choose(job.id, request, 1), restore = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  for (const mutation of [
    m => m.jobId = crypto.randomUUID(), m => m.attempt = 2, m => m.revision = 2,
    m => m.resources[0].id = 2, m => m.resources[0].object = '../source.html', m => m.resources[0].sha256 = '0'.repeat(64),
    m => m.resources[0].bytes++, m => m.resources[0].mime = 'image/svg+xml', m => m.resources[0].resolvedUrl = 'javascript:alert(1)', m => m.resources[0].status = 'pending'
  ]) {
    const forged = structuredClone(manifest); mutation(forged); fs.writeFileSync(manifestFile, JSON.stringify(forged)); assert.throws(choose); restore();
  }
  fs.appendFileSync(object, 'tampered'); assert.throws(choose, /SHA/); fs.writeFileSync(object, bytes);
  const outside = path.join(queue.root, 'outside-documents'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, manifest.resources[0].sha256), bytes);
  const objects = path.join(dir, 'objects'), backup = path.join(dir, 'objects-backup'); fs.renameSync(objects, backup);
  fs.symlinkSync(outside, objects, 'junction');
  try { assert.throws(choose, /junction|пут/); } finally { fs.unlinkSync(objects); fs.renameSync(backup, objects); }
  assert.equal(choose().name, 'Отчёт.pdf');
});

test('document save rejects forged provenance, missing choice, URL replacement and changed HTML without modifying durable data', async t => {
  const { queue, job } = await fixture(t, { existing: false }), { request } = seedDocuments(queue, job), chosen = queue.documentPicker.choose(job.id, request, 1);
  const stored = queue.pageBuilder.read(job.id), block = linksBlock(); block.items = [selectedDocumentItem(chosen)]; stored.document.common.blocks = [block];
  const before = fs.readFileSync(queue.pageBuilder.file(job.id));
  for (const mutation of [
    item => delete item.sourceDocument, item => item.link = 'https://example.org/replaced.pdf', item => item.sourceDocument.resourceId = 3,
    item => item.sourceDocument.sha256 = '0'.repeat(64), item => item.sourceDocument.attempt = 2,
    item => item.sourceDocument.revision = 2, item => item.sourceDocument.bytes = 123, item => item.sourceDocument.sha256 = [item.sourceDocument.sha256],
  ]) {
    const document = structuredClone(stored.document); mutation(document.common.blocks[0].items[0]);
    assert.throws(() => queue.pageBuilder.write(job.id, stored.revision, document));
    assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), before);
  }
  seedDocuments(queue, job);
  assert.throws(() => queue.pageBuilder.write(job.id, stored.revision, stored.document), /устаревшей/);
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id)), before);
});

test('unchanged historic document items survive retired sources while changed or cross-attempt items require current provenance', async t => {
  const { queue, job } = await fixture(t, { existing: false }), { request, attempt } = seedDocuments(queue, job), chosen = queue.documentPicker.choose(job.id, request, 1);
  const stored = queue.pageBuilder.read(job.id), block = linksBlock(); block.items = [selectedDocumentItem(chosen)]; stored.document.common.blocks = [block];
  let saved = queue.pageBuilder.write(job.id, stored.revision, stored.document);
  fs.rmSync(path.join(queue.stage.media.directory(job, attempt), `objects/${chosen.sourceDocument.sha256}`));
  seedDocuments(queue, job); saved.document.common.title = 'Unrelated';
  saved = queue.pageBuilder.write(job.id, saved.revision, saved.document);
  assert.deepEqual(saved.document.common.blocks[0].items[0].sourceDocument, chosen.sourceDocument);
  const edited = structuredClone(saved.document); edited.common.blocks[0].items[0].title = 'Changed document';
  assert.throws(() => queue.pageBuilder.write(job.id, saved.revision, edited), /устаревшей/);
  attempt.status = 'paused'; queue.retry(job.id); seedDocuments(queue, job);
  const fresh = queue.pageBuilder.read(job.id); fresh.document.common.blocks = saved.document.common.blocks;
  assert.throws(() => queue.pageBuilder.write(job.id, fresh.revision, fresh.document, 2), /устаревшей/);
  const legacy = structuredClone(saved); delete legacy.document.common.blocks[0].items[0].sourceDocument;
  legacy.document.common.blocks[0].items[0].meta.file_id = 123;
  fs.writeFileSync(queue.pageBuilder.file(job.id, 1), JSON.stringify(legacy));
  const beforeRead = fs.readFileSync(queue.pageBuilder.file(job.id, 1)), read = queue.pageBuilder.read(job.id, { attempt: 1 });
  assert.deepEqual(fs.readFileSync(queue.pageBuilder.file(job.id, 1)), beforeRead);
  read.document.common.blocks[0].title = 'Legacy block title';
  const preserved = queue.pageBuilder.write(job.id, read.revision, read.document, 1);
  assert.deepEqual(preserved.document.common.blocks[0].items[0], legacy.document.common.blocks[0].items[0]);
});
