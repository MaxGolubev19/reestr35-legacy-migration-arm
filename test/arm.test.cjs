'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { testTempRoot, testOutput } = require('./support.cjs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { Queue, createServer, acquireLock, createShutdownController } = require('../src/server.cjs');
const { normalizeUrl, layout, buildArgs, buildPrompt, validateResult, stopTree, safeFile } = require('../src/lib.cjs');
const { publishLease } = require('../src/launcher.cjs');
const { loadFormatDuration } = require('./duration-format.cjs');

test('frontend URL policy matches backend canonicalization and rejects unsafe addresses', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  new vm.Script(source);
  const policy = source.match(/function normalizeInputUrl\(input\) \{[\s\S]*?(?=\n  function rowFeedback)/)?.[0];
  assert.ok(policy, 'frontend normalization function must exist');
  const normalizeFrontend = vm.runInNewContext(`${policy}; normalizeInputUrl`, { URL });
  const inputs = ['https://Mori-Cinema.reestr35.ru:443/#tab', 'https://nested.a.reestr35.ru/path?q=1',
    'http://a.reestr35.ru', 'https://reestr35.ru', 'https://a.reestr35.ru.evil.test', 'https://x:y@a.reestr35.ru',
    'https://a.reestr35.ru:444', 'https://a.reestr35.ru./', 'https://a.reestr35.ru\\@evil.test',
    'https://-a.reestr35.ru', '//a.reestr35.ru', '/relative', '', null, false, 'https://a.reestr35.ru/a b',
    'https://a.reestr35.ru/' + 'a'.repeat(4096), 'https://a.reestr35.ru/a\nb'];
  for (const input of inputs) {
    let expected;
    try { expected = normalizeUrl(input); }
    catch { assert.throws(() => normalizeFrontend(input), String(input)); continue; }
    assert.equal(normalizeFrontend(input), expected);
  }
});

function temp(t) {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(root, job, attempt, options = {}) {
  const locations = layout(root, job, attempt);
  fs.mkdirSync(locations.hostDir, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(locations.hostDir, '00_страница.png'), options.badPng ? 'bad png' : png);
  const report = { url: job.url, finalUrl: job.url, status: 'complete', segments: [{ file: '00_страница.png', status: 'ok', box: { width: 1, height: 1 }, png: { width: 1, height: 1 } }], errors: [], ...options.report };
  fs.writeFileSync(locations.report, JSON.stringify(report));
  fs.writeFileSync(locations.final, JSON.stringify({ reportStatus: 'complete', inspectedPngs: ['00_страница.png'], issues: [], summary: 'Осмотрено', ...options.final }));
}
function setup(t, options = {}) {
  const root = temp(t), children = [], calls = [];
  const queue = new Queue({ root, autoStart: false, spawnFn: (command, args, config) => {
    const child = new EventEmitter(); child.pid = 1000 + children.length; child.exitCode = null;
    child.stdin = new Writable({ write(chunk, encoding, callback) { child.prompt = (child.prompt || '') + chunk; callback(); } });
    child.finish = code => { publishLease(config.armLaunch.dir, config.armLaunch, { status: 'finished', pid: child.pid, exitCode: code }); child.exitCode = code; child.emit('close', code, null); };
    children.push(child); calls.push({ command, args, config }); return child;
  }, stopFn: async child => child?.finish(0), ...options });
  return { root, queue, children, calls };
}

test('URL policy and canonical dedupe', t => {
  assert.equal(normalizeUrl('https://Mori-Cinema.reestr35.ru:443/#tab'), 'https://mori-cinema.reestr35.ru/');
  for (const url of ['http://a.reestr35.ru', 'https://reestr35.ru', 'https://a.reestr35.ru.evil.test', 'https://x:y@a.reestr35.ru', 'https://a.reestr35.ru:444', 'https://a.reestr35.ru./', 'https://a.reestr35.ru\\@evil.test', 'https://-a.reestr35.ru']) assert.throws(() => normalizeUrl(url));
  const { queue } = setup(t);
  const result = queue.add('https://a.reestr35.ru\nhttps://A.reestr35.ru:443/#x\nhttps://evil.test\nhttps://b.reestr35.ru');
  assert.equal(result.added.length, 2); assert.equal(result.duplicates.length, 1); assert.equal(result.invalid.length, 1);
  assert.ok(layout('root', { id: 'job', url: 'https://con.reestr35.ru' }, { number: 1 }).hostDir.endsWith('_con.reestr35.ru'));
});

test('FIFO concurrency 2, fixed arguments, stdin, and new retry attempt', async t => {
  const { queue, children, calls, root } = setup(t);
  queue.add('https://a.reestr35.ru\nhttps://b.reestr35.ru\nhttps://c.reestr35.ru');
  queue.pump();
  assert.equal(children.length, 2); assert.equal(queue.jobs[2].attempts[0].status, 'queued');
  assert.equal(calls[0].config.shell, false); assert.ok(calls[0].args[0].endsWith('capture.cjs'));
  assert.ok(calls[0].args.includes(queue.jobs[0].url)); assert.equal(children[0].prompt || '', '');
  fixture(root, queue.jobs[0], queue.jobs[0].attempts[0]); children[0].finish(0);
  assert.equal(children.length, 3); assert.equal(queue.jobs[0].attempts[0].status, 'incomplete', 'an unfinished report cannot complete the capture');
  children[1].finish(1); children[2].finish(1);
  queue.retry(queue.jobs[0].id);
  assert.equal(queue.jobs[0].attempts.length, 2); assert.ok(fs.existsSync(layout(root, queue.jobs[0], queue.jobs[0].attempts[0]).report));
  assert.ok(!fs.existsSync(layout(root, queue.jobs[0], queue.jobs[0].attempts[1]).report));
});

test('complete requires report, PNG signature, exact visual inventory and zero CLI exit', t => {
  const { root, queue } = setup(t); queue.add('https://a.reestr35.ru');
  const job = queue.jobs[0], attempt = job.attempts[0];
  fixture(root, job, attempt); assert.equal(validateResult(root, job, attempt, 0).status, 'complete');
  assert.equal(validateResult(root, job, attempt, 2).status, 'incomplete');
  assert.equal(validateResult(root, job, attempt, 1).status, 'failed');
  fixture(root, job, attempt, { badPng: true }); assert.equal(validateResult(root, job, attempt, 0).status, 'incomplete');
  fixture(root, job, attempt, { final: { inspectedPngs: [] } }); assert.equal(validateResult(root, job, attempt, 0).status, 'needs_review');
  fixture(root, job, attempt, { final: { inspectedPngs: ['00_страница.png', 'extra.png'] } }); assert.equal(validateResult(root, job, attempt, 0).status, 'needs_review');
  fixture(root, job, attempt, { final: { issues: ['Не смог осмотреть iframe'] } }); assert.equal(validateResult(root, job, attempt, 0).status, 'needs_review');
  fixture(root, job, attempt, { final: { issues: [123] } }); assert.equal(validateResult(root, job, attempt, 0).status, 'needs_review');
  fixture(root, job, attempt, { report: { finalUrl: 'https://evil.test/' } }); assert.equal(validateResult(root, job, attempt, 0).status, 'incomplete');
  fixture(root, job, attempt, { report: { segments: [{ file: '../../secret.png', status: 'ok' }] } }); assert.equal(validateResult(root, job, attempt, 0).status, 'incomplete');
  fixture(root, job, attempt, { report: { status: 'incomplete' } }); assert.equal(validateResult(root, job, attempt, 0).status, 'incomplete');
});

test('cancellation survives successful close; queued stop; recovery is interrupted', async t => {
  const { root, queue, children } = setup(t); queue.add('https://a.reestr35.ru\nhttps://b.reestr35.ru\nhttps://c.reestr35.ru'); queue.pump();
  await queue.stop(queue.jobs[2].id); assert.equal(queue.jobs[2].attempts[0].status, 'cancelled');
  fixture(root, queue.jobs[0], queue.jobs[0].attempts[0]); await queue.stop(queue.jobs[0].id);
  assert.equal(queue.jobs[0].attempts[0].status, 'cancelled');
  const recovered = new Queue({ root, autoStart: false });
  assert.equal(recovered.jobs[0].attempts[0].status, 'cancelled'); assert.equal(recovered.jobs[1].attempts[0].status, 'interrupted');
  children[1].finish(1);
});

test('finalUrl is required, HTTPS and must preserve the source origin', t => {
  const { root, queue } = setup(t); queue.add('https://a.reestr35.ru');
  const job = queue.jobs[0], attempt = job.attempts[0];
  for (const finalUrl of [undefined, null, '', false, 0, 'https://b.reestr35.ru/', 'http://a.reestr35.ru/', 'https://a.reestr35.ru:444/']) {
    fixture(root, job, attempt, { report: { finalUrl } });
    assert.equal(validateResult(root, job, attempt, 0).status, 'incomplete', `Rejected finalUrl ${finalUrl}`);
  }
  for (const finalUrl of ['https://A.reestr35.ru/', 'https://a.reestr35.ru/#tab3']) {
    fixture(root, job, attempt, { report: { finalUrl } });
    assert.equal(validateResult(root, job, attempt, 0).status, 'complete');
  }
});

test('retry preserves orphaned attempt reservation after crash before state save', t => {
  const { root, queue } = setup(t); queue.add('https://a.reestr35.ru');
  const job = queue.jobs[0]; job.attempts[0].status = 'failed'; queue.save();
  const orphan = queue.newAttempt(job); const orphanDir = layout(root, job, orphan).dir;
  fs.writeFileSync(path.join(orphanDir, 'evidence.txt'), 'preserve me');
  // Reload the durable state, which never recorded attempt 2.
  const recovered = new Queue({ root, autoStart: false }); recovered.retry(job.id);
  assert.equal(recovered.jobs[0].attempts.at(-1).number, 3);
  assert.equal(fs.readFileSync(path.join(orphanDir, 'evidence.txt'), 'utf8'), 'preserve me');
});

test('add preparation/save failure rolls back the entire batch and queue order while preserving reserved directories', t => {
  for (const failure of ['prepare', 'save']) {
    const { root, queue, children } = setup(t);
    queue.add('https://existing.reestr35.ru');
    const existing = queue.jobs[0]; existing.attempts[0].status = 'failed'; queue.save();
    const previousOrder = queue.nextQueueOrder, durable = fs.readFileSync(queue.stateFile);
    const save = queue.save, prepare = queue.stage.prepareAttempt, reserved = []; let saves = 0;
    queue.stage.prepareAttempt = function(job, attempt) {
      reserved.push(layout(root, job, attempt).dir);
      if (failure === 'prepare' && reserved.length === 2) throw new Error('fixture prepare failure');
      return prepare.call(this, job, attempt);
    };
    queue.save = function() { saves++; throw new Error('fixture save failure'); };
    try {
      assert.throws(() => queue.add('https://first.reestr35.ru\nhttps://second.reestr35.ru'), new RegExp(`fixture ${failure} failure`));
    } finally { queue.save = save; queue.stage.prepareAttempt = prepare; }
    assert.equal(saves, failure === 'save' ? 1 : 0);
    assert.deepEqual(queue.jobs, [existing]); assert.equal(queue.nextQueueOrder, previousOrder);
    assert.deepEqual(fs.readFileSync(queue.stateFile), durable);
    assert.equal(reserved.length, 2); assert.ok(reserved.every(dir => fs.existsSync(dir)));
    assert.ok(fs.existsSync(path.join(reserved[0], 'job.json')));
    queue.pump(); assert.equal(children.length, 0, 'rejected batch cannot be dispatched');
    const result = queue.add('https://first.reestr35.ru\nhttps://second.reestr35.ru');
    assert.equal(result.added.length, 2);
    assert.deepEqual(queue.jobs.slice(1).map(job => job.attempts[0].queueOrder), [previousOrder + 1, previousOrder + 2]);
    assert.ok(reserved.every(dir => fs.existsSync(dir)), 'successful retry preserves previous orphan directories');
  }
});

test('retry save failure retains old attempt and reserves the rejected attempt number', t => {
  const { root, queue, children } = setup(t); queue.add('https://a.reestr35.ru');
  const job = queue.jobs[0], previous = job.attempts[0]; previous.status = 'failed'; queue.save();
  const durable = fs.readFileSync(queue.stateFile), save = queue.save;
  queue.save = () => { throw new Error('fixture retry save'); };
  assert.throws(() => queue.retry(job.id), /fixture retry save/);
  queue.save = save;
  assert.deepEqual(job.attempts, [previous]); assert.deepEqual(fs.readFileSync(queue.stateFile), durable);
  const orphanDir = layout(root, job, { number: 2 }).dir;
  assert.ok(fs.existsSync(path.join(orphanDir, 'job.json')));
  fs.writeFileSync(path.join(orphanDir, 'evidence.txt'), 'preserve rejected reservation');
  queue.pump(); assert.equal(children.length, 0);
  queue.retry(job.id);
  assert.equal(job.attempts.at(-1).number, 3);
  assert.equal(fs.readFileSync(path.join(orphanDir, 'evidence.txt'), 'utf8'), 'preserve rejected reservation');
});

test('add saves once per batch and snapshots share the latest attempt summary', t => {
  const { queue } = setup(t), save = queue.save; let saves = 0;
  queue.save = function() { saves++; return save.call(this); };
  queue.add('https://a.reestr35.ru\nhttps://b.reestr35.ru\nhttps://a.reestr35.ru');
  assert.equal(saves, 1);
  const unchanged = queue.add('https://a.reestr35.ru\ninvalid'); assert.equal(saves, 1);
  assert.deepEqual(unchanged.added, []); assert.deepEqual(unchanged.duplicates, ['https://a.reestr35.ru/']);
  assert.equal(unchanged.invalid.length, 1); assert.equal(unchanged.invalid[0].input, 'invalid');
  const job = queue.jobs[0]; job.attempts[0].status = 'failed'; queue.retry(job.id);
  const calls = [];
  queue.pageBuilder = { summary(id, attempt) { calls.push([id, attempt]); return { status: 'unreviewed', revision: attempt }; } };
  const snapshot = queue.snapshot('token');
  assert.deepEqual(calls, [[job.id, 1], [job.id, 2], [queue.jobs[1].id, 1]]);
  for (const projected of snapshot.jobs) assert.deepEqual(projected.pageBuilder, projected.attempts.at(-1).pageBuilder);
  assert.equal(snapshot.csrfToken, 'token'); assert.equal(snapshot.concurrency, 2);
});

test('maximum 200 URL batch publishes state once and retains API/FIFO order', t => {
  const { queue } = setup(t), save = queue.save; let saves = 0;
  queue.save = function() { saves++; return save.call(this); };
  const urls = Array.from({ length: 200 }, (_, index) => `https://batch-${index}.reestr35.ru/`);
  const result = queue.add(urls.join('\n'));
  assert.equal(saves, 1); assert.deepEqual(Object.keys(result).sort(), ['added', 'duplicates', 'invalid']);
  assert.deepEqual(result.added, queue.jobs.map(job => job.id)); assert.deepEqual(result.duplicates, []); assert.deepEqual(result.invalid, []);
  assert.deepEqual(queue.jobs.map(job => job.url), urls);
  assert.deepEqual(queue.jobs.map(job => job.attempts[0].queueOrder), Array.from({ length: 200 }, (_, index) => index + 1));
  assert.deepEqual(JSON.parse(fs.readFileSync(queue.stateFile)).jobs, queue.jobs);
});

test('missing media preview uses a neutral SVG and escapes the supplied label', async t => {
  const { queue } = setup(t); queue.add('https://a.reestr35.ru');
  const job = queue.jobs[0];
  queue.pageBuilder.media = () => ({ id: 'empty-image', alt: '<script>label</script>' });
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/page-builder/${job.id}/media/empty-image?attempt=1`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
  const svg = await response.text();
  assert.match(svg, /Предпросмотр изображения недоступен/); assert.doesNotMatch(svg, /Mori Cinema|<script>/);
  assert.match(svg, /&lt;script&gt;label&lt;\/script&gt;/);
});

test('media previews verify current bytes and reject forged detected MIME before inline delivery', async t => {
  const { root, queue } = setup(t); queue.add('https://a.reestr35.ru');
  const job = queue.jobs[0], attempt = job.attempts[0], dir = path.join(root, 'media-fixture');
  attempt.htmlMedia = { revision: 1 };
  fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
  const asset = { id: 'image', originalUrl: 'https://a.reestr35.ru/image.bin' }, manifest = { resources: [] };
  queue.pageBuilder.media = () => asset;
  queue.stage.media.read = () => manifest; queue.stage.media.directory = () => dir;
  const install = bytes => {
    const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const item = { status: 'downloaded', originalUrl: asset.originalUrl, mime: 'application/octet-stream', detectedMime: 'image/png', bytes: bytes.length, sha256, object: `objects/${sha256}` };
    manifest.resources = [item]; fs.writeFileSync(path.join(dir, item.object), bytes); return item;
  };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=', 'base64');
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const urls = item => [`${base}/api/page-builder/${job.id}/media/image?attempt=1`, `${base}/api/html-media/${job.id}/1/1/${item.object}`];
  const item = install(png);
  for (const url of urls(item)) {
    const response = await fetch(url); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  }
  const changed = Buffer.from(png); changed[changed.length - 1] ^= 1; fs.writeFileSync(path.join(dir, item.object), changed);
  for (const url of urls(item)) {
    const response = await fetch(url); assert.equal(response.status, 400); assert.match(await response.text(), /checksum mismatch/);
  }
  const forged = install(Buffer.from('<html><script>alert(1)</script></html>'));
  for (const url of urls(forged)) {
    const response = await fetch(url); assert.equal(response.status, 400);
    assert.notEqual(response.headers.get('content-type'), 'image/png'); assert.notEqual(response.headers.get('content-disposition'), 'inline');
  }
});

test('failed stop is retryable and cancellation intent survives a successful exit', async t => {
  let calls = 0;
  const { root, queue, children } = setup(t, { stopFn: async child => {
    calls++; if (calls === 1) throw new Error('taskkill denied'); child.finish(0);
  } });
  queue.add('https://a.reestr35.ru'); queue.pump();
  const job = queue.jobs[0], attempt = job.attempts[0]; fixture(root, job, attempt);
  await assert.rejects(queue.stop(job.id), /taskkill denied/);
  assert.equal(attempt.status, 'running'); assert.equal(attempt.cancellationRequested, true);
  assert.equal(queue.active.size, 1); assert.match(attempt.error, /можно повторить/);
  await queue.stop(job.id); assert.equal(calls, 2); assert.equal(attempt.status, 'cancelled');
  assert.equal(attempt.error, undefined); assert.equal(attempt.stopError, undefined);
  assert.equal(queue.active.size, 0); assert.equal(children.length, 1);
});

test('worker prompt pins available Node, NODE_PATH and Chrome executable', t => {
  const { root, queue } = setup(t); queue.add('https://a.reestr35.ru');
  const job = queue.jobs[0], attempt = job.attempts[0];
  const prompt = buildPrompt('workspace', job, attempt, layout(root, job, attempt), { node: 'C:\\runtime\\node.exe', modules: 'C:\\runtime\\node_modules', chrome: 'C:\\Chrome\\chrome.exe' });
  assert.ok(prompt.includes("& 'C:\\runtime\\node.exe'"));
  assert.ok(prompt.includes("--executable 'C:\\Chrome\\chrome.exe'"));
  assert.ok(prompt.includes("$env:NODE_PATH='C:\\runtime\\node_modules'"));
});

test('spawn errors fail the job and continue queue', t => {
  const { queue, children } = setup(t); queue.add('https://a.reestr35.ru\nhttps://b.reestr35.ru\nhttps://c.reestr35.ru'); queue.pump();
  children[0].emit('error', new Error('ENOENT codex')); children[0].finish(-2);
  assert.equal(queue.jobs[0].attempts[0].status, 'failed'); assert.equal(children.length, 3);
  children[1].finish(1); children[2].finish(1);
});

test('API origin/CSRF protection, allowlisted files, logs and forbidden fields', async t => {
  const { root, queue } = setup(t);
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stageAsset = await fetch(base + '/assets/html-media-in-development.png');
  assert.equal(stageAsset.status, 200);
  assert.equal(stageAsset.headers.get('content-type'), 'image/png');
  assert.ok((await stageAsset.arrayBuffer()).byteLength > 0);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal((await fetch(base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const headers = { 'content-type': 'application/json', 'x-csrf-token': state.csrfToken };
  assert.equal((await fetch(base + '/api/jobs', { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/jobs', { method: 'POST', headers, body: JSON.stringify({ urls: 'https://a.reestr35.ru', command: 'evil' }) })).status, 400);
  const added = await (await fetch(base + '/api/jobs', { method: 'POST', headers, body: JSON.stringify({ urls: 'https://a.reestr35.ru' }) })).json();
  const job = queue.get(added.added[0]), attempt = job.attempts[0]; fixture(root, job, attempt);
  Object.assign(attempt, validateResult(root, job, attempt, 0));
  const refreshed = await (await fetch(base + '/api/state')).json();
  const pngUrl = refreshed.jobs[0].attempts[0].files.find(file => file.kind === 'png').url;
  assert.equal((await fetch(base + pngUrl)).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + `/api/files/${job.id}/1/prompt.txt`)).status, 404);
  assert.equal((await fetch(base + `/api/files/${job.id}/1/..%5C..%5Cstate.json`)).status, 404);
  assert.equal((await fetch(base + `/api/logs/${job.id}/1?stream=other`)).status, 400);
  fs.writeFileSync(path.join(layout(root, job, attempt).dir, 'stderr.log'), 'x'.repeat(140 * 1024));
  const log = await (await fetch(base + `/api/logs/${job.id}/1?stream=stderr`)).json(); assert.equal(log.truncated, true); assert.equal(log.text.length, 128 * 1024);
});

test('shutdown API is exact, protected, one-shot, and flushes success before teardown callback', async t => {
  const { queue } = setup(t), events = [];
  const server = createServer(queue, { onShutdown: () => { events.push('callback'); } });
  server.prependListener('request', (request, response) => {
    if (request.url === '/api/shutdown') response.once('finish', () => { if (response.statusCode === 200) events.push('finish'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(base + '/api/state')).json();
  const headers = { 'Content-Type': 'application/json', 'x-csrf-token': state.csrfToken };
  const trustedHeaders = { ...headers, Origin: base, 'sec-fetch-site': 'same-origin' };
  const post = (data, extra = {}) => fetch(base + '/api/shutdown', { method: 'POST', headers: { ...trustedHeaders, ...extra }, body: JSON.stringify(data) });
  assert.equal((await fetch(base + '/api/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/shutdown', { method: 'POST', headers, body: '{}' })).status, 403, 'Origin and sec-fetch-site are mandatory');
  assert.equal((await fetch(base + '/api/shutdown', { method: 'POST', headers: { ...headers, Origin: base }, body: '{}' })).status, 403, 'sec-fetch-site is mandatory');
  assert.equal((await fetch(base + '/api/shutdown', { method: 'POST', headers: { ...headers, 'sec-fetch-site': 'same-origin' }, body: '{}' })).status, 403, 'Origin is mandatory');
  assert.equal((await post({}, { Origin: 'https://evil.test' })).status, 403);
  for (const site of ['cross-site', 'same-site', 'none', '']) assert.equal((await post({}, { 'sec-fetch-site': site })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = require('node:http').request(base + '/api/shutdown', { method: 'POST', headers: { ...trustedHeaders, Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(badHostStatus, 403);
  for (const data of [null, [], false, '', { force: true }]) assert.equal((await post(data)).status, 400, JSON.stringify(data));
  const response = await post({});
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['finish', 'callback'], 'teardown begins only after the complete 200 response');
  assert.equal((await post({})).status, 409);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['finish', 'callback'], 'later requests cannot launch teardown again');
});

test('shutdown controller preserves Queue.shutdown, releases lock, then closes HTTP once without process exit', async t => {
  const events = [], { root, queue, children } = setup(t, { stopFn: async child => {
    events.push('capture.stop'); child.finish(0); return { treeStopped: true };
  } });
  queue.add('https://queued.reestr35.ru/'); queue.pump();
  assert.equal(queue.active.size, 1); assert.equal(children.length, 1);
  let qaShutdowns = 0;
  queue.qaServers.add({ async shutdown() { qaShutdowns++; events.push('qa.shutdown'); } });
  const lockFile = path.join(root, 'server.lock'), release = acquireLock(root);
  const originalShutdown = queue.shutdown.bind(queue);
  queue.shutdown = async () => { events.push('queue.shutdown'); await originalShutdown(); };
  const server = {
    listening: true,
    close(callback) { events.push('server.close'); this.listening = false; setImmediate(() => { events.push('server.closed'); callback(); }); },
    closeAllConnections() { events.push('connections.closed'); }
  };
  const stop = createShutdownController({
    queue, server,
    unlock() { assert.equal(fs.existsSync(lockFile), true); release(); events.push('lock.released'); },
    exitFn(code) { events.push(`exit:${code}`); }
  });
  const first = stop(), second = stop();
  assert.equal(first, second, 'all shutdown triggers share one lifecycle');
  assert.equal(await first, 0);
  assert.deepEqual(events, ['queue.shutdown', 'capture.stop', 'qa.shutdown', 'lock.released', 'server.close', 'connections.closed', 'server.closed', 'exit:0']);
  assert.equal(qaShutdowns, 1); assert.equal(queue.active.size, 0);
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(queue.closing, true);
  const recovered = new Queue({ root, autoStart: false });
  t.after(() => recovered.shutdown());
  assert.equal(recovered.jobs.length, 1); assert.equal(recovered.jobs[0].url, 'https://queued.reestr35.ru/');
  assert.equal(recovered.jobs[0].attempts[0].status, 'cancelled');
});

test('shutdown controller bounds a stuck Queue.shutdown before releasing lock and HTTP server', async t => {
  const root = temp(t), lockFile = path.join(root, 'server.lock'), release = acquireLock(root), events = [];
  const queue = { active: new Map(), shutdown() { events.push('queue.shutdown'); return new Promise(() => {}); } };
  const server = {
    listening: true,
    close(callback) { events.push('server.close'); this.listening = false; setImmediate(callback); },
    closeAllConnections() { events.push('connections.closed'); }
  };
  const stop = createShutdownController({ queue, server, timeoutMs: 20,
    unlock() { release(); events.push('lock.released'); }, exitFn(code) { events.push(`exit:${code}`); } });
  assert.equal(await stop(), 1);
  assert.equal(fs.existsSync(lockFile), false);
  assert.deepEqual(events, ['queue.shutdown', 'lock.released', 'server.close', 'connections.closed', 'exit:1']);
});

test('pause/resume preserves an unstarted attempt, survives restart and resumes at the FIFO tail', async t => {
  const { root, queue, children } = setup(t, { concurrency: 1 });
  queue.add('https://a.reestr35.ru\nhttps://b.reestr35.ru\nhttps://c.reestr35.ru');
  const [a, b, c] = queue.jobs;
  const attempt = a.attempts[0]; attempt.queuedAt = '2020-01-01T00:00:00Z';
  queue.pause(a.id);
  assert.equal(attempt.status, 'paused'); assert.equal(queue.active.size, 0);
  const recovered = new Queue({ root, autoStart: false });
  assert.equal(recovered.jobs[0].attempts[0].status, 'paused');
  assert.equal(recovered.snapshot('').jobs[0].status, 'paused');
  assert.equal(queue.snapshot('').jobs[0].canRecapture, true);
  await assert.rejects(queue.stop(a.id), { statusCode: 409 });
  assert.throws(() => queue.pause(a.id), { statusCode: 409 });
  queue.autoStart = true; queue.pump(); assert.equal(b.attempts[0].status, 'running');
  assert.equal(queue.snapshot('').jobs[1].canPause, true);
  assert.throws(() => queue.resume(b.id), { statusCode: 409 });
  queue.resume(a.id);
  assert.equal(a.attempts.length, 1); assert.equal(a.attempts[0], attempt);
  assert.equal(attempt.status, 'queued'); assert.ok(attempt.queueOrder > c.attempts[0].queueOrder);
  assert.notEqual(attempt.queuedAt, '2020-01-01T00:00:00Z');
  children[0].finish(1); assert.equal(c.attempts[0].status, 'running');
  children[1].finish(1); assert.equal(attempt.status, 'running');
  assert.equal(queue.snapshot('').jobs[0].isActive, true);
  children[2].finish(1); assert.equal(queue.snapshot('').jobs[0].isActive, false);
  queue.retry(a.id); // launch immediately in the newly available slot
  assert.equal(a.attempts.at(-1).status, 'running');
  queue.pause(a.id); assert.equal(a.attempts.at(-1).status, 'pausing', 'queued-to-running race safely pauses the running worker');
  children[3].finish(1);
  const pending = queue.newAttempt(a); queue.pause(a.id);
  queue.resume(a.id); assert.equal(pending.status, 'running', 'resume pumps immediately'); children[4].finish(1);
});

test('pause/resume invalid transitions and persistence failures do not mutate state', async t => {
  const { queue } = setup(t); queue.add('https://a.reestr35.ru');
  const job = queue.jobs[0], attempt = job.attempts[0];
  for (const status of ['running', 'validating', 'stopping', 'complete', 'needs_review', 'incomplete', 'failed', 'cancelled', 'interrupted']) {
    attempt.status = status;
    assert.throws(() => queue.pause(job.id), { statusCode: 409 });
    assert.throws(() => queue.resume(job.id), { statusCode: 409 });
    assert.equal(attempt.status, status);
  }
  attempt.status = 'validating'; await assert.rejects(queue.stop(job.id), { statusCode: 409 });
  assert.equal(attempt.status, 'validating');
  attempt.status = 'queued';
  const save = queue.save;
  queue.save = () => { throw new Error('disk failure'); };
  assert.throws(() => queue.pause(job.id), /disk failure/); assert.equal(attempt.status, 'queued');
  queue.save = save; queue.pause(job.id);
  const prior = { ...attempt };
  queue.save = () => { throw new Error('disk failure'); };
  assert.throws(() => queue.resume(job.id), /disk failure/); assert.deepEqual(attempt, prior);
  queue.save = save;
});

test('pause/resume API has conflict, exact body, CSRF and Origin protection', async t => {
  const { queue } = setup(t); queue.add('https://a.reestr35.ru');
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(base + '/api/state')).json();
  const id = queue.jobs[0].id;
  const post = (action, data = {}, extra = {}) => fetch(`${base}/api/jobs/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.csrfToken, ...extra }, body: JSON.stringify(data) });
  for (const action of ['pause', 'resume']) {
    assert.equal((await post(action, {}, { 'x-csrf-token': 'bad' })).status, 403);
    assert.equal((await post(action, {}, { Origin: 'https://evil.test' })).status, 403);
    for (const value of [[], null, false, { force: true }]) assert.equal((await post(action, value)).status, 400);
  }
  assert.equal((await post('resume')).status, 409);
  assert.equal((await post('pause')).status, 200);
  assert.equal((await post('pause')).status, 409);
  assert.equal((await post('stop')).status, 405);
  assert.equal((await post('resume')).status, 200);
  assert.equal((await post('resume')).status, 409);
  queue.pump(); assert.equal((await post('pause')).status, 200);
  await queue.shutdown();
});

test('attempt duration advances only for active attempts and terminal durations are stable', () => {
  const duration = loadFormatDuration();
  const startedAt = '2026-01-01T00:00:00Z', activeSince = Date.parse(startedAt);
  assert.equal(duration({ startedAt, activeDurationMs: 3600000, activeSince, status: 'running' }, activeSince + 61000), '01:01:01');
  assert.equal(duration({ startedAt, activeDurationMs: 42000, finishedAt: '2026-02-01T00:00:42Z', status: 'complete' }, Date.now()), '00:00:42');
  for (const status of ['queued', 'paused', 'complete', 'cancelled']) assert.equal(duration({ activeDurationMs: 12000, activeSince, status }), '00:00:12');
  assert.equal(duration({ status: 'running', activeDurationMs: 0 }), '00:00:00');
});

test('concurrency setting persists, pumps immediately, and lowering does not stop active children', t => {
  const { root, queue, children } = setup(t, { concurrency: 1 });
  queue.add('https://a.reestr35.ru\nhttps://b.reestr35.ru\nhttps://c.reestr35.ru\nhttps://d.reestr35.ru');
  queue.autoStart = true; queue.pump();
  assert.equal(children.length, 1);
  queue.setConcurrency(3);
  assert.equal(children.length, 3); assert.equal(queue.active.size, 3);
  queue.setConcurrency(1);
  assert.equal(queue.active.size, 3); assert.ok(children.every(child => child.exitCode === null));
  children[0].finish(1); children[1].finish(1);
  assert.equal(children.length, 3); assert.equal(queue.active.size, 1);
  children[2].finish(1);
  assert.equal(children.length, 4); assert.equal(queue.active.size, 1);
  children[3].finish(1);
  assert.equal(JSON.parse(fs.readFileSync(queue.stateFile)).concurrency, 1);
  const recovered = new Queue({ root, concurrency: 8, autoStart: false });
  assert.equal(recovered.concurrency, 1); assert.equal(recovered.snapshot('').concurrency, 1);
  const saved = JSON.parse(fs.readFileSync(queue.stateFile)); delete saved.concurrency;
  fs.writeFileSync(queue.stateFile, JSON.stringify(saved));
  assert.equal(new Queue({ root, concurrency: 4, autoStart: false }).concurrency, 4, 'legacy state uses initial fallback');
  const originalSave = queue.save;
  queue.save = () => { throw new Error('disk failure'); };
  assert.throws(() => queue.setConcurrency(6), /disk failure/); assert.equal(queue.concurrency, 1);
  queue.save = originalSave;
});

test('settings API rejects arbitrary settings, non-integers and untrusted mutations', async t => {
  const { queue } = setup(t);
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(base + '/api/state')).json();
  const headers = { 'Content-Type': 'application/json', 'x-csrf-token': state.csrfToken };
  const post = (data, extra = {}) => fetch(base + '/api/settings', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) });
  for (const data of [null, [], {}, { concurrency: 2, command: 'evil' }, { setting: 2 }, { concurrency: '2' }, { concurrency: null }, { concurrency: false }, { concurrency: 1.5 }, { concurrency: 0 }, { concurrency: 9 }]) {
    assert.equal((await post(data)).status, 400, JSON.stringify(data));
    assert.equal(queue.concurrency, 2);
  }
  assert.equal((await post({ concurrency: 3 }, { 'x-csrf-token': 'bad' })).status, 403);
  assert.equal((await post({ concurrency: 3 }, { Origin: 'https://evil.test' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = require('node:http').request(base + '/api/settings', { method: 'POST', headers: { ...headers, Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end(JSON.stringify({ concurrency: 3 }));
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await post({ concurrency: 3 }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  for (const concurrency of [1, 8]) assert.deepEqual(await (await post({ concurrency })).json(), { concurrency });
  assert.equal((await (await fetch(base + '/api/state')).json()).concurrency, 8);
});

test('safeFile refuses real paths outside allowed folder', t => {
  const root = temp(t); const inner = path.join(root, 'inner'); fs.mkdirSync(inner); const secret = path.join(root, 'secret.txt'); fs.writeFileSync(secret, 'secret');
  assert.throws(() => safeFile(inner, secret));
  const junction = path.join(inner, 'outside');
  try { fs.symlinkSync(root, junction, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.throws(() => safeFile(inner, path.join(junction, 'secret.txt')));
});

test('Windows stop targets only child PID tree using spawn without shell', async () => {
  let invocation;
  await stopTree({ pid: 1234, exitCode: null }, 'win32', (command, args, options) => {
    invocation = { command, args, options }; const child = new EventEmitter(); setImmediate(() => child.emit('exit', 0)); return child;
  });
  assert.deepEqual(invocation.args, ['/PID', '1234', '/T', '/F']); assert.equal(invocation.options.shell, false);
});

test('Windows taskkill actually stops a Node parent and its child', { skip: process.platform !== 'win32', timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['-e', "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(c.pid);setInterval(()=>{},1000);"], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  const descendant = await new Promise((resolve, reject) => { child.stdout.once('data', chunk => resolve(Number(chunk.toString().trim()))); child.once('error', reject); });
  assert.ok(descendant > 0);
  await stopTree(child); await closed;
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});

test('real child process receives stdin and writes JSONL/stderr files', async t => {
  const root = temp(t);
  const queue = new Queue({ root, autoStart: false, spawnFn: (_command, _args, options) => spawn(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'fixture'}));console.error('diagnostic');process.exitCode=1;});"], options) });
  queue.add('https://a.reestr35.ru'); queue.pump();
  await new Promise(resolve => queue.active.values().next().value.once('close', resolve));
  const locations = layout(root, queue.jobs[0], queue.jobs[0].attempts[0]);
  assert.match(fs.readFileSync(path.join(locations.dir, 'events.jsonl'), 'utf8'), /fixture/);
  assert.match(fs.readFileSync(path.join(locations.dir, 'stderr.log'), 'utf8'), /diagnostic/);
  assert.equal(queue.jobs[0].attempts[0].status, 'failed');
  assert.deepEqual(buildArgs('W').slice(-3), ['app-server', '--listen', 'stdio://']);
  assert.ok(!buildArgs('W').includes('exec'));
  assert.ok(buildArgs('W').includes('sandbox_mode="read-only"'));
  assert.ok(!buildArgs('W').includes('danger-full-access'));
});
