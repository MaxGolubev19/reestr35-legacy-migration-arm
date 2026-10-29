'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { Queue, createServer } = require('../src/server.cjs');
const { BUILDER_POLICY, buildBuilderPrompt } = require('../src/stages/page-builder/agent/policy.cjs');
const { isPristine } = require('../src/stages/page-builder/store.cjs');
const { layout } = require('../src/lib.cjs');
const { atomicJson } = require('../src/qa.cjs');
const { publishLease } = require('../src/launcher.cjs');
const { testTempRoot } = require('./support.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=', 'base64');
const PDF = Buffer.from('%PDF-1.7\nexample\n%%EOF');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ZERO_SHA = '0'.repeat(64);
const HOST = 'builder.reestr35.ru';
const HTML = `<html><body><h1>Тестовая страница</h1><img src="/photo.png" alt="Фото"><a href="/price.pdf">Прайс</a><iframe src="https://rutube.ru/play/embed/test/" title="Видео"></iframe></body></html>`;

// A stand-in app server shaped exactly like the QA test fake: assemble()
// returns a session that relays straight into the runner callbacks.
function fakeAppServers() {
  const appServers = [], sessions = [];
  const factory = () => {
    const appServer = { async shutdown() {}, assemble(config) {
      const session = new EventEmitter();
      Object.assign(session, { isBuilder: true, exitCode: null, config, threadId: crypto.randomUUID(), turnId: crypto.randomUUID() });
      session.bind = () => config.onIdentity({ appServerPid: 950000 + sessions.length, threadId: session.threadId, turnId: session.turnId });
      session.identity = extra => ({ generation: config.generation, threadId: session.threadId, turnId: session.turnId, ...(extra || {}) });
      session.read = (args, identity) => config.onReadFile(args, session.identity(identity));
      session.save = (args, identity) => config.onSave(args, session.identity(identity));
      session.finish = (code = 0, failure = null) => { if (session.exitCode !== null) return; session.exitCode = code; session.completionProof = 'app-server-closed'; session.emit('close', code, failure); };
      session.interrupt = async () => session.finish(1);
      sessions.push(session); return session;
    } };
    appServers.push(appServer); return appServer;
  };
  return { factory, appServers, sessions };
}

// Capture report plus a complete step 2 manifest: one downloaded image, one
// downloaded PDF document and one selectable Rutube iframe.
function seedStage2(queue, job, body = HTML) {
  const attempt = job.attempts.at(-1), p = layout(queue.root, job, attempt);
  fs.mkdirSync(p.hostDir, { recursive: true }); fs.writeFileSync(path.join(p.hostDir, '00_страница.png'), PNG);
  atomicJson(p.report, { url: job.url, finalUrl: job.url, model: { layout: 'plain', root: null, groups: [] }, status: 'complete', errors: [], finished: '2026-09-12T00:00:00Z', segments: [{ file: '00_страница.png', spec: { kind: 'page' }, chain: [], box: { x: 0, y: 0, width: 1, height: 1 }, png: { width: 1, height: 1, strips: 1 }, status: 'ok' }] });
  queue.refreshArtifacts(job, attempt);
  attempt.phase = 'qa'; attempt.status = 'complete'; queue.save();
  const manifest = queue.stage.media.create(job, attempt, Buffer.from(body), 'test');
  const mark = (item, bytes, mime, finalUrl) => {
    const sha = sha256(bytes);
    fs.writeFileSync(path.join(queue.stage.media.directory(job, attempt), 'objects', sha), bytes);
    Object.assign(item, { status: 'downloaded', finalUrl, redirects: [], mime, bytes: bytes.length, sha256: sha, object: `objects/${sha}` });
  };
  mark(manifest.resources[0], PNG, 'image/png', `https://${HOST}/photo.png`);
  mark(manifest.resources[1], PDF, 'application/pdf', `https://${HOST}/price.pdf`);
  manifest.status = 'complete';
  queue.stage.media.publish(job, attempt, manifest);
  attempt.status = 'complete'; queue.save();
  return { manifest };
}

function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-agent-'));
  let time = 1000;
  const fake = fakeAppServers();
  const queue = new Queue({ root, autoStart: false, beget: options.beget === undefined ? false : options.beget,
    builderAppServerFactory: fake.factory,
    buildRetryLimit: 0, buildRetryDelayMs: 100, buildIdleTimeoutMs: 600000, clock: () => time, setTimer: () => 1, clearTimer() {},
    ...(options.queue || {}) });
  queue.add(`https://${HOST}/`);
  const job = queue.jobs[0], attempt = job.attempts[0];
  const seeded = seedStage2(queue, job);
  t.after(async () => {
    for (const session of fake.sessions) if (session.exitCode === null) session.finish(1);
    await queue.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, queue, job, attempt, fake, seeded, advance: value => { time += value; } };
}

// Enqueue paths only schedule the start (setImmediate); a flush lets it run.
const flush = () => new Promise(resolve => setImmediate(resolve));

// Stage 1-2 capture workers shaped like the arm.test spawnFn fake: each child
// occupies a shared pool slot until finish() publishes the lease and closes.
function fakeWorkers() {
  const children = [];
  const spawnFn = (command, args, config) => {
    const child = new EventEmitter(); child.pid = 1000 + children.length; child.exitCode = null;
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
    child.finish = code => { publishLease(config.armLaunch.dir, config.armLaunch, { status: 'finished', pid: child.pid, exitCode: code }); child.exitCode = code; child.emit('close', code, null); };
    children.push(child); return child;
  };
  return { children, spawnFn, stopFn: async child => child?.finish(0) };
}

// A setup with fake capture workers so assemblies and stage 1-2 jobs compete
// for the same shared concurrency pool.
const poolSetup = (t, queueOptions = {}) => {
  const workers = fakeWorkers();
  return { ...setup(t, { queue: { ...queueOptions, spawnFn: workers.spawnFn, stopFn: workers.stopFn } }), workers };
};

const review = () => ({ status: 'unreviewed', reason: '' });
const base = (id, type, view) => ({ id, type, view, title: '', text: '', content: '', settings: '', review: review(), media: [] });
function agentDocument(blocks, { hostname = HOST } = {}) {
  return { version: 1, source: { hostname, htmlSha256: ZERO_SHA },
    common: { id: 'common', title: 'Общая часть', review: review(), blocks }, tabs: [] };
}
const textBlock = () => ({ ...base('block-text', 'content', 'default'), title: 'Описание', text: 'Текст раздела' });
const mediaBlock = ref => ({ ...base('block-1', 'big-media', 'hero'), title: 'Баннер', media: [{ id: 'media-1', mediaRef: ref, href: '', alt: 'Фото', caption: '' }] });
const embedBlock = ref => ({ ...base('block-2', 'embed', 'default'), title: 'Видео', frameRef: ref, ratio: '16:9' });
const linksBlock = ref => ({ ...base('block-3', 'links', 'documents'), title: 'Документы', items: [{ id: 'item-1', title: 'Прайс', text: '', link_text: 'Скачать', documentRef: ref, meta: {} }] });
const tabSection = (id, title) => ({ id, title, review: review(), blocks: [{ ...base(`block-${id}`, 'content', 'default'), title: 'Описание', text: 'Текст раздела' }] });

test('step 2 completion assembles the page through the ordinary write path', async t => {
  const ctx = setup(t, { beget: { autoStart: false,
    destination: { host: 'fixture.test', user: 'fixture', remoteScript: '/fixture/rest/arm_sync.php' }, transport: async () => ({ ok: true }) } });
  const { queue, job, attempt, fake } = ctx;
  const statuses = [];
  queue.subscribe('builder', event => statuses.push(event.status));
  queue.builder.consider(job, attempt);
  assert.equal(statuses[0], 'queued', 'enqueue is announced synchronously, before the session starts');
  assert.equal(attempt.builder.status, 'queued');
  await flush();
  assert.equal(attempt.builder.status, 'running'); assert.equal(fake.sessions.length, 1);
  const session = fake.sessions[0];
  session.bind();
  const run = queue.builder.running.get(job.id);
  assert.ok(run, 'the run is registered while the session is open');
  assert.equal(run.catalogs.media.length, 1); assert.equal(run.catalogs.documents.length, 1);
  assert.equal(run.catalogs.frames.length, 1); assert.equal(run.catalogs.frames[0].selectable, true);

  const source = session.read({ name: 'source.html' });
  assert.equal(source.name, 'source.html'); assert.ok(source.content.includes('/photo.png'));
  assert.equal(source.totalChars, source.content.length, 'totalChars counts characters, the read_file offset unit');
  const paged = session.read({ name: 'source.html', offset: 5, length: 10 });
  assert.equal(paged.content, source.content.slice(5, 15)); assert.equal(paged.offset, 5);
  const blocks = session.read({ name: 'block-catalog.json' });
  assert.ok(JSON.parse(blocks.content).blocks.some(item => item.name === 'big-media'));
  const contract = session.read({ name: 'block-contract.json' });
  assert.deepEqual(JSON.parse(contract.content), JSON.parse(fs.readFileSync(path.join(__dirname, '../src/resources/company-block-contract.v1.json'), 'utf8')), 'staging serves a byte-identical copy of the contract snapshot');
  assert.equal(fs.existsSync(path.join(run.stagingDir, 'block-contract.json')), true);
  assert.throws(() => session.read({ name: 'report.json' }), /Файл не входит в список разрешённых/);
  assert.throws(() => session.read({ name: 'source.html', offset: source.totalChars + 1 }), /offset за пределами файла/);

  const answer = session.save({ revision: 1, document: agentDocument([mediaBlock(run.catalogs.media[0].ref)]) });
  assert.deepEqual(answer, { accepted: true, revision: 2 });
  session.finish(0);
  assert.equal(attempt.builder.status, 'complete');
  assert.equal(statuses.at(-1), 'complete');

  const stored = queue.pageBuilder.read(job.id);
  assert.equal(stored.revision, 2); assert.equal(attempt.builder.revision, 2);
  assert.equal(stored.document.source.htmlSha256, ctx.seeded.manifest.source.sha256, 'the pristine save binds the step 2 HTML');
  const asset = stored.document.common.blocks[0].media[0];
  assert.equal(asset.originalUrl, `https://${HOST}/photo.png`);
  assert.equal(asset.originalMedia.sha256, sha256(PNG));
  assert.equal(asset.originalMedia.resourceId, ctx.seeded.manifest.resources[0].id);
  assert.equal(Object.hasOwn(asset, 'mediaRef'), false, 'agent refs never reach the stored document');

  const pageFile = JSON.parse(fs.readFileSync(queue.pageBuilder.file(job.id), 'utf8'));
  assert.equal(pageFile.syncRequested, true, 'the builder publishes through store.write -> sync.enqueue');
  const builderDir = path.join(queue.root, 'page-builder', job.id, 'builder');
  const prompt = fs.readFileSync(path.join(builderDir, 'run-1-prompt.txt'), 'utf8');
  assert.ok(prompt.includes(job.url)); assert.ok(prompt.includes('media-catalog.json'));
  session.config.onLog('turn started\n');
  assert.equal(fs.readFileSync(path.join(builderDir, 'run-1-log.txt'), 'utf8'), 'turn started\n', 'session log lines are appended to the run log');
  session.config.onReasoning('Собираю шапку страницы\n');
  const reasoningLog = path.join(layout(queue.root, job, attempt).dir, 'builder-reasoning.log');
  assert.equal(fs.readFileSync(reasoningLog, 'utf8'), 'Собираю шапку страницы\n', 'builder reasoning streams into its own attempt journal');
  assert.equal(queue.reasoningTails.get(`${job.id}:${attempt.number}`), 'Собираю шапку страницы', 'the shared tail key carries the builder thought');
  assert.equal(fs.existsSync(path.join(layout(queue.root, job, attempt).dir, 'reasoning.log')), false, 'the QA journal stays separate from the builder one');
  assert.equal(fs.existsSync(run.stagingDir), false, 'staging is removed after the session closes');
});

test('consider skips assembly when the step 3 document already has content', t => {
  const { queue, job, attempt, fake } = setup(t);
  queue.pageBuilder.write(job.id, 1, agentDocument([textBlock()]), 1);
  queue.builder.consider(job, attempt);
  assert.equal(attempt.builder.status, 'skipped');
  assert.equal(attempt.builder.error, 'Документ шага 3 уже заполнен');
  assert.equal(fake.sessions.length, 0);
});

test('a stale revision is reported with the current one and the agent recovers', async t => {
  const ctx = setup(t);
  const { queue, job, attempt, fake } = ctx;
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  const manual = queue.pageBuilder.write(job.id, 1, agentDocument([textBlock()]), 1);
  assert.equal(manual.revision, 2);
  const rejected = session.save({ revision: 1, document: agentDocument([mediaBlock(run.catalogs.media[0].ref)]) });
  assert.deepEqual(rejected, { error: 'Данные шага 3 уже изменены', currentRevision: 2 });
  const accepted = session.save({ revision: 2, document: agentDocument([mediaBlock(run.catalogs.media[0].ref)]) });
  assert.deepEqual(accepted, { accepted: true, revision: 3 });
  session.finish(0);
  assert.equal(attempt.builder.status, 'complete');
  const stored = queue.pageBuilder.read(job.id);
  assert.equal(stored.revision, 3);
  assert.equal(stored.document.source.htmlSha256, ZERO_SHA, 'a non-pristine document keeps its existing binding');
});

test('validation errors reach the agent and exhausted saves fail the run', async t => {
  const { queue, job, attempt, fake } = setup(t, { queue: { buildSaveLimit: 2 } });
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  const forged = agentDocument([{ ...mediaBlock(run.catalogs.media[0].ref), unknown: true }]);
  assert.match(session.save({ revision: 1, document: forged }).error, /^Неизвестное поле блока/);
  assert.match(session.save({ revision: 0, document: agentDocument([textBlock()]) }).error, /^Некорректная revision/);
  // Only rejected saves spend the limit, so the third attempt must also be invalid.
  const limited = session.save({ revision: 1, document: agentDocument([mediaBlock('no-such-ref')]) });
  assert.deepEqual(limited, { error: 'Превышен лимит попыток сохранения' });
  assert.equal(session.exitCode, 1, 'the run is interrupted after the limit');
  assert.equal(attempt.builder.status, 'failed');
  assert.equal(attempt.builder.error, 'Превышен лимит попыток сохранения');
  assert.equal(fs.existsSync(run.stagingDir), false);
});

test('grid media without items is a validation error the agent fixes by adding items', async t => {
  const ctx = setup(t);
  const { queue, job, attempt, fake } = ctx;
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  const ref = String(run.catalogs.media[0].ref);
  const gallery = items => ({ ...base('block-gallery', 'grid', 'gallery'), title: 'Фотогалерея',
    media: [{ id: `media-${ref}`, mediaRef: ref, href: '', alt: 'Фото', caption: '' }], items });
  const rejected = session.save({ revision: 1, document: agentDocument([gallery([])]) });
  assert.match(rejected.error, /блока block-gallery[\s\S]*media-[\s\S]*item\.image_asset_id/);
  assert.equal(attempt.builder.status, 'running', 'a validation answer alone never ends the session');
  const fixed = gallery([{ id: 'item-1', title: 'Фото', text: '', link: '', link_text: '', image_asset_id: `media-${ref}`, badge: '', date: '', meta: {} }]);
  assert.deepEqual(session.save({ revision: 1, document: agentDocument([fixed]) }), { accepted: true, revision: 2 });
  session.finish(0);
  assert.equal(attempt.builder.status, 'complete');
  const stored = queue.pageBuilder.read(job.id).document.common.blocks[0];
  assert.equal(stored.items[0].image_asset_id, stored.media[0].id, 'the accepted gallery binds every image to its own item');
});

test('builder policy v3 carries the site contract mapping into the prompt', () => {
  assert.equal(BUILDER_POLICY.version, 3);
  assert.match(BUILDER_POLICY.hash, /^[a-f0-9]{64}$/);
  const prompt = buildBuilderPrompt({ job: { url: `https://${HOST}/` }, attempt: { number: 1 }, revision: 1, htmlRevision: 1,
    manifestSha: ZERO_SHA, files: [], catalogCounts: { media: 1, frames: 1, documents: 1 } });
  assert.ok(prompt.includes('block-contract.json'), 'the staging catalog listing mentions the wire contract');
  assert.ok(prompt.includes('left_image_asset_id/right_image_asset_id'), 'the mapping table covers the contract image fields');
  assert.ok(prompt.includes('схема их отклонит'), 'the mapping table warns against writing contract fields directly');
  assert.ok(prompt.includes('content и settings — легаси-поля'), 'legacy block fields are kept out of the assembled document');
  assert.ok(!prompt.includes('медиа в блоке не более 12'), 'media counts are governed by per-type render mechanics, not a flat cap');
});

test('refs expand into catalog provenance and unknown refs are structural errors', async t => {
  const ctx = setup(t);
  const { queue, job, attempt, fake } = ctx;
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  const media = run.catalogs.media[0].ref, frame = run.catalogs.frames[0].ref, document = run.catalogs.documents[0].ref;
  const banner = mediaBlock(media);
  banner.media[0] = { ...banner.media[0], bigMediaRef: media };
  const answer = session.save({ revision: 1, document: agentDocument([banner, embedBlock(frame), linksBlock(document)]) });
  assert.deepEqual(answer, { accepted: true, revision: 2 });
  session.finish(0);
  assert.equal(attempt.builder.status, 'complete');
  const stored = queue.pageBuilder.read(job.id).document;
  const asset = stored.common.blocks[0].media[0];
  assert.equal(asset.bigUrl, `https://${HOST}/photo.png`); assert.deepEqual(asset.bigMedia, asset.originalMedia);
  const embed = stored.common.blocks[1];
  assert.equal(embed.source_url, 'https://rutube.ru/play/embed/test/'); assert.equal(embed.provider, 'iframe');
  assert.deepEqual(embed.sourceFrame, { attempt: 1, revision: 1, resourceId: 3, sourceSha256: ctx.seeded.manifest.source.sha256 });
  const link = stored.common.blocks[2].items[0];
  assert.equal(link.link, `https://${HOST}/price.pdf`); assert.equal(link.sourceDocument.sha256, sha256(PDF));
  assert.equal(link.sourceDocument.resourceId, 2);
  assert.equal(JSON.stringify(stored).includes('Ref":'), false, 'no unresolved refs remain');

  const second = queue.builder.request(job.id, { force: true });
  assert.equal(second.status, 'queued'); assert.equal(second.generation, 2);
  await flush();
  assert.equal(attempt.builder.status, 'running');
  const retrySession = fake.sessions[1]; retrySession.bind();
  assert.match(retrySession.save({ revision: 1, document: agentDocument([mediaBlock('no-such-ref')]) }).error, /^Неизвестный mediaRef/,
    'the forced restart reset the page, so the retry saves against revision 1');
  retrySession.finish(0);
  assert.equal(attempt.builder.status, 'failed');
});

test('cancel interrupts a running assembly and a queued one', async t => {
  const { queue, job, attempt, fake } = setup(t, { queue: { concurrency: 2 } });
  queue.builder.consider(job, attempt);                       // first slot runs
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);

  queue.add(`https://second.${HOST}/`);
  const secondJob = queue.jobs[1];
  seedStage2(queue, secondJob);
  assert.equal(queue.builder.request(secondJob.id, {}).status, 'queued');
  await flush();
  assert.equal(secondJob.attempts[0].builder.status, 'running', 'second slot runs at once');

  queue.add(`https://third.${HOST}/`);
  const thirdJob = queue.jobs[2];
  seedStage2(queue, thirdJob);
  assert.equal(queue.builder.request(thirdJob.id, {}).status, 'queued', 'third assembly waits for a free slot');
  assert.deepEqual(queue.builder.cancel(thirdJob.id), { ok: true });
  assert.equal(thirdJob.attempts[0].builder.status, 'cancelled');
  assert.equal(fake.sessions.length, 2, 'the cancelled queued job never opened a session');

  assert.deepEqual(queue.builder.cancel(job.id), { ok: true });
  assert.equal(attempt.builder.status, 'cancelled'); assert.equal(session.exitCode, 1);
  assert.equal(fs.existsSync(run.stagingDir), false);
  assert.throws(() => queue.builder.cancel(job.id), /Сборка не выполняется/);
  for (const open of fake.sessions) if (open.exitCode === null) open.finish(0);
});

test('a missing ZCode launch fails with a clear message while the ARM stays alive', async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-agent-'));
  const queue = new Queue({ root, autoStart: false, beget: false, buildRetryLimit: 0, clock: () => 1000, setTimer: () => 1, clearTimer() {} });
  queue.add(`https://${HOST}/`);
  const job = queue.jobs[0], attempt = job.attempts[0];
  seedStage2(queue, job);
  t.after(async () => { await queue.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  queue.builder.consider(job, attempt);
  await flush();
  assert.equal(attempt.builder.status, 'failed');
  assert.match(attempt.builder.error, /ZCode launch для сборки страницы не настроен/);
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/health`)).json()).app, 'Reestr35 ARM');
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.jobs[0].attempts[0].builder.status, 'failed');
});

test('restore marks a running assembly failed and keeps queued assemblies pending', async t => {
  const ctx = setup(t);
  const { queue, job } = ctx;
  job.attempts[0].builder = { status: 'running', generation: 1, policy: { version: 1, hash: ZERO_SHA }, revision: 1, saveAttempts: 0, retries: 0, lastMeaningfulAt: 0 };
  queue.add(`https://second.${HOST}/`);
  const secondJob = queue.jobs[1];
  seedStage2(queue, secondJob);
  secondJob.attempts[0].builder = { status: 'queued', generation: 1, policy: { version: 1, hash: ZERO_SHA }, revision: 1, saveAttempts: 0, retries: 0, lastMeaningfulAt: 0 };
  queue.add(`https://third.${HOST}/`);
  const thirdJob = queue.jobs[2];
  seedStage2(queue, thirdJob);
  thirdJob.attempts[0].builder = { status: 'failed', generation: 2, policy: { version: 1, hash: ZERO_SHA }, revision: 1, saveAttempts: 3, retries: 1, retryAt: 9999, error: 'relay unavailable', finishedAt: '2026-10-13T00:00:00Z' };
  queue.save();
  await queue.shutdown();

  const second = fakeAppServers();
  const queue2 = new Queue({ root: ctx.root, autoStart: false, beget: false, builderAppServerFactory: second.factory,
    buildRetryLimit: 0, clock: () => 1000, setTimer: () => 1, clearTimer() {} });
  const restored = queue2.get(job.id).attempts[0].builder;
  assert.equal(restored.status, 'failed'); assert.equal(restored.error, 'Сборка прервана перезапуском АРМа');
  const pending = queue2.get(secondJob.id).attempts[0].builder;
  assert.equal(pending.status, 'queued');
  assert.equal(queue2.builder.queueList.length, 1);
  const retriable = queue2.get(thirdJob.id).attempts[0].builder;
  assert.equal(retriable.status, 'failed', 'a failed assembly stays failed after restart');
  assert.equal(retriable.retryAt, undefined, 'a scheduled auto-retry never survives a restart');
  queue2.builder.pump();
  assert.equal(queue2.get(secondJob.id).attempts[0].builder.status, 'running');
  assert.equal(second.sessions.length, 1, 'the queued assembly resumes after restart');
  for (const session of second.sessions) if (session.exitCode === null) session.finish(1);
  await queue2.shutdown();
});

test('assemble API enforces CSRF, conflicts and forced overwrite', async t => {
  const { queue, job, fake } = setup(t);
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const session of fake.sessions) if (session.exitCode === null) session.finish(1);
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/page-builder/${job.id}/assemble`;
  const state = await (await fetch(`${base}/api/state`)).json();
  const headers = { 'content-type': 'application/json', 'x-csrf-token': state.csrfToken, origin: base, 'sec-fetch-site': 'same-origin' };

  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' }, body: '{}' })).status, 403, 'missing CSRF token is rejected');
  assert.equal((await fetch(`${base}/api/page-builder/${job.id}/assemble-cancel`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' }, body: '{}' })).status, 403);
  assert.equal((await (await fetch(endpoint, { method: 'POST', headers, body: '{"foo":1}' })).json()).error, 'Тело запроса: {} или {"force": true}');

  queue.add(`https://incomplete.${HOST}/`);
  const incomplete = queue.jobs[1];
  const incompleteResponse = await fetch(`${base}/api/page-builder/${incomplete.id}/assemble`, { method: 'POST', headers, body: '{}' });
  assert.equal(incompleteResponse.status, 409);
  assert.equal((await incompleteResponse.json()).error, 'Сборка доступна после завершения шага 2 (HTML и медиа)');

  queue.pageBuilder.write(job.id, 1, agentDocument([textBlock()]), 1);
  const conflictResponse = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).error, 'Документ шага 3 уже заполнен; подтвердите перезапись');

  const started = await (await fetch(endpoint, { method: 'POST', headers, body: '{"force":true}' })).json();
  assert.equal(started.status, 'queued', 'assemble answers immediately, before the heavy staging');
  assert.equal(started.generation, 1);
  const busy = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
  assert.equal(busy.status, 409); assert.equal((await busy.json()).error, 'Сборка страницы уже выполняется');
  const restarted = await (await fetch(endpoint, { method: 'POST', headers, body: '{"force":true}' })).json();
  assert.equal(restarted.status, 'queued', 'a forced request restarts the pending assembly');
  assert.equal(restarted.generation, 2);
  assert.deepEqual(await (await fetch(`${base}/api/page-builder/${job.id}/assemble-cancel`, { method: 'POST', headers, body: '{}' })).json(), { ok: true });
  assert.equal(job.attempts[0].builder.status, 'cancelled');
  const idle = await fetch(`${base}/api/page-builder/${job.id}/assemble-cancel`, { method: 'POST', headers, body: '{}' });
  assert.equal(idle.status, 409);
});

test('a forced assemble request restarts a running assembly from a clean page', async t => {
  const { queue, job, attempt, fake } = setup(t);
  queue.builder.consider(job, attempt);
  await flush();
  const first = fake.sessions[0]; first.bind();
  assert.equal(attempt.builder.status, 'running');
  const run = queue.builder.running.get(job.id);
  assert.deepEqual(first.save({ revision: 1, document: agentDocument([textBlock()]) }), { accepted: true, revision: 2 });

  const answer = queue.builder.request(job.id, { force: true });
  assert.equal(answer.status, 'queued'); assert.equal(answer.generation, 2);
  assert.equal(first.exitCode, 1, 'the live session is interrupted');
  const stored = queue.pageBuilder.read(job.id);
  assert.equal(stored.revision, 1, 'the restart wipes the old document at once');
  assert.equal(isPristine(stored.document), true, 'no assembled tab outlives its run, even while the rebuild waits');
  await flush();
  assert.equal(attempt.builder.status, 'running', 'a fresh generation starts once the old run closes');
  assert.equal(fake.sessions.length, 2);
  assert.equal(queue.builder.running.get(job.id).generation, 2);
  assert.equal(fs.existsSync(run.stagingDir), false, 'the interrupted run cleans its staging');

  const second = fake.sessions[1]; second.bind();
  const secondRun = queue.builder.running.get(job.id);
  assert.deepEqual(second.save({ revision: 1, document: agentDocument([mediaBlock(secondRun.catalogs.media[0].ref)]) }), { accepted: true, revision: 2 });
  second.finish(0);
  assert.equal(attempt.builder.status, 'complete'); assert.equal(attempt.builder.generation, 2);
});

test('SSE exposes builder lifecycle events', async t => {
  const { queue, job, attempt } = setup(t);
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  t.after(() => controller.abort());
  const reader = response.body.getReader();
  const { value: first } = await reader.read();
  assert.equal(Buffer.from(first).toString('utf8'), ': connected\n\n');

  queue.builder.consider(job, attempt);
  let buffer = ''; const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += Buffer.from(value).toString('utf8');
    for (;;) {
      const frameEnd = buffer.indexOf('\n\n');
      if (frameEnd < 0) break;
      const frame = buffer.slice(0, frameEnd); buffer = buffer.slice(frameEnd + 2);
      const name = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
      if (name && data) events.push({ name, data: JSON.parse(data) });
    }
    if (events.some(event => event.data.status === 'running')) break;
  }
  controller.abort();
  const builderEvents = events.filter(event => event.name === 'builder');
  assert.deepEqual(builderEvents[0].data, { jobId: job.id, attempt: attempt.number, status: 'queued' });
  assert.ok(builderEvents.some(event => event.data.status === 'running'));
});

test('a failed assembly retries once and the retried attempt can still succeed', async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-agent-'));
  let time = 1000, broken = true;
  const inner = fakeAppServers();
  const realFactory = inner.factory;
  const factory = () => { if (broken) { broken = false; throw new Error('relay unavailable'); } return realFactory(); };
  const queue = new Queue({ root, autoStart: false, beget: false, builderAppServerFactory: factory,
    buildRetryLimit: 1, buildRetryDelayMs: 100, clock: () => time, setTimer: () => 1, clearTimer() {} });
  queue.add(`https://${HOST}/`);
  const job = queue.jobs[0], attempt = job.attempts[0];
  seedStage2(queue, job);
  t.after(async () => { for (const session of inner.sessions) if (session.exitCode === null) session.finish(1); await queue.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  queue.builder.consider(job, attempt);
  await flush();
  assert.equal(attempt.builder.status, 'failed');
  assert.equal(attempt.builder.retries, 1); assert.equal(attempt.builder.retryAt, 1100);
  assert.equal(queue.builder.queueList.length, 1);
  time += 200; queue.builder.pump();
  assert.equal(attempt.builder.status, 'running'); assert.equal(attempt.builder.generation, 2);
  const session = inner.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  assert.deepEqual(session.save({ revision: 1, document: agentDocument([mediaBlock(run.catalogs.media[0].ref)]) }), { accepted: true, revision: 2 });
  session.finish(0);
  assert.equal(attempt.builder.status, 'complete');
  assert.equal(attempt.builder.retries, 1);
});

test('a job runs one assembly at a time and stale attempt entries resolve as skipped', async t => {
  const ctx = setup(t, { queue: { concurrency: 2, buildRetryLimit: 1 } });
  const { queue, job, attempt, fake, advance } = ctx;
  queue.builder.consider(job, attempt);
  await flush();
  const first = fake.sessions[0]; first.bind();
  assert.equal(attempt.builder.status, 'running');

  attempt.status = 'paused'; queue.retry(job.id);
  const second = job.attempts.at(-1);
  assert.equal(second.number, 2, 'retry created a fresh attempt');
  seedStage2(queue, job);
  queue.builder.consider(job, second);
  await flush();
  assert.equal(second.builder.status, 'queued', 'the second attempt waits while the first run holds the job');
  assert.equal(fake.sessions.length, 1);
  assert.equal(queue.builder.running.size, 1, 'the registry keeps exactly one run per job');

  first.finish(0);                                 // no save: failed with a scheduled retry
  await flush();
  assert.equal(attempt.builder.status, 'failed');
  assert.equal(attempt.builder.retryAt !== undefined, true);
  assert.equal(second.builder.status, 'running', 'the waiting entry starts once the job frees up');
  assert.equal(fake.sessions.length, 2);

  const secondSession = fake.sessions[1]; secondSession.bind();
  const secondRun = queue.builder.running.get(job.id);
  assert.deepEqual(secondSession.save({ revision: 1, document: agentDocument([mediaBlock(secondRun.catalogs.media[0].ref)]) }), { accepted: true, revision: 2 });
  secondSession.finish(0);
  assert.equal(second.builder.status, 'complete');
  advance(200); queue.builder.pump();
  assert.equal(attempt.builder.status, 'failed', 'the stale auto-retry of the replaced attempt never restarts it');
  assert.equal(fake.sessions.length, 2, 'no third session opens for the replaced attempt');
  assert.equal(queue.builder.queueList.length, 0);
  // The replaced attempt is detached from state.json, so its inert retry plan
  // cannot linger there; the surviving attempt owns no builder plan at all.
  const stored = JSON.parse(fs.readFileSync(queue.stateFile, 'utf8'));
  assert.equal(stored.jobs[0].attempts.length, 1);
  assert.equal(stored.jobs[0].attempts[0].number, 2);
  assert.equal(stored.jobs[0].attempts[0].builder.retryAt, undefined, 'no dead retry plan lingers in state');
});

test('a queued assembly of a replaced attempt never starts and leaves no dangling plan', async t => {
  const { queue, job, attempt, fake } = setup(t, { queue: { concurrency: 1 } });
  queue.add(`https://other.${HOST}/`);
  const otherJob = queue.jobs[1];
  seedStage2(queue, otherJob);
  queue.builder.consider(otherJob, otherJob.attempts.at(-1));    // занимает единственный слот
  await flush();
  assert.equal(fake.sessions.length, 1);

  queue.builder.consider(job, attempt);                          // queued: ждёт освобождения слота
  assert.equal(attempt.builder.status, 'queued');
  attempt.status = 'paused'; queue.retry(job.id);                // попытка заменена и удалена из state
  assert.equal(job.attempts.length, 1); assert.equal(job.attempts.at(-1).number, 2);
  assert.equal(job.attempts.at(-1).builder, undefined, 'the fresh attempt owns no builder plan');

  fake.sessions[0].finish(0);                                    // слот освободился
  await flush();
  assert.equal(attempt.builder.status, 'queued', 'the replaced attempt never starts assembling');
  assert.equal(fake.sessions.length, 1, 'no session opens for the replaced attempt');
  assert.equal(queue.builder.queueList.length, 0, 'the queue entry drains without dangling');
  const stored = JSON.parse(fs.readFileSync(queue.stateFile, 'utf8'));
  assert.equal(stored.jobs[0].attempts.length, 1);
  assert.equal(stored.jobs[0].attempts[0].builder, undefined, 'state keeps no queued plan of the replaced attempt');
});

test('the shared pool bounds assemblies and stage jobs together across completion paths', async t => {
  const outcomes = { success: 'complete', error: 'failed', cancel: 'cancelled', idle: 'failed' };
  for (const mode of Object.keys(outcomes)) {
    const { queue, job, attempt, fake, advance, workers } = poolSetup(t, { concurrency: 2 });
    queue.add(`https://second.${HOST}/`);
    const second = queue.jobs[1];
    seedStage2(queue, second);
    queue.builder.consider(job, attempt);
    queue.builder.consider(second, second.attempts.at(-1));
    await flush();
    assert.equal(queue.builder.running.size, 2, `${mode}: both assemblies hold pool slots`);
    assert.equal(queue.usedSlots(), 2); assert.equal(queue.hasFreeSlot(), false);

    queue.add('https://capture-a.reestr35.ru/\nhttps://capture-b.reestr35.ru/');
    queue.pump();
    assert.equal(workers.children.length, 0, `${mode}: no free slot for a stage 1-2 job`);
    assert.equal(queue.jobs[2].attempts[0].status, 'queued');

    if (mode === 'success') {
      fake.sessions[0].bind();
      fake.sessions[0].save({ revision: 1, document: agentDocument([textBlock()]) });
      fake.sessions[0].finish(0);
    } else if (mode === 'error') fake.sessions[0].finish(0);
    else if (mode === 'cancel') queue.builder.cancel(job.id);
    else { advance(600001); fake.sessions[1].bind(); queue.builder.tick(); }
    await flush();
    assert.equal(attempt.builder.status, outcomes[mode], `${mode}: the assembly reached its terminal state`);
    assert.equal(queue.builder.running.size, 1, `${mode}: exactly one slot was released`);
    assert.equal(workers.children.length, 1, `${mode}: the freed slot restarts the stage 1-2 queue`);
    assert.equal(queue.jobs[2].attempts[0].status, 'running');
    assert.equal(queue.hasFreeSlot(), false);
  }
});

test('stage jobs fill the shared pool and an assembly waits for a freed slot', async t => {
  const { queue, job, attempt, fake, workers } = poolSetup(t, { concurrency: 2 });
  queue.add('https://capture-a.reestr35.ru/\nhttps://capture-b.reestr35.ru/');
  queue.pump();
  assert.equal(workers.children.length, 2); assert.equal(queue.hasFreeSlot(), false);
  queue.builder.consider(job, attempt);
  await flush();
  assert.equal(attempt.builder.status, 'queued', 'the assembly cannot start without a free slot');
  assert.equal(fake.sessions.length, 0);
  workers.children[0].finish(1);
  await flush();
  assert.equal(attempt.builder.status, 'running', 'the freed capture slot restarts the assembly queue');
  assert.equal(fake.sessions.length, 1); assert.equal(queue.usedSlots(), 2);
});

test('a freed slot is offered to a waiting assembly before FIFO stage jobs', async t => {
  const { queue, job, attempt, fake, workers } = poolSetup(t, { concurrency: 2 });
  queue.builder.consider(job, attempt);
  await flush();
  queue.add('https://capture-a.reestr35.ru/\nhttps://capture-b.reestr35.ru/');
  queue.pump();
  assert.equal(queue.usedSlots(), 2, 'one assembly and one capture job fill the pool');
  queue.add(`https://second.${HOST}/`);
  const second = queue.jobs[3];
  seedStage2(queue, second);
  assert.equal(queue.builder.request(second.id, {}).status, 'queued');
  workers.children[0].finish(1);                    // the capture slot frees
  await flush();
  assert.equal(second.attempts[0].builder.status, 'running', 'the freed slot goes to the waiting assembly');
  assert.equal(fake.sessions.length, 2);
  assert.equal(workers.children.length, 1, 'the queued stage job still waits');
});

test('a stage job takes the slot when the waiting assembly cannot start', async t => {
  const { queue, job, attempt, fake, workers } = poolSetup(t, { concurrency: 2 });
  queue.builder.consider(job, attempt);              // slot 1: this company's assembly
  await flush();
  attempt.status = 'paused'; queue.retry(job.id);    // a newer attempt of the same company
  const second = job.attempts.at(-1);
  seedStage2(queue, job);
  queue.builder.consider(job, second);
  await flush();
  assert.equal(second.builder.status, 'queued', 'the busy company cannot run a second assembly');
  assert.equal(fake.sessions.length, 1);
  queue.add('https://capture-a.reestr35.ru/');
  queue.pump();
  assert.equal(workers.children.length, 1, 'the slot the assembly cannot take goes to the FIFO job');
  assert.equal(queue.usedSlots(), 2);
});

test('lowering the shared limit never kills running work', async t => {
  const { queue, job, attempt, fake, workers } = poolSetup(t, { concurrency: 2 });
  queue.add('https://capture-a.reestr35.ru/');
  queue.builder.consider(job, attempt);
  queue.pump();
  await flush();
  assert.equal(queue.builder.running.size, 1); assert.equal(workers.children.length, 1);
  queue.setConcurrency(1);
  assert.equal(queue.usedSlots(), 2, 'both units keep running beyond the new limit');
  assert.equal(fake.sessions[0].exitCode, null); assert.equal(workers.children[0].exitCode, null);
  fake.sessions[0].finish(1);                        // failed; the setup disables builder retries
  queue.add('https://capture-b.reestr35.ru/');
  queue.pump();
  assert.equal(workers.children.length, 1, 'nothing new starts above the lowered limit');
  workers.children[0].finish(1);
  assert.equal(workers.children.length, 2, 'the pool resumes once the running work finished');
  assert.equal(queue.usedSlots(), 1);
});

test('raising the shared limit pumps both queues', async t => {
  const { queue, job, attempt, workers } = poolSetup(t, { concurrency: 1 });
  queue.builder.consider(job, attempt);
  queue.pump();
  await flush();
  assert.equal(queue.builder.running.size, 1);
  queue.add(`https://second.${HOST}/`);
  const second = queue.jobs[1];
  seedStage2(queue, second);
  assert.equal(queue.builder.request(second.id, {}).status, 'queued');
  queue.add('https://capture-a.reestr35.ru/');
  assert.equal(workers.children.length, 0, 'N=1: everything waits');
  assert.equal(second.attempts[0].builder.status, 'queued');
  queue.autoStart = true;
  queue.setConcurrency(3);
  await flush();
  assert.equal(second.attempts[0].builder.status, 'running', 'a new slot goes to the waiting assembly first');
  assert.equal(workers.children.length, 1, 'the remaining slot starts the FIFO job');
  assert.equal(queue.usedSlots(), 3);
});

test('a restart recomputes pool occupancy and starts only what fits', async t => {
  const ctx = setup(t);
  const { queue, root, job } = ctx;
  queue.add(`https://second.${HOST}/`);
  queue.add(`https://third.${HOST}/`);
  seedStage2(queue, queue.jobs[1]); seedStage2(queue, queue.jobs[2]);
  job.attempts[0].builder = { status: 'running', generation: 1, policy: { version: 1, hash: ZERO_SHA }, revision: 1, saveAttempts: 0, retries: 0, lastMeaningfulAt: 0 };
  for (const other of queue.jobs.slice(1)) other.attempts[0].builder = { status: 'queued', generation: 1, policy: { version: 1, hash: ZERO_SHA }, revision: 1, saveAttempts: 0, retries: 0, lastMeaningfulAt: 0 };
  queue.setConcurrency(1);
  await queue.shutdown();

  const second = fakeAppServers();
  const queue2 = new Queue({ root, autoStart: false, beget: false, builderAppServerFactory: second.factory,
    buildRetryLimit: 0, clock: () => 1000, setTimer: () => 1, clearTimer() {} });
  assert.equal(queue2.concurrency, 1, 'the shared limit survived the restart');
  assert.equal(queue2.get(job.id).attempts[0].builder.status, 'failed', 'the running assembly was marked failed by restore');
  assert.equal(queue2.builder.queueList.length, 2, 'queued assemblies survive the restart');
  assert.equal(queue2.usedSlots(), 0, 'restore starts from a clean derived pool');
  queue2.pump();
  assert.equal(queue2.builder.running.size, 1, 'N=1 admits exactly one assembly');
  assert.equal(second.sessions.length, 1);
  second.sessions[0].finish(1);
  assert.equal(queue2.builder.running.size, 1, 'the freed slot goes to the next restored assembly');
  assert.equal(second.sessions.length, 2);
  for (const session of second.sessions) if (session.exitCode === null) session.finish(1);
  await queue2.shutdown();
});

test('pause interrupts the session at once and keeps the assembled document', async t => {
  const { queue, job, attempt, fake } = setup(t);
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  const ref = run.catalogs.media[0].ref;
  assert.deepEqual(session.save({ revision: 1, document: agentDocument([mediaBlock(ref)]) }), { accepted: true, revision: 2 });

  let interrupts = 0;
  session.interrupt = async () => { interrupts += 1; };    // a live session closes asynchronously
  assert.deepEqual(queue.builder.pause(job.id), { ok: true });
  assert.equal(attempt.builder.status, 'pausing', 'the pause state is visible before the session closes');
  assert.equal(attempt.builder.pauseRequested, true);
  assert.equal(interrupts, 1, 'the session is interrupted immediately, before any further save');
  assert.throws(() => session.save({ revision: 2, document: { ...agentDocument([mediaBlock(ref)]), tabs: [tabSection('tab-1', 'Первая')] } }),
    /Stale builder session/, 'a save raced with the pause is rejected outright');
  assert.throws(() => queue.builder.pause(job.id), error => error.statusCode === 409 && /Сборка не выполняется/.test(error.message),
    'a repeated pause while pausing answers the ordinary conflict');

  session.finish(1);                                       // the stop signal lands
  await flush();
  assert.equal(attempt.builder.status, 'paused');
  assert.equal(attempt.builder.pauseRequested, undefined);
  const stored = queue.pageBuilder.read(job.id);
  assert.equal(stored.revision, 2);
  assert.equal(stored.document.common.blocks.length, 1, 'the last accepted tab stays durable');
  assert.equal(fs.existsSync(run.stagingDir), false, 'the paused run cleans its staging');
});

test('resume finishes only the remaining tabs and keeps the saved tab verbatim', async t => {
  const { queue, job, attempt, fake } = setup(t);
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  const ref = run.catalogs.media[0].ref;
  session.save({ revision: 1, document: agentDocument([mediaBlock(ref)]) });
  session.save({ revision: 2, document: { ...agentDocument([mediaBlock(ref)]), tabs: [tabSection('tab-news', 'Новости')] } });
  assert.deepEqual(queue.builder.pause(job.id), { ok: true });   // the immediate interrupt closes the fake session
  assert.equal(attempt.builder.status, 'paused');
  const before = queue.pageBuilder.read(job.id).document, generation = attempt.builder.generation;

  const answer = queue.builder.resume(job.id);
  assert.equal(answer.status, 'queued'); assert.equal(answer.generation, generation + 1);
  await flush();
  assert.equal(attempt.builder.status, 'running');
  assert.equal(fake.sessions.length, 2);
  const prompt = fs.readFileSync(path.join(queue.root, 'page-builder', job.id, 'builder', `run-${generation + 1}-prompt.txt`), 'utf8');
  assert.ok(prompt.includes(JSON.stringify(before)), 'the resume prompt carries the current document');
  assert.ok(prompt.includes('НЕ менять'), 'the resume prompt forbids touching assembled sections');
  assert.ok(prompt.includes('revision — текущая (3)'), 'the resume rules quote the current revision');

  const resumed = fake.sessions[1]; resumed.bind();
  const saved = resumed.save({ revision: 3, document: { ...structuredClone(before), tabs: [...structuredClone(before.tabs), tabSection('tab-contacts', 'Контакты')] } });
  assert.deepEqual(saved, { accepted: true, revision: 4 });
  resumed.finish(0);
  assert.equal(attempt.builder.status, 'complete');
  const after = queue.pageBuilder.read(job.id).document;
  assert.equal(after.tabs.length, 2);
  assert.deepEqual(after.tabs[0], before.tabs[0], 'the previously completed tab is byte-identical');
});

test('restore turns a running or pausing assembly with a saved document into paused', async t => {
  const ctx = setup(t);
  const { queue, root, job } = ctx;
  queue.pageBuilder.write(job.id, 1, agentDocument([textBlock()]), 1);
  job.attempts[0].builder = { status: 'running', generation: 1, policy: { version: 1, hash: ZERO_SHA }, revision: 2, saveAttempts: 0, retries: 0, lastMeaningfulAt: 0, pauseRequested: true };
  queue.add(`https://pristine.${HOST}/`);
  const pristineJob = queue.jobs[1];
  seedStage2(queue, pristineJob);
  pristineJob.attempts[0].builder = { status: 'running', generation: 1, policy: { version: 1, hash: ZERO_SHA }, revision: 1, saveAttempts: 0, retries: 0, lastMeaningfulAt: 0 };
  queue.add(`https://pausing.${HOST}/`);
  const pausingJob = queue.jobs[2];
  seedStage2(queue, pausingJob);
  queue.pageBuilder.write(pausingJob.id, 1, agentDocument([textBlock()], { hostname: `pausing.${HOST}` }), 1);
  pausingJob.attempts[0].builder = { status: 'pausing', generation: 1, policy: { version: 1, hash: ZERO_SHA }, revision: 2, saveAttempts: 0, retries: 0, lastMeaningfulAt: 0, pauseRequested: true };
  queue.save();
  await queue.shutdown();

  const second = fakeAppServers();
  const queue2 = new Queue({ root, autoStart: false, beget: false, builderAppServerFactory: second.factory,
    buildRetryLimit: 0, clock: () => 1000, setTimer: () => 1, clearTimer() {} });
  const resumable = queue2.get(job.id).attempts[0].builder;
  assert.equal(resumable.status, 'paused');
  assert.equal(resumable.error, 'Сборка прервана перезапуском АРМа; можно продолжить');
  assert.equal(resumable.pauseRequested, undefined, 'the pause flag never survives a restart');
  const empty = queue2.get(pristineJob.id).attempts[0].builder;
  assert.equal(empty.status, 'failed', 'a pristine document leaves nothing to resume');
  assert.equal(empty.error, 'Сборка прервана перезапуском АРМа');
  const pausing = queue2.get(pausingJob.id).attempts[0].builder;
  assert.equal(pausing.status, 'paused', 'a restart during a pending pause is resumable, not lost');
  assert.equal(pausing.error, 'Сборка прервана перезапуском АРМа; можно продолжить');
  assert.equal(pausing.pauseRequested, undefined);
  await queue2.shutdown();
});

test('restore clears a stale finalization marker instead of blocking the build forever', async t => {
  const ctx = setup(t);
  const { queue, root, job } = ctx;
  queue.pageBuilder.write(job.id, 1, agentDocument([textBlock()]), 1);
  // A crash between the marker write and the recovery retry left the verdict
  // and the marker on disk together; the in-memory retry registry is gone.
  job.attempts[0].builder = { status: 'complete', generation: 1, policy: { version: 1, hash: ZERO_SHA }, revision: 2,
    saveAttempts: 0, retries: 0, finishedAt: '2026-10-17T00:00:00Z', finalizationError: { message: 'диск недоступен' } };
  queue.save();
  await queue.shutdown();
  const second = fakeAppServers();
  const queue2 = new Queue({ root, autoStart: false, beget: false, builderAppServerFactory: second.factory,
    buildRetryLimit: 0, clock: () => 1000, setTimer: () => 1, clearTimer() {} });
  const restored = queue2.get(job.id).attempts[0].builder;
  assert.equal(restored.status, 'complete', 'the verdict itself stays');
  assert.equal(restored.finalizationError, undefined, 'a restart is the recovery authority for the marker');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  assert.equal(state.jobs[0].attempts[0].builder.finalizationError, undefined, 'the cleaned marker reaches state.json');
  assert.throws(() => queue2.builder.request(job.id, {}), /Документ шага 3 уже заполнен/,
    'manual actions answer their ordinary conflicts again, not the finalization 409');
  await queue2.shutdown();
});

test('a naturally closed turn completes the assembly despite a pending pause', async t => {
  const { queue, job, attempt, fake } = setup(t);
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  assert.deepEqual(session.save({ revision: 1, document: agentDocument([textBlock()]) }), { accepted: true, revision: 2 });
  session.interrupt = async () => {};                        // the stop signal travels slowly
  queue.builder.pause(job.id);                               // the builder is already pausing...
  assert.equal(attempt.builder.status, 'pausing');
  session.finish(0);                                         // ...but the turn closed on its own first
  assert.equal(attempt.builder.status, 'complete', 'a finished assembly is not mislabeled as paused');
  assert.equal(attempt.builder.pauseRequested, undefined);
  assert.equal(queue.pageBuilder.read(job.id).revision, 2);
});

test('a terminal verdict reaches state.json through the finalizer after a write failure', async t => {
  const { queue, job, attempt, fake } = setup(t);
  queue.add(`https://second.${HOST}/`);
  const second = queue.jobs[1];
  seedStage2(queue, second);
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  assert.deepEqual(session.save({ revision: 1, document: agentDocument([textBlock()]) }), { accepted: true, revision: 2 });

  const realSave = queue.save.bind(queue);
  let broken = true;
  queue.save = () => { if (broken) throw new Error('диск недоступен'); return realSave(); };
  session.finish(0);
  assert.equal(attempt.builder.status, 'complete', 'the in-memory verdict is already terminal');
  assert.ok(attempt.builder.finalizationError, 'the failed write is marked');
  assert.equal(queue.pendingFinalizations.has(`builder:${job.id}`), true, 'the finalizer is registered for retry');
  assert.throws(() => queue.builder.request(job.id, { force: true }), /Завершение сборки ещё не сохранено/);

  queue.builder.consider(second, second.attempts.at(-1));
  queue.builder.pump();
  assert.equal(second.attempts[0].builder.status, 'queued', 'no new run starts while the verdict is unwritten');
  assert.equal(fake.sessions.length, 1);

  broken = false;
  queue.pump();
  assert.equal(attempt.builder.finalizationError, undefined, 'the recovery pump completes the finalization');
  const state = JSON.parse(fs.readFileSync(path.join(queue.root, 'state.json'), 'utf8'));
  assert.equal(state.jobs[0].attempts[0].builder.status, 'complete');
  assert.equal(second.attempts[0].builder.status, 'running', 'the queue lives on after the finalization lands');
});

test('accepted incremental saves never spend the rejection limit', async t => {
  const { queue, job, attempt, fake } = setup(t, { queue: { buildSaveLimit: 2 } });
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  const ref = run.catalogs.media[0].ref;
  const snapshot = (...tabs) => ({ ...agentDocument([mediaBlock(ref)]), tabs });
  assert.deepEqual(session.save({ revision: 1, document: snapshot() }), { accepted: true, revision: 2 });
  assert.deepEqual(session.save({ revision: 2, document: snapshot(tabSection('tab-1', 'Первая')) }), { accepted: true, revision: 3 });
  assert.deepEqual(session.save({ revision: 3, document: snapshot(tabSection('tab-1', 'Первая'), tabSection('tab-2', 'Вторая')) }), { accepted: true, revision: 4 });
  assert.equal(attempt.builder.status, 'running');
  assert.equal(attempt.builder.saveAttempts, 0, 'accepted snapshots do not spend the limit');

  const rejected = () => session.save({ revision: 4, document: agentDocument([mediaBlock('no-such-ref')]) });
  assert.match(rejected().error, /^Неизвестный mediaRef/);
  assert.match(rejected().error, /^Неизвестный mediaRef/);
  assert.deepEqual(rejected(), { error: 'Превышен лимит попыток сохранения' });
  assert.equal(session.exitCode, 1);
  assert.equal(attempt.builder.status, 'complete', 'a partially accepted document completes the assembly');
  const stored = queue.pageBuilder.read(job.id);
  assert.equal(stored.revision, 4); assert.equal(stored.document.tabs.length, 2);
});

test('the rejection counter resets when an auto-retry starts a fresh run', async t => {
  const { queue, job, attempt, fake, advance } = setup(t, { queue: { buildSaveLimit: 2, buildRetryLimit: 1, buildRetryDelayMs: 100 } });
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  const bad = () => session.save({ revision: 1, document: agentDocument([mediaBlock('no-such-ref')]) });
  assert.match(bad().error, /^Неизвестный mediaRef/);
  assert.match(bad().error, /^Неизвестный mediaRef/);
  assert.deepEqual(bad(), { error: 'Превышен лимит попыток сохранения' });
  assert.equal(attempt.builder.status, 'failed');
  assert.equal(attempt.builder.error, 'Превышен лимит попыток сохранения');
  assert.ok(attempt.builder.retryAt !== undefined, 'the exhausted run schedules its auto-retry');

  advance(200);
  queue.builder.pump();
  assert.equal(attempt.builder.status, 'running'); assert.equal(attempt.builder.generation, 2);
  assert.equal(attempt.builder.saveAttempts, 0, 'the retry starts with a fresh budget');
  const retried = fake.sessions[1]; retried.bind();
  assert.deepEqual(retried.save({ revision: 1, document: agentDocument([mediaBlock(run.catalogs.media[0].ref)]) }), { accepted: true, revision: 2 });
  retried.finish(0);
  assert.equal(attempt.builder.status, 'complete');
});

test('a manual document write is blocked while the assembly runs and free while it waits', async t => {
  const { queue, job, attempt, fake } = setup(t, { queue: { concurrency: 1 } });
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const session of fake.sessions) if (session.exitCode === null) session.finish(1);
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  const headers = { 'content-type': 'application/json', 'x-csrf-token': state.csrfToken, origin: base, 'sec-fetch-site': 'same-origin' };
  const put = (revision, document) => fetch(`${base}/api/page-builder/${job.id}`, { method: 'POST', headers, body: JSON.stringify({ revision, document }) });

  queue.add(`https://other.${HOST}/`);
  const other = queue.jobs[1];
  seedStage2(queue, other);
  queue.builder.consider(other, other.attempts.at(-1));
  await flush();                                          // the only slot is busy
  queue.builder.consider(job, attempt);
  assert.equal(attempt.builder.status, 'queued');
  const free = await put(1, agentDocument([textBlock()]));
  assert.equal(free.status, 200, 'queued: no live session, the manual write passes');
  assert.equal(queue.pageBuilder.read(job.id).revision, 2);

  fake.sessions[0].finish(0);                             // the slot frees, job starts
  await flush();
  assert.equal(attempt.builder.status, 'running');
  const session = fake.sessions[1]; session.bind();
  const run = queue.builder.running.get(job.id);
  assert.equal(queue.pageBuilder.read(job.id).revision, 1, 'a fresh run rebuilds from the default page: the queued manual edit does not survive it');
  const before = queue.pageBuilder.read(job.id).document;
  const blocked = await put(1, agentDocument([mediaBlock(run.catalogs.media[0].ref)]));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'Документ собирает агентом; остановите сборку или дождитесь завершения');
  assert.deepEqual(queue.pageBuilder.read(job.id).document, before, 'the blocked edit never landed');

  assert.deepEqual(session.save({ revision: 1, document: agentDocument([mediaBlock(run.catalogs.media[0].ref)]) }), { accepted: true, revision: 2 });
  session.finish(0);
  assert.equal(attempt.builder.status, 'complete');
});

test('assemble-pause and assemble-resume endpoints drive the pause lifecycle', async t => {
  const { queue, job, attempt, fake } = setup(t, { queue: { concurrency: 1 } });
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const session of fake.sessions) if (session.exitCode === null) session.finish(1);
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  const headers = { 'content-type': 'application/json', 'x-csrf-token': state.csrfToken, origin: base, 'sec-fetch-site': 'same-origin' };
  const post = path => fetch(`${base}/api/page-builder/${job.id}/${path}`, { method: 'POST', headers, body: '{}' });

  queue.add(`https://other.${HOST}/`);
  const other = queue.jobs[1];
  seedStage2(queue, other);
  queue.builder.consider(other, other.attempts.at(-1));
  await flush();                                          // the only slot is busy
  queue.builder.consider(job, attempt);
  assert.equal(attempt.builder.status, 'queued');

  const paused = await (await post('assemble-pause')).json();
  assert.deepEqual(paused, { ok: true });
  assert.equal(attempt.builder.status, 'paused');

  const resumed = await (await post('assemble-resume')).json();
  assert.deepEqual(resumed, { status: 'queued', generation: 2 });

  const statuses = [];
  queue.subscribe('builder', event => statuses.push(event.status));
  fake.sessions[0].finish(0);                             // the other assembly frees the slot
  await flush();
  assert.equal(attempt.builder.status, 'running');
  const livePause = await (await post('assemble-pause')).json();
  assert.deepEqual(livePause, { ok: true });
  assert.equal(attempt.builder.status, 'paused', 'the immediate interrupt closes the live session');
  assert.ok(statuses.includes('pausing'), 'a live pause is announced through the transitional status');
  assert.deepEqual(await (await post('assemble-resume')).json(), { status: 'queued', generation: 3 });
  assert.deepEqual(await (await post('assemble-cancel')).json(), { ok: true });
  const badPause = await post('assemble-pause');
  assert.equal(badPause.status, 409);
  assert.equal((await badPause.json()).error, 'Сборка не выполняется');
  const badResume = await post('assemble-resume');
  assert.equal(badResume.status, 409);
  assert.equal((await badResume.json()).error, 'Возобновление доступно для сборки на паузе');
});

test('a forced rebuild during a pausing assembly cancels it and starts clean', async t => {
  const { queue, job, attempt, fake } = setup(t);
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  assert.deepEqual(session.save({ revision: 1, document: agentDocument([textBlock()]) }), { accepted: true, revision: 2 });

  let interrupts = 0;
  session.interrupt = async () => { interrupts += 1; };    // the pause stop signal is still in flight
  assert.deepEqual(queue.builder.pause(job.id), { ok: true });
  assert.equal(attempt.builder.status, 'pausing');
  assert.deepEqual(queue.builder.cancel(job.id), { ok: true });
  assert.equal(attempt.builder.status, 'cancelled');
  assert.equal(attempt.builder.pauseRequested, undefined);
  assert.equal(interrupts, 2, 'the cancel repeats the stop; an extra interrupt is harmless');
  session.finish(1);                                       // both stop signals land as one close
  assert.equal(attempt.builder.status, 'cancelled');

  const answer = queue.builder.request(job.id, { force: true });
  assert.equal(answer.status, 'queued'); assert.equal(answer.generation, 2);
  await flush();
  assert.equal(attempt.builder.status, 'running');
  const fresh = fake.sessions[1]; fresh.bind();
  const freshRun = queue.builder.running.get(job.id);
  assert.equal(queue.pageBuilder.read(job.id).revision, 1, 'the rebuild starts from the reset page');
  assert.deepEqual(fresh.save({ revision: 1, document: agentDocument([mediaBlock(freshRun.catalogs.media[0].ref)]) }), { accepted: true, revision: 2 });
  fresh.finish(0);
  assert.equal(attempt.builder.status, 'complete');
});

test('a forced rebuild resets the step 3 document without publishing the empty page', async t => {
  const { queue, job, attempt, fake, seeded } = setup(t);
  const enqueued = [];
  queue.pageBuilder.sync = { enqueue: (...args) => enqueued.push(args), wake() {}, projection: () => ({ pendingCount: 0 }),
    enforceReview() {}, companyId: () => 1 };
  queue.builder.consider(job, attempt);
  await flush();
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  assert.deepEqual(session.save({ revision: 1, document: agentDocument([mediaBlock(run.catalogs.media[0].ref)]) }), { accepted: true, revision: 2 });
  assert.equal(enqueued.length, 1, 'the ordinary save publishes');
  session.finish(0);
  assert.equal(attempt.builder.status, 'complete');

  const revised = seedStage2(queue, job, HTML.replace('Тестовая страница', 'Обновлённая страница'));
  assert.notEqual(revised.manifest.source.sha256, seeded.manifest.source.sha256);
  const before = enqueued.length;
  const answer = queue.builder.request(job.id, { force: true });
  assert.equal(answer.status, 'queued');
  const raw = JSON.parse(fs.readFileSync(queue.pageBuilder.file(job.id), 'utf8'));
  assert.equal(raw.revision, 1, 'the attempt file is the default page right after the click');
  assert.equal(raw.document.common.blocks.length, 0); assert.equal(raw.document.tabs.length, 0);
  assert.equal(raw.syncRequested, undefined, 'the reset never flags the empty page for Beget');
  assert.equal(enqueued.length, before, 'the Beget queue does not grow on reset');

  await flush();
  const fresh = fake.sessions[1]; fresh.bind();
  const freshRun = queue.builder.running.get(job.id);
  assert.deepEqual(fresh.save({ revision: 1, document: agentDocument([mediaBlock(freshRun.catalogs.media[0].ref)]) }), { accepted: true, revision: 2 });
  const binding = queue.pageBuilder.read(job.id).document.source.htmlSha256;
  assert.equal(binding, revised.manifest.source.sha256, 'the rebuilt page binds the current step 2 HTML, not the old assembly binding');
  fresh.finish(0);
  assert.equal(attempt.builder.status, 'complete');
});

test('an auto-retry of a fresh assembly rebuilds from the reset document', async t => {
  const { queue, job, attempt, fake, advance } = setup(t, { queue: { buildRetryLimit: 1, buildRetryDelayMs: 100 } });
  // A crashed fresh run left one accepted tab and a scheduled retry behind.
  queue.pageBuilder.write(job.id, 1, agentDocument([textBlock()]), 1);
  attempt.builder = { status: 'failed', generation: 1, policy: BUILDER_POLICY, revision: 2,
    saveAttempts: 0, retries: 1, retryAt: 900, error: 'relay unavailable', lastMeaningfulAt: 0 };
  queue.builder.queueList.push({ jobId: job.id, attemptNumber: attempt.number, readyAt: 900, retry: true });
  advance(200); queue.builder.pump();
  assert.equal(attempt.builder.status, 'running'); assert.equal(attempt.builder.generation, 2);
  assert.equal(queue.pageBuilder.read(job.id).revision, 1, 'the retry wipes the crashed run tab');
  const prompt = fs.readFileSync(path.join(queue.root, 'page-builder', job.id, 'builder', 'run-2-prompt.txt'), 'utf8');
  assert.ok(!prompt.includes('Текст раздела'), 'the fresh prompt carries no resume document');
  const session = fake.sessions[0]; session.bind();
  const run = queue.builder.running.get(job.id);
  assert.deepEqual(session.save({ revision: 1, document: agentDocument([mediaBlock(run.catalogs.media[0].ref)]) }), { accepted: true, revision: 2 });
  session.finish(0);
  assert.equal(attempt.builder.status, 'complete');
});
