'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { BegetSync, desired, legacyId, destinationIdentity } = require('../src/stages/beget/sync.cjs');
const { PageBuilderStore } = require('../src/stages/page-builder/store.cjs');
const { atomicJson } = require('../src/infrastructure/files.cjs');
const { loadConfig } = require('../src/stages/beget/config.cjs');
const { testTempRoot } = require('./support.cjs');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const review = () => ({ status: 'unreviewed', reason: '' });
const destination = { host: 'ssh.example.test', user: 'account', port: 22, remoteScript: '/home/account/site/rest/arm_sync.php', phpBinary: 'php7.4' };
function server() {
  const api = { calls: [], applies: [], operations: new Map(), revision: 0, fingerprint: hash(0), offline: false, loseNext: false, nextId: 100,
    bindings: { tabs: {}, blocks: {}, content: {}, media: {}, files: {} }, blockTabs: {} };
  api.request = async body => {
    api.calls.push(body); if (api.offline) throw new Error('socket disconnected'); let result;
    if (body.action === 'lookup_company') result = { company: { id: 987, old_id: body.old_id, name: 'Example' } };
    if (body.action === 'state') result = { revision: api.revision, fingerprint: api.fingerprint, live_fingerprint: api.fingerprint, epoch: api.epoch || 0, bindings: structuredClone(api.bindings), block_tabs: structuredClone(api.blockTabs) };
    if (body.action === 'operation_status') result = api.operations.has(body.operation_id) ? { state: 'applied', result: api.operations.get(body.operation_id) } : { state: 'not_found' };
    assert.notEqual(body.action, 'apply', 'whole-page apply is prohibited');
    if (body.action === 'apply_object') {
      assert.equal(Object.hasOwn(body, 'snapshot'), false); assert.equal(body.base_revision, api.revision); assert.equal(body.base_fingerprint, api.fingerprint);
      const obj = body.object, kind = obj.kind === 'tab' ? 'tabs' : 'blocks', current = api.bindings[kind][obj.local_id];
      if (obj.action !== 'create') assert.equal(obj.id, current); else assert.equal(current, undefined);
      const id = obj.action === 'create' ? ++api.nextId : current;
      if (kind === 'blocks') {
        if (obj.tab_id) assert.ok(Object.values(api.bindings.tabs).includes(obj.tab_id));
        if (obj.action !== 'create') assert.equal(obj.previous_tab_id || 0, api.blockTabs[obj.local_id]);
        if (obj.action === 'delete') delete api.blockTabs[obj.local_id]; else api.blockTabs[obj.local_id] = obj.tab_id || 0;
      } else if (obj.action === 'delete') assert.ok(!Object.values(api.blockTabs).includes(id));
      if (obj.action === 'delete') delete api.bindings[kind][obj.local_id]; else api.bindings[kind][obj.local_id] = id;
      for (const media of obj.media || []) api.bindings.media[media.local_id] ||= ++api.nextId;
      for (const file of obj.files || []) api.bindings.files[file.local_id] ||= ++api.nextId;
      if (kind === 'blocks' && !['delete', 'move'].includes(obj.action)) api.bindings.content[obj.local_id] = Object.fromEntries(obj.value.content.map(item => [item.local_id, item.id || ++api.nextId]));
      api.applies.push(structuredClone(body)); api.revision++; api.epoch = body.epoch; api.fingerprint = hash(api.revision);
      result = { ok: true, operation_id: body.operation_id, epoch: body.epoch, revision: api.revision, fingerprint: api.fingerprint, bindings: structuredClone(api.bindings), block_tabs: structuredClone(api.blockTabs), object: { kind: obj.kind, action: obj.action, local_id: obj.local_id, id } };
      api.operations.set(body.operation_id, result); if (api.loseNext) { api.loseNext = false; throw new Error('response lost after commit'); }
    }
    return { ok: true, ...result };
  }; return api;
}
function fixture(t, api = server()) {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'arm-beget-sync-'));
  const job = { id: crypto.randomUUID(), url: 'https://mori-cinema.reestr35.ru/', attempts: [{ number: 1, htmlMedia: { status: 'complete' } }] };
  const queue = { root, jobs: [job], get(id) { assert.equal(id, job.id); return job; }, stage: {} };
  queue.pageBuilder = new PageBuilderStore(root, id => queue.get(id));
  const attach = target => { const sync = new BegetSync(queue, { destination: target || destination, transport: api.request, autoStart: false, clock: () => Number.MAX_SAFE_INTEGER / 2 }); queue.pageBuilder.sync = sync; return sync; };
  let sync = attach();
  const edit = change => {
    const old = queue.pageBuilder.read(job.id), doc = structuredClone(old.document); change(doc);
    return queue.pageBuilder.write(job.id, old.revision, doc, old.attempt);
  };
  const create = (title = 'Первая') => edit(doc => { doc.common.blocks.push({ id: 'block-one', type: 'content', view: 'default', title, text: 'Текст', media: [], review: review() }); });
  const tick = async () => { const rec = sync.record(job.id, job.attempts.at(-1).number); rec.nextAt = 0; await sync.tick(); };
  t.after(async () => { await sync.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { api, queue, job, edit, create, tick, get sync() { return sync; }, async restart(target) { await sync.shutdown(); sync = attach(target); } };
}

test('domain lookup normalizes host but refuses unknown or duplicate identity', () => {
  assert.equal(legacyId('https://WWW.EXAMPLE.test./', { 42: 'example.test' }), 42);
  assert.throws(() => legacyId('example.test', { 1: 'example.test', 2: 'www.example.test' }), /единственное/);
  assert.throws(() => legacyId('missing.test', { 1: 'example.test' }), /единственное/);
});

test('summary-only page builder does not break sync snapshots or bypass destination checks', async t => {
  const f = fixture(t); f.create(); await f.tick();
  f.queue.pageBuilder = { summary() { return { status: 'unreviewed' }; } };
  assert.equal(f.sync.snapshot().connection, 'online');
  assert.throws(() => f.sync.record(f.job.id, 999), /Попытка синхронизации/);
  f.sync.destination = destinationIdentity({ ...destination, host: 'different.example.test' });
  const snapshot = f.sync.snapshot();
  assert.equal(snapshot.connection, 'error'); assert.match(snapshot.lastError, /Назначение SSH Beget изменилось/);
  const calls = f.api.calls.length; await f.tick(); assert.equal(f.api.calls.length, calls);
});

test('changing SSH destination after lookup blocks all requests before apply and preserves local editing', async t => {
  const f = fixture(t); f.create(); const original = f.sync.transport;
  f.sync.transport = body => body.action === 'state' ? Promise.reject(new Error('interrupted after company lookup')) : original(body);
  await f.tick();
  const record = f.sync.record(f.job.id, 1), savedDestination = record.destination, calls = f.api.calls.length;
  assert.equal(record.company.id, 987); assert.equal(record.inFlight, null); assert.equal(f.api.applies.length, 0);
  assert.equal(savedDestination, destinationIdentity(destination));
  assert.equal(JSON.parse(fs.readFileSync(f.sync.file(f.job.id))).destination, savedDestination);
  for (const change of [{ host: 'other.example.test' }, { user: 'other-account' }, { port: 2222 }, { remoteScript: '/other/site/rest/arm_sync.php' }, { phpBinary: 'php8.3' }]) {
    await f.restart({ ...destination, ...change });
    const local = f.edit(doc => { doc.common.blocks[0].title = `Локальная правка ${Object.keys(change)[0]}`; });
    await f.tick();
    assert.equal(f.api.calls.length, calls, 'neither apply, readback nor ping can go to the changed destination');
    assert.equal(local.sync.blocks['block-one'].status, 'pending'); assert.equal(local.sync.companyId, null);
    assert.match(local.sync.lastError, /Назначение SSH Beget изменилось/);
    assert.equal(f.sync.snapshot().connection, 'error');
    assert.equal(f.sync.record(f.job.id, 1).destination, savedDestination);
  }
  await f.restart(destination); await f.tick(); assert.equal(f.api.applies.length, 1);
});

test('destination mismatch never adopts an uncertain operation or accepts its acknowledgment', async t => {
  const f = fixture(t); f.create(); f.api.loseNext = true; await f.tick();
  const before = structuredClone(f.sync.record(f.job.id, 1)), calls = f.api.calls.length;
  const result = f.api.operations.get(before.inFlight.operationId);
  await f.restart({ ...destination, remoteScript: '/other/rest/arm_sync.php' }); await f.tick();
  const record = f.sync.record(f.job.id, 1);
  assert.equal(f.api.calls.length, calls); assert.deepEqual(record.inFlight, before.inFlight);
  assert.throws(() => f.sync.acknowledge(record, result), /Назначение SSH Beget изменилось/);
  assert.deepEqual(record.inFlight, before.inFlight); assert.equal(record.acknowledged, null);
  await f.restart(destination); await f.tick(); assert.equal(f.api.calls.at(-1).action, 'operation_status');
  assert.equal(f.api.applies.length, 1); assert.equal(f.sync.record(f.job.id, 1).inFlight, null);
});

test('legacy journals with remote evidence require explicit reconciliation, while an empty journal binds before lookup', async t => {
  const f = fixture(t); f.create(); await f.tick();
  const record = f.sync.record(f.job.id, 1); delete record.destination; f.sync.persist(record);
  const calls = f.api.calls.length; await f.restart(); await f.tick();
  assert.equal(f.api.calls.length, calls); assert.match(f.queue.pageBuilder.read(f.job.id).sync.lastError, /не содержит привязки/);
  assert.equal(f.queue.pageBuilder.read(f.job.id).sync.blocks['block-one'].status, 'pending');
  assert.equal(f.sync.record(f.job.id, 1).destination, undefined);
  const empty = fixture(t); empty.create(); empty.sync.persist(empty.sync.record(empty.job.id, 1)); await empty.restart();
  const request = empty.sync.transport;
  empty.sync.transport = body => {
    if (body.action === 'lookup_company') assert.equal(JSON.parse(fs.readFileSync(empty.sync.file(empty.job.id))).destination, destinationIdentity(destination));
    return request(body);
  };
  await empty.tick(); assert.equal(empty.api.applies.length, 1);
});

test('local portable SSH configuration validates paths and supports environment overrides without exposing credentials in status', async t => {
  const f = fixture(t), file = path.join(f.queue.root, 'beget-sync-config.json');
  const identityFile = path.join(f.queue.root, 'test-key'); fs.writeFileSync(identityFile, 'dummy fixture, never used to connect');
  atomicJson(file, { host: 'beget.example', user: 'test-user', identityFile, remoteScript: '/home/test/public_html/rest/arm_sync.php' });
  assert.equal(loadConfig(f.queue.root, {}).identityFile, identityFile);
  assert.equal(loadConfig(f.queue.root, { ARM_BEGET_SSH_PORT: '2222' }).port, 2222);
  assert.throws(() => loadConfig(f.queue.root, { ARM_BEGET_SSH_HOST: '-oProxyCommand=bad' }), /host/);
  assert.throws(() => loadConfig(f.queue.root, { ARM_BEGET_REMOTE_SCRIPT: '/home/test/rest/other.php' }), /remoteScript/);
  assert.equal(JSON.stringify(f.sync.snapshot()).includes(identityFile), false);
  atomicJson(file, { host: 'beget.example' });
  const invalid = new BegetSync(f.queue, { autoStart: false });
  assert.equal(invalid.connection, 'unconfigured'); assert.match(invalid.lastError, /user/); await invalid.shutdown();
});

test('offline saves coalesce, survive restart and preserve remote IDs on updates/deletes', async t => {
  const f = fixture(t); f.api.offline = true;
  const first = f.create(); assert.equal(first.sync.blocks['block-one'].status, 'pending');
  await f.tick(); assert.equal(f.sync.connection, 'offline');
  f.edit(doc => { doc.common.blocks[0].title = 'Вторая'; });
  f.edit(doc => { doc.common.blocks[0].title = 'Последняя'; });
  assert.equal(f.api.applies.length, 0);
  await f.restart(); f.api.offline = false; await f.tick();
  assert.equal(f.api.applies.length, 1); assert.equal(f.api.applies[0].object.value.name, 'Последняя');
  let page = f.queue.pageBuilder.read(f.job.id); assert.equal(page.sync.blocks['block-one'].status, 'synced');
  f.edit(doc => { doc.common.blocks[0].title = 'Правка'; }); await f.tick();
  assert.equal(f.api.applies[1].object.id, page.sync.blocks['block-one'].bitrixId);
  f.edit(doc => { doc.common.blocks = []; }); await f.tick();
  assert.equal(f.api.applies[2].object.action, 'delete'); assert.equal(f.api.applies[2].object.id, page.sync.blocks['block-one'].bitrixId);
});

test('lost response is read back before sending newer state and old receipt cannot unlock changed block', async t => {
  const f = fixture(t); f.create(); f.api.loseNext = true; await f.tick();
  assert.equal(f.api.applies.length, 1); assert.ok(f.sync.record(f.job.id, 1).inFlight);
  f.edit(doc => { doc.common.blocks[0].text = 'Правка в ожидании'; });
  await f.restart(); await f.tick();
  assert.equal(f.api.calls.at(-1).action, 'operation_status'); assert.equal(f.api.applies.length, 1);
  assert.equal(f.queue.pageBuilder.read(f.job.id).sync.blocks['block-one'].status, 'pending');
  await f.tick(); assert.equal(f.api.applies.length, 2);
  assert.equal(f.queue.pageBuilder.read(f.job.id).sync.blocks['block-one'].status, 'synced');
});

test('uncertain newer publication keeps restored older content pending and review locked', async t => {
  const f = fixture(t); f.create('Версия А'); await f.tick();
  f.edit(doc => { doc.common.blocks[0].title = 'Версия Б'; });
  f.api.loseNext = true; await f.tick();
  assert.equal(f.api.applies.length, 2);
  const restored = f.edit(doc => { doc.common.blocks[0].title = 'Версия А'; });
  assert.equal(restored.sync.blocks['block-one'].status, 'pending');
  assert.throws(() => f.edit(doc => { doc.common.blocks[0].review.status = 'passed'; }), /дождитесь отправки/);
});

test('readback not_found never applies an object changed during the request', async t => {
  const f = fixture(t); f.create('Старая'); const remote = f.sync.transport;
  f.sync.transport = body => body.action === 'apply_object' ? Promise.reject(new Error('request lost before apply')) : remote(body);
  await f.tick(); f.sync.transport = remote;
  const original = f.sync.transport; let changed = false;
  f.sync.transport = body => {
    if (body.action === 'operation_status' && !changed) {
      changed = true; f.edit(doc => { doc.common.blocks[0].title = 'Новая'; });
      return Promise.resolve({ ok: true, state: 'not_found' });
    }
    return original(body);
  };
  await f.tick(); assert.equal(f.api.applies.length, 0);
  await f.tick(); assert.equal(f.api.applies.length, 1);
  assert.equal(f.api.applies[0].object.value.name, 'Новая');
});

test('review is locked until current content acknowledgment, changes reset it, review-only writes need no publication', async t => {
  const f = fixture(t); f.create();
  assert.throws(() => f.edit(doc => { doc.common.blocks[0].review.status = 'passed'; }), /дождитесь отправки/);
  await f.tick();
  const checked = f.edit(doc => { doc.common.blocks[0].review.status = 'passed'; });
  assert.equal(checked.document.common.blocks[0].review.status, 'passed'); await f.tick(); assert.equal(f.api.applies.length, 1);
  const changed = f.edit(doc => { doc.common.blocks[0].title = 'Изменено'; doc.common.blocks[0].reviewedRevision = checked.revision; });
  assert.equal(changed.document.common.blocks[0].review.status, 'unreviewed'); assert.equal(changed.sync.blocks['block-one'].status, 'pending');
});

test('new attempt does not erase published page until explicit eligible save, old receipt stays historical', async t => {
  const f = fixture(t); f.create(); f.api.loseNext = true; await f.tick();
  f.job.attempts.push({ number: 2, htmlMedia: { status: 'complete' } });
  f.queue.pageBuilder.read(f.job.id); await f.tick(); assert.equal(f.api.applies.length, 1);
  f.create('Новая попытка'); await f.tick(); // First read back attempt 1.
  assert.equal(f.queue.pageBuilder.read(f.job.id).sync.blocks['block-one'].status, 'pending');
  await f.tick(); assert.equal(f.api.applies.length, 2); assert.equal(f.api.applies[1].epoch, 2);
  assert.equal(f.api.applies[1].scope_id, f.api.applies[0].scope_id);
  assert.equal(f.queue.pageBuilder.read(f.job.id, { attempt: 1 }).sync.blocks['block-one'].status, 'pending');
});

test('document committed directly by media recovery is discovered without an outbox callback', async t => {
  const f = fixture(t); f.create(); await f.tick();
  const page = f.queue.pageBuilder.read(f.job.id), document = structuredClone(page.document); document.common.blocks[0].text = 'После восстановления удаления';
  atomicJson(f.queue.pageBuilder.file(f.job.id, 1), { revision: page.revision + 1, updatedAt: new Date().toISOString(), document, syncRequested: true });
  await f.restart(); await f.tick();
  assert.equal(f.api.applies.length, 2); assert.equal(f.api.applies[1].object.value.content[0].properties.text, '<p>После восстановления удаления</p>');
});

test('external server changes block publication without blocking local saves', async t => {
  const f = fixture(t); f.create(); await f.tick();
  f.api.fingerprint = hash('external'); f.edit(doc => { doc.common.blocks[0].title = 'Правка'; }); await f.tick();
  assert.equal(f.api.applies.length, 1); assert.match(f.queue.pageBuilder.read(f.job.id).sync.lastError, /изменена извне/);
  f.edit(doc => { doc.common.blocks[0].title = 'Ещё правка'; });
  assert.equal(f.queue.pageBuilder.read(f.job.id).document.common.blocks[0].title, 'Ещё правка');
});

test('unresolved operation remains pending with explicit diagnosis and is never replayed', async t => {
  const f = fixture(t); f.create(); f.api.loseNext = true; await f.tick();
  const original = f.sync.transport;
  f.sync.transport = body => body.action === 'operation_status'
    ? Promise.resolve({ ok: true, state: 'requires_reconciliation' }) : original(body);
  await f.tick(); await f.tick();
  assert.equal(f.api.applies.length, 1); assert.ok(f.sync.record(f.job.id, 1).inFlight);
  const stored = f.queue.pageBuilder.read(f.job.id);
  assert.equal(stored.sync.blocks['block-one'].status, 'pending'); assert.match(stored.sync.lastError, /требуется сверка/);
});

test('idle queue monitors connectivity through authenticated ping', async t => {
  const f = fixture(t); await f.tick(); assert.equal(f.api.calls.at(-1).action, 'ping'); assert.equal(f.sync.connection, 'online');
});

test('large binaries use resumable chunks and durable local blobs, apply and later text edits contain metadata only', async t => {
  const api = server(), basicRequest = api.request, uploaded = new Map(); let lose = true, chunks = 0;
  api.request = async body => {
    if (body.action !== 'upload_chunk') return basicRequest(body);
    api.calls.push(body); chunks++;
    const bytes = Buffer.from(body.base64, 'base64'); assert.ok(bytes.length <= 384 * 1024);
    const existing = uploaded.get(body.asset.sha256) || Buffer.alloc(0);
    let current = existing;
    if (body.offset === existing.length) { current = Buffer.concat([existing, bytes]); uploaded.set(body.asset.sha256, current); }
    else assert.deepEqual(existing.subarray(body.offset, body.offset + bytes.length), bytes);
    if (lose && chunks === 2) { lose = false; throw new Error('lost chunk acknowledgment'); }
    return { ok: true, sha256: body.asset.sha256, offset: current.length, complete: current.length === body.asset.size };
  };
  const f = fixture(t, api), bytes = crypto.randomBytes(900 * 1024), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const serialize = async (document, options) => {
    const snapshot = await require('../src/stages/beget/serialize.cjs').serialize(document, options);
    snapshot.files.push({ local_id: 'file-transport', name: 'sample.pdf', sha256, ...(options.acknowledgedAssets?.files?.['file-transport'] === sha256 ? {} : { base64: bytes.toString('base64') }) });
    return snapshot;
  };
  f.sync.serialize = serialize; f.create(); await f.tick();
  const record = f.sync.record(f.job.id, 1), durable = fs.readFileSync(f.sync.file(f.job.id), 'utf8');
  assert.ok(record.inFlight); assert.ok(durable.length < 10000); assert.equal(durable.includes('base64'), false);
  assert.equal(api.applies.length, 0);
  await f.restart(); f.sync.serialize = serialize; await f.tick();
  assert.equal(api.applies.length, 1); assert.deepEqual(uploaded.get(sha256), bytes);
  assert.equal(JSON.stringify(api.applies[0]).includes('base64'), false);
  const sentChunks = chunks; f.edit(doc => { doc.common.blocks[0].title = 'Только текст'; }); await f.tick();
  assert.equal(api.applies.length, 2); assert.equal(chunks, sentChunks, 'acknowledged files are not uploaded again');
  assert.deepEqual(fs.readdirSync(path.join(f.sync.root, f.job.id, 'blobs')), []);
});

const block = (id, extra = {}) => ({ id, type: 'content', view: 'default', title: id, text: 'Текст', media: [], review: review(), ...extra });
const tab = (id, blocks = []) => ({ id, title: id, blocks, review: review() });
test('local saves durably coalesce each object and cancel creations deleted before sending', async t => {
  const f = fixture(t); f.create();
  f.edit(doc => { doc.common.blocks[0].title = 'Последняя'; doc.common.blocks.push(block('transient')); doc.tabs.push(tab('transient-tab', [block('child')])); });
  f.edit(doc => { doc.common.blocks.pop(); doc.tabs = []; });
  const saved = JSON.parse(fs.readFileSync(f.sync.file(f.job.id)));
  assert.equal(saved.version, 2); assert.deepEqual(Object.keys(saved.pending), ['blocks:block-one']);
  assert.equal(saved.pending['blocks:block-one'].data.title, 'Последняя');
  await f.restart(); await f.tick(); assert.equal(f.api.applies.length, 1);
  f.edit(doc => doc.common.blocks.push(block('other'))); await f.tick();
  assert.equal(f.api.applies.length, 2); assert.equal(f.api.applies[1].object.local_id, 'other');
  f.edit(doc => { doc.common.blocks[0].title = 'Only changed'; }); await f.tick();
  assert.equal(f.api.applies.length, 3); assert.equal(f.api.applies[2].object.local_id, 'block-one');
});
test('tab creation precedes its children and block deletion precedes tab deletion with confirmed IDs', async t => {
  const f = fixture(t); f.edit(doc => doc.tabs.push(tab('parent', [block('child')]))); await f.tick();
  assert.deepEqual(f.api.applies.map(item => [item.object.kind, item.object.action]), [['tab', 'create'], ['block', 'create']]);
  const parentId = f.api.bindings.tabs.parent, childId = f.api.bindings.blocks.child;
  assert.equal(f.api.applies[1].object.tab_id, parentId);
  f.edit(doc => { doc.tabs = []; }); await f.tick();
  assert.deepEqual(f.api.applies.slice(2).map(item => [item.object.kind, item.object.action]), [['block', 'delete'], ['tab', 'delete']]);
  assert.equal(f.api.applies[2].object.id, childId); assert.equal(f.api.applies[2].object.previous_tab_id, parentId); assert.equal(f.api.applies[3].object.id, parentId);
});
test('moving a block uses both parent IDs and finishes before removing its source tab', async t => {
  const f = fixture(t); f.edit(doc => doc.tabs.push(tab('source', [block('child')]), tab('target'))); await f.tick();
  const source = f.api.bindings.tabs.source, target = f.api.bindings.tabs.target, child = f.api.bindings.blocks.child;
  f.edit(doc => { doc.tabs[1].blocks.push(doc.tabs[0].blocks.pop()); doc.tabs.shift(); }); await f.tick();
  const move = f.api.applies.find(item => item.object.kind === 'block' && item.object.action === 'move');
  assert.equal(move.object.id, child); assert.equal(move.object.previous_tab_id, source); assert.equal(move.object.tab_id, target);
  assert.equal(Object.hasOwn(move.object.value, 'content'), false); assert.equal(Object.hasOwn(move.object, 'media'), false);
  assert.equal(f.api.applies.at(-1).object.action, 'delete'); assert.equal(f.api.applies.at(-1).object.id, source);
});
test('gallery placeholders stay local; a broken real reference only blocks its own object', async t => {
  const f = fixture(t); f.edit(doc => {
    doc.common.blocks.push(block('gallery', { type: 'grid', view: 'gallery', media: [{ id: 'empty' }], items: [{ id: 'item-a', image_asset_id: 'empty' }] }));
    doc.common.blocks.push(block('broken', { type: 'grid', view: 'gallery', media: [{ id: 'missing', originalUrl: 'https://source.test/image.png' }], items: [{ id: 'item-b', image_asset_id: 'missing' }] }), block('healthy'));
  }); await f.tick();
  assert.deepEqual(f.api.applies.map(item => item.object.local_id), ['gallery', 'healthy']);
  const page = f.queue.pageBuilder.read(f.job.id);
  assert.equal(page.sync.blocks.gallery.status, 'synced'); assert.equal(page.sync.blocks.healthy.status, 'synced');
  assert.equal(page.sync.blocks.broken.status, 'pending'); assert.match(page.sync.blocks.broken.error, /проверенной/);
  assert.equal(page.document.common.blocks[0].media[0].id, 'empty');
  assert.equal(Object.hasOwn(f.api.applies[0].object.value.content[1].properties, 'image'), false);
  f.edit(doc => { doc.common.blocks[1].items[0].image_asset_id = ''; doc.common.blocks[1].media = []; }); await f.tick();
  assert.equal(f.api.applies.at(-1).object.local_id, 'broken'); assert.equal(f.queue.pageBuilder.read(f.job.id).sync.pendingCount, 0);
});
test('deletion during an uncertain create preserves immutable flight and deletes its acknowledged ID afterwards', async t => {
  const f = fixture(t); f.create(); f.api.loseNext = true; await f.tick();
  const flight = structuredClone(f.sync.record(f.job.id, 1).inFlight);
  f.edit(doc => { doc.common.blocks = []; }); assert.deepEqual(f.sync.record(f.job.id, 1).inFlight, flight);
  await f.restart(); await f.tick(); assert.equal(f.api.calls.at(-1).action, 'operation_status'); await f.tick();
  assert.equal(f.api.applies.length, 2); assert.equal(f.api.applies[1].object.action, 'delete');
  assert.equal(f.api.applies[1].object.id, f.api.operations.get(f.api.applies[0].operation_id).object.id);
  assert.deepEqual(f.sync.record(f.job.id, 1).pending, {});
});
test('an uncertain edit locks only its own object, not already confirmed blocks', async t => {
  const f = fixture(t); f.create(); f.edit(doc => doc.common.blocks.push(block('stable'))); await f.tick();
  f.edit(doc => { doc.common.blocks[0].title = 'Changed'; }); f.api.loseNext = true; await f.tick();
  const page = f.queue.pageBuilder.read(f.job.id); assert.equal(page.sync.blocks['block-one'].status, 'pending'); assert.equal(page.sync.blocks.stable.status, 'synced');
  assert.throws(() => f.edit(doc => { doc.common.blocks[0].review.status = 'passed'; }), /дождитесь отправки/);
  f.edit(doc => { doc.common.blocks[1].review.status = 'passed'; });
});
test('v1 migration preserves original bytes and adopts a legacy receipt without replaying its snapshot', async t => {
  const f = fixture(t); f.create(); const page = f.queue.pageBuilder.read(f.job.id), operationId = crypto.randomUUID();
  const old = { version: 1, jobId: f.job.id, scopeId: f.job.id, destination: destinationIdentity(destination), company: { id: 987 }, acknowledged: null, nextAt: 0,
    inFlight: { operationId, attempt: 1, target: desired(page.document), documentRevision: page.revision, baseRevision: 0, applyStarted: true, snapshot: { media: [], files: [] } } };
  atomicJson(f.sync.file(f.job.id), old); f.api.revision = 1; f.api.fingerprint = hash(1); f.api.bindings.blocks['block-one'] = 101; f.api.blockTabs['block-one'] = 0;
  f.api.operations.set(operationId, { ok: true, operation_id: operationId, epoch: 1, revision: 1, fingerprint: hash(1), bindings: structuredClone(f.api.bindings) });
  await f.restart(); await f.tick(); assert.equal(f.api.calls.at(-1).action, 'operation_status'); assert.equal(f.api.applies.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f.sync.file(f.job.id)}.v1-backup`)), old);
  f.edit(doc => { doc.common.blocks[0].title = 'Обновление'; }); await f.tick();
  assert.equal(f.api.applies[0].object.id, 101); assert.equal(f.api.applies[0].object.previous_tab_id, null);
});
test('legacy not_found abandons the snapshot and builds object deltas from the current local document', async t => {
  const f = fixture(t); f.create(); const page = f.queue.pageBuilder.read(f.job.id), rec = f.sync.record(f.job.id, 1);
  atomicJson(f.sync.file(f.job.id), { ...rec, version: 1, destination: destinationIdentity(destination), company: { id: 987 }, inFlight: { operationId: crypto.randomUUID(), attempt: 1, target: desired(page.document), snapshot: { tabs: [], blocks: [], media: [], files: [] }, baseRevision: 0, applyStarted: true } });
  await f.restart(); await f.tick(); assert.equal(f.api.applies.length, 0); assert.equal(f.sync.record(f.job.id, 1).inFlight, null);
  await f.tick(); assert.equal(f.api.applies.length, 1); assert.equal(f.api.applies[0].action, 'apply_object');
});

test('identical objects in a new attempt adopt their confirmed IDs after state readback without any writes', async t => {
  const f = fixture(t); f.edit(doc => doc.tabs.push(tab('parent', [block('child')]))); await f.tick();
  const original = structuredClone(f.queue.pageBuilder.read(f.job.id).document), writes = f.api.applies.length;
  const tabId = f.api.bindings.tabs.parent, blockId = f.api.bindings.blocks.child;
  f.job.attempts.push({ number: 2, htmlMedia: { status: 'complete' } });
  const pending = f.edit(doc => { doc.tabs = original.tabs; });
  assert.equal(pending.sync.blocks.child.status, 'pending'); assert.equal(f.sync.record(f.job.id, 2).acknowledged.attempt, 1);
  assert.deepEqual(f.sync.record(f.job.id, 2).pending, {});
  assert.throws(() => f.edit(doc => { doc.tabs[0].blocks[0].review.status = 'passed'; }), /дождитесь отправки/);
  const calls = f.api.calls.length; await f.tick();
  assert.deepEqual(f.api.calls.slice(calls).map(request => request.action), ['state']); assert.equal(f.api.applies.length, writes);
  const page = f.queue.pageBuilder.read(f.job.id);
  assert.equal(page.sync.pendingCount, 0); assert.deepEqual(page.sync.tabs.parent, { status: 'synced', bitrixId: tabId });
  assert.deepEqual(page.sync.blocks.child, { status: 'synced', bitrixId: blockId });
  assert.equal(f.sync.record(f.job.id, 2).acknowledged.confirmedByState.attempt, 2);
  f.edit(doc => { doc.tabs[0].blocks[0].review.status = 'passed'; }); await f.tick(); assert.equal(f.api.applies.length, writes);
  await f.restart(); assert.equal(f.queue.pageBuilder.read(f.job.id).sync.blocks.child.status, 'synced');
});

test('a mixed new attempt confirms identical objects and sends only the changed block', async t => {
  const f = fixture(t); f.create('same'); f.edit(doc => doc.common.blocks.push(block('changed'))); await f.tick();
  const original = structuredClone(f.queue.pageBuilder.read(f.job.id).document), writes = f.api.applies.length;
  const stableId = f.api.bindings.blocks['block-one'], changedId = f.api.bindings.blocks.changed;
  f.job.attempts.push({ number: 2, htmlMedia: { status: 'complete' } });
  f.edit(doc => { doc.common.blocks = original.common.blocks; doc.common.blocks[1].title = 'new content'; }); await f.tick();
  assert.equal(f.api.applies.length, writes + 1); assert.equal(f.api.applies.at(-1).object.local_id, 'changed');
  assert.equal(f.api.applies.at(-1).object.id, changedId); assert.equal(f.api.applies.at(-1).epoch, 2);
  const page = f.queue.pageBuilder.read(f.job.id);
  assert.deepEqual(page.sync.blocks['block-one'], { status: 'synced', bitrixId: stableId }); assert.equal(page.sync.blocks.changed.status, 'synced');
  f.edit(doc => { doc.common.blocks[0].review.status = 'passed'; });
});

test('state adoption confirms unchanged blocks even if the changed object fails local serialization', async t => {
  const f = fixture(t); f.create('same'); f.edit(doc => doc.common.blocks.push(block('changed'))); await f.tick();
  const original = structuredClone(f.queue.pageBuilder.read(f.job.id).document), writes = f.api.applies.length;
  f.job.attempts.push({ number: 2, htmlMedia: { status: 'complete' } });
  f.edit(doc => { doc.common.blocks = original.common.blocks; doc.common.blocks[1].title = 'new content'; });
  f.sync.serialize = async () => { throw Object.assign(new Error('fixture invalid asset'), { code: 'BEGET_SERIALIZE' }); };
  await f.tick(); assert.equal(f.api.applies.length, writes);
  const page = f.queue.pageBuilder.read(f.job.id);
  assert.equal(page.sync.blocks['block-one'].status, 'synced'); assert.equal(page.sync.blocks.changed.status, 'pending');
  assert.equal(page.sync.pendingCount, 1); f.edit(doc => { doc.common.blocks[0].review.status = 'passed'; });
  assert.throws(() => f.edit(doc => { doc.common.blocks[1].review.status = 'passed'; }), /дождитесь отправки/);
});

test('an old uncertain receipt cannot confirm different current content before state adoption', async t => {
  const f = fixture(t); f.create('old'); f.edit(doc => doc.common.blocks.push(block('stable'))); await f.tick();
  f.edit(doc => { doc.common.blocks[0].title = 'uncertain'; }); const original = structuredClone(f.queue.pageBuilder.read(f.job.id).document);
  f.api.loseNext = true; await f.tick(); const writes = f.api.applies.length;
  f.job.attempts.push({ number: 2, htmlMedia: { status: 'complete' } });
  f.edit(doc => { doc.common.blocks = original.common.blocks; doc.common.blocks[0].title = 'current'; }); await f.tick();
  assert.equal(f.api.calls.at(-1).action, 'operation_status'); assert.equal(f.sync.record(f.job.id, 2).acknowledged.attempt, 1);
  assert.equal(f.queue.pageBuilder.read(f.job.id).sync.blocks['block-one'].status, 'pending');
  assert.throws(() => f.edit(doc => { doc.common.blocks[0].review.status = 'passed'; }), /дождитесь отправки/);
  await f.tick(); assert.equal(f.api.applies.length, writes + 1); assert.equal(f.api.applies.at(-1).object.value.name, 'current');
  assert.equal(f.queue.pageBuilder.read(f.job.id).sync.blocks.stable.status, 'synced');
});

test('new attempt adoption rejects changed fingerprints, bindings and parent ownership without writes', async t => {
  for (const corruption of ['fingerprint', 'bindings', 'parent']) {
    const f = fixture(t); f.edit(doc => doc.tabs.push(tab('parent', [block('child')]))); await f.tick();
    const original = structuredClone(f.queue.pageBuilder.read(f.job.id).document), writes = f.api.applies.length;
    f.job.attempts.push({ number: 2, htmlMedia: { status: 'complete' } }); f.edit(doc => { doc.tabs = original.tabs; });
    const transport = f.sync.transport; f.sync.transport = async body => {
      const response = await transport(body); if (body.action === 'state') {
        if (corruption === 'fingerprint') response.live_fingerprint = hash('external');
        if (corruption === 'bindings') response.bindings.blocks.child++;
        if (corruption === 'parent') response.block_tabs.child = 0;
      } return response;
    };
    await f.tick(); assert.equal(f.api.applies.length, writes); assert.equal(f.sync.record(f.job.id, 2).acknowledged.attempt, 1);
    assert.equal(f.queue.pageBuilder.read(f.job.id).sync.blocks.child.status, 'pending');
  }
});
