'use strict';
// Optional browser acceptance suite: uses temporary fixtures, never starts Codex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { testTempRoot, testOutput } = require('./support.cjs');
const path = require('node:path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { Queue, createServer } = require('../src/server.cjs');
const { seedMoriPage } = require('./page-builder-fixture.cjs');
const { layout, normalizeUrl } = require('../src/lib.cjs');
const { publishLease } = require('../src/launcher.cjs');

function installLocalPreview(queue, job, asset) {
  const attempt = job.attempts.at(-1), manifest = queue.stage.media.create(job, attempt, Buffer.from(`<img src="${asset.originalUrl}">`), 'test');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R5sGAAAAAElFTkSuQmCC', 'base64'), sha256 = crypto.createHash('sha256').update(png).digest('hex');
  fs.writeFileSync(path.join(queue.stage.media.directory(job, attempt), 'objects', sha256), png);
  Object.assign(manifest.resources[0], { status: 'downloaded', finalUrl: asset.originalUrl, redirects: [], mime: 'image/png', bytes: png.length, sha256, object: `objects/${sha256}` });
  queue.stage.media.publishImage(job, attempt, manifest.resources[0]);
  queue.stage.media.publish(job, attempt, manifest); return png;
}

test('connected indicator sends one protected shutdown POST and reaches disconnected only after server loss', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-shutdown-ui-'));
  let spawns = 0, shutdownCalls = 0, server;
  const queue = new Queue({ root, autoStart: false, spawnFn() { spawns++; throw new Error('shutdown must not launch a backend'); } });
  server = createServer(queue, { async onShutdown() {
    shutdownCalls++;
    await new Promise(resolve => setTimeout(resolve, 150));
    await queue.shutdown();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => {
    await browser.close();
    await queue.shutdown();
    if (server.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage(), posts = [], dialogs = [];
  page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  page.on('request', request => {
    if (request.method() === 'POST') posts.push({ path: new URL(request.url()).pathname, body: request.postData(), headers: request.allHeaders() });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  const indicator = page.locator('#connection-control');
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Подключено');
  assert.equal(await indicator.evaluate(node => node.tagName), 'BUTTON');
  assert.equal(await indicator.getAttribute('type'), 'button');
  assert.equal(await indicator.getAttribute('title'), 'Отключить');
  assert.equal(await indicator.isEnabled(), true);
  await indicator.click();
  assert.equal(await page.locator('#connection-label').innerText(), 'Отключение…', 'the click changes state synchronously');
  assert.equal(server.listening, true, 'the UI does not claim disconnection while the server is still reachable');
  assert.equal(await indicator.isDisabled(), true, 'shutdown immediately fences repeated clicks');
  await indicator.evaluate(node => { node.click(); node.click(); });
  assert.equal(await page.locator('[role="menu"]').count(), 0);
  assert.deepEqual(dialogs, [], 'shutdown has no confirmation dialog');
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Отключено');
  assert.equal(server.listening, false, 'disconnected is shown only after the HTTP server has closed');
  assert.equal(await page.locator('#connection-dot').evaluate(node => node.classList.contains('bg-red') && !node.classList.contains('status-dot-animated')), true);
  assert.equal(posts.length, 1); assert.equal(posts[0].path, '/api/shutdown'); assert.equal(posts[0].body, '{}');
  const requestHeaders = await posts[0].headers;
  assert.match(requestHeaders['x-csrf-token'], /^[a-f0-9]{64}$/);
  assert.equal(requestHeaders.origin, origin); assert.equal(requestHeaders['sec-fetch-site'], 'same-origin');
  assert.deepEqual(dialogs, []); assert.equal(shutdownCalls, 1); assert.equal(spawns, 0); assert.equal(queue.jobs.length, 0);
});

test('shutdown probe timeout keeps the live server in shutting-down state', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-shutdown-slow-probe-'));
  const queue = new Queue({ root, autoStart: false });
  let shutdownCalls = 0, slowState = false;
  const server = createServer(queue, { onShutdown() { shutdownCalls++; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => {
    await browser.close(); await queue.shutdown();
    if (server.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.route('**/api/state', async route => {
    if (!slowState) { await route.continue(); return; }
    await new Promise(resolve => setTimeout(resolve, 1200));
    try { await route.continue(); } catch {}
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Подключено');
  slowState = true;
  await page.locator('#connection-control').click();
  await page.waitForTimeout(1400);
  assert.equal(server.listening, true); assert.equal(shutdownCalls, 1);
  assert.equal(await page.locator('#connection-label').innerText(), 'Отключение…');
  assert.equal(await page.locator('#connection-control').isDisabled(), true);
});

test('an in-flight polling failure cannot claim disconnect while shutdown probes still reach the server', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-shutdown-held-poll-'));
  const queue = new Queue({ root, autoStart: false });
  let shutdownCalls = 0;
  const server = createServer(queue, { onShutdown() { shutdownCalls++; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => {
    await browser.close(); await queue.shutdown();
    if (server.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  let stateRequests = 0, heldRoute, announceHeld;
  const held = new Promise(resolve => { announceHeld = resolve; });
  await page.route('**/api/state', async route => {
    stateRequests++;
    if (stateRequests === 2) { heldRoute = route; announceHeld(); return; }
    try { await route.continue(); } catch {}
  });
  await page.route('**/api/shutdown', route => route.abort('connectionrefused'));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Подключено');
  await held;
  await page.locator('#connection-control').click();
  while (stateRequests < 3) await page.waitForTimeout(25);
  assert.equal((await fetch(origin + '/api/state')).status, 200, 'a fresh state request proves the server is still live');
  await heldRoute.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"held poll failed"}' });
  await page.waitForTimeout(250);
  assert.equal(server.listening, true);
  assert.equal(shutdownCalls, 0, 'the simulated network failure never reaches the shutdown endpoint');
  assert.equal(await page.locator('#connection-label').innerText(), 'Отключение…');
  assert.equal(await page.locator('#connection-control').isDisabled(), true);
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Отключено');
  assert.equal(server.listening, false);
});

test('shutdown HTTP refusal restores SSE and polling while preserving the error', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-shutdown-refusal-'));
  const queue = new Queue({ root, autoStart: false });
  const server = createServer(queue, { onShutdown() { throw new Error('refused request must not start shutdown'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => {
    await browser.close(); await queue.shutdown();
    if (server.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage(); let eventRequests = 0, stateRequests = 0;
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/events') eventRequests++;
    if (pathname === '/api/state') stateRequests++;
  });
  await page.route('**/api/shutdown', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"fixture denied"}' }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Подключено');
  const beforeStates = stateRequests;
  await page.locator('#connection-control').click();
  await page.waitForFunction(() => document.querySelector('#global-alert').textContent.includes('fixture denied'));
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#connection-label').innerText(), 'Подключено');
  assert.equal(await page.locator('#connection-control').isEnabled(), true);
  assert.match(await page.locator('#global-alert').innerText(), /Не удалось выключить backend: fixture denied/);
  assert.ok(eventRequests >= 2, 'EventSource reconnects after the rejected POST');
  assert.ok(stateRequests > beforeStates, 'polling resumes after the rejected POST');
});

test('shutdown 409 keeps the click fenced and waits for the in-progress server shutdown', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-shutdown-conflict-'));
  const queue = new Queue({ root, autoStart: false });
  let shutdownCalls = 0, server;
  server = createServer(queue, { async onShutdown() {
    shutdownCalls++; await new Promise(resolve => setTimeout(resolve, 500)); await queue.shutdown();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => {
    await browser.close(); await queue.shutdown();
    if (server.listening) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Подключено');
  const snapshot = await (await fetch(origin + '/api/state')).json();
  const primed = await fetch(origin + '/api/shutdown', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'x-csrf-token': snapshot.csrfToken, Origin: origin, 'sec-fetch-site': 'same-origin'
  }, body: '{}' });
  assert.equal(primed.status, 200);
  await page.locator('#connection-control').click();
  assert.equal(await page.locator('#connection-label').innerText(), 'Отключение…');
  assert.equal(await page.locator('#connection-control').isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('#connection-label').textContent === 'Отключено');
  assert.equal(shutdownCalls, 1); assert.equal(server.listening, false);
  assert.equal(await page.locator('#global-alert').isVisible(), false);
});

test('empty detail renders the bundled astronaut responsively without changing its copy', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-empty-detail-'));
  const queue = new Queue({ root, autoStart: false, spawnFn() { throw new Error('empty detail test must not spawn agents'); } });
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  const image = page.locator('#empty-detail .empty-detail-illustration');
  await image.waitFor();
  assert.equal(await image.getAttribute('src'), '/assets/astronaut.png');
  assert.equal(await image.getAttribute('alt'), '', 'the illustration stays decorative because the adjacent copy describes the state');
  assert.deepEqual(await image.evaluate(node => ({ complete: node.complete, width: node.naturalWidth, height: node.naturalHeight })), { complete: true, width: 2000, height: 2000 });
  assert.equal(await page.locator('#empty-detail .empty-title').innerText(), 'Выберите страницу');
  assert.equal(await page.locator('#empty-detail .empty-subtitle').innerText(), 'Здесь появятся результаты обработки.');
  const desktop = await image.boundingBox();
  assert.ok(desktop.width <= 352 && desktop.width >= 300, 'desktop illustration uses the intended capped size');
  const asset = await page.request.get(`${base}/assets/astronaut.png`);
  assert.equal(asset.status(), 200); assert.match(asset.headers()['content-type'], /^image\/png/);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await image.boundingBox();
  assert.ok(mobile.width < desktop.width, 'illustration shrinks on the mobile layout');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('terminal idle result has no user stop or recapture until its process finishes', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-idle-stop-'));
  let timestamp = 0, stops = 0, child, launch;
  const queue = new Queue({ root, autoStart: false, clock: () => timestamp, idleTimeoutMs: 100, setTimer: () => 1, clearTimer() {},
    spawnFn(_command, _args, config) {
      launch = config.armLaunch; child = new (require('node:events').EventEmitter)(); child.pid = 992222; child.exitCode = null;
      child.stdin = new (require('node:stream').Writable)({ write(_chunk, _encoding, callback) { callback(); } });
      publishLease(launch.dir, launch, { status: 'running', wrapperPid: child.pid, childPid: 992223 });
      return child;
    },
    stopFn: async worker => {
      if (++stops === 1) throw new Error('fixture taskkill denied');
      publishLease(launch.dir, launch, { status: 'finished', pid: worker.pid, exitCode: 1 });
      worker.exitCode = 1; worker.emit('close', 1, null); return { treeStopped: true };
    } });
  queue.add('https://idle-stop.reestr35.ru/'); queue.pump();
  const job = queue.jobs[0], attempt = job.attempts[0], loc = layout(root, job, attempt);
  fs.mkdirSync(loc.hostDir, { recursive: true });
  fs.writeFileSync(path.join(loc.hostDir, '00_страница.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(loc.report, JSON.stringify({ url: job.url, finalUrl: job.url, status: 'complete', errors: [], finished: '2026-09-10T10:00:00Z',
    model: { layout: 'plain', root: null, groups: [] },
    segments: [{ file: '00_страница.png', status: 'ok', spec: { kind: 'page' }, chain: [], box: { x: 0, y: 0, width: 1, height: 1 }, png: { width: 1, height: 1, strips: 1 } }] }));
  attempt.qaAutoRetries = 3; // After the automatic budget, the UI must offer manual continuation.
  queue.snapshot(''); timestamp = 101; await queue.tick(job, attempt, child);
  assert.equal(attempt.status, 'needs_review'); assert.equal(queue.active.size, 1);
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { queue.closing = true; await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage(), posts = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const button = page.locator(`[data-job-action="${job.id}"]`);
  await page.waitForFunction(id => document.querySelector(`[data-job-action="${id}"]`)?.dataset.status === 'needs_review', job.id);
  assert.equal(await button.getAttribute('data-action'), '');
  assert.equal(await button.isDisabled(), true);
  await page.locator(`[data-job-id="${job.id}"]`).evaluate(row => row.click());
  assert.equal(await page.locator('#recapture-button').isDisabled(), true);
  await queue.stop(job.id); // Internal recovery/shutdown still owns process stopping.
  await page.waitForFunction(id => document.querySelector(`[data-job-action="${id}"]`)?.dataset.action === 'retry', job.id);
  assert.deepEqual(posts, []); assert.equal(stops, 2);
  assert.equal(attempt.status, 'needs_review'); assert.equal(attempt.cancellationRequested, undefined);
  assert.equal(queue.active.size, 0); assert.equal(job.attempts.length, 1);
});

test('favicon follows workload, errors, paused/cancelled and every state poll without changing title', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-favicon-'));
  const queue = new Queue({ root, autoStart: false, spawnFn() { throw new Error('favicon test must not spawn agents'); } });
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.faviconWrites = 0;
    const original = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (this.id === 'dynamic-favicon' && name === 'href') window.faviconWrites++;
      return original.call(this, name, value);
    };
  });
  let jobs = [];
  let polls = 0;
  await page.route('**/api/state', route => {
    polls++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ csrfToken: 'fixture', concurrency: 2, jobs }) });
  });
  const makeJob = (id, status, isActive = false) => ({ id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, url: `https://favicon-${id}.reestr35.ru/`, status, isActive, attempts: [{ number: 1, status, files: [] }] });
  const readIcon = () => page.locator('#dynamic-favicon').getAttribute('href').then(href => decodeURIComponent(href.split(',')[1]));
  const waitForIcon = (fragment) => page.waitForFunction(fragment => decodeURIComponent(document.querySelector('#dynamic-favicon').href.split(',')[1]).includes(fragment), fragment);

  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await waitForIcon('#2fb344');
  assert.match(await readIcon(), /<path .*stroke="#fff"/);
  assert.equal(await page.title(), 'АРМ миграции страниц');
  const iconHandle = await page.locator('#dynamic-favicon').elementHandle();

  jobs = [makeJob(1, 'cancelled')];
  await waitForIcon('#626976');
  assert.match(await readIcon(), />1<\/text>/, 'cancelled-only uses the gray fallback state');

  jobs = [makeJob(1, 'paused'), makeJob(2, 'paused'), makeJob(3, 'cancelled')];
  await page.waitForFunction(() => decodeURIComponent(document.querySelector('#dynamic-favicon').href.split(',')[1]).includes('>3</text>'));
  assert.match(await readIcon(), />3<\/text>/, 'paused and cancelled jobs are summed in the gray state');

  jobs = [makeJob(1, 'needs_review'), makeJob(2, 'incomplete'), makeJob(3, 'failed'), makeJob(4, 'interrupted'), makeJob(5, 'paused'), makeJob(6, 'cancelled')];
  await waitForIcon('#d63939');
  assert.match(await readIcon(), />4<\/text>/, 'errors take priority over paused and cancelled jobs');

  jobs = [makeJob(1, 'failed'), makeJob(2, 'running', true), makeJob(3, 'queued', true), makeJob(4, 'queued'), makeJob(5, 'paused'), makeJob(6, 'cancelled')];
  await waitForIcon('#206bc4');
  assert.match(await readIcon(), />3<\/text>/, 'live processes take priority; workload includes queued, excludes paused/cancelled and counts overlap once');
  assert.equal(await iconHandle.evaluate(node => node === document.querySelector('#dynamic-favicon')), true, 'the same rel=icon element is reused');
  assert.equal(await page.title(), 'АРМ миграции страниц');

  const writes = await page.evaluate(() => window.faviconWrites);
  const observedPolls = polls;
  await page.waitForFunction(writes => window.faviconWrites > writes, writes);
  assert.ok(polls > observedPolls, 'an unchanged subsequent state poll rewrites the favicon');

  jobs = [...Array.from({ length: 1000 }, (_, index) => makeJob(index + 10, 'failed')), makeJob(2000, 'paused'), makeJob(2001, 'cancelled')];
  await page.waitForFunction(() => decodeURIComponent(document.querySelector('#dynamic-favicon').href.split(',')[1]).includes('>1000</text>'));
  assert.match(await readIcon(), /font-size="10"[^>]*>1000<\/text>/, 'large counts remain exact decimal values and use a smaller font');
  assert.equal(await page.title(), 'АРМ миграции страниц');
});

test('range slider changes live scheduling without terminating active workers', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-slider-'));
  const children = [];
  const queue = new Queue({ root, concurrency: 1, autoStart: false, spawnFn() {
    const child = new (require('node:events').EventEmitter)();
    child.pid = 900000 + children.length; child.exitCode = null;
    child.stdin = new (require('node:stream').Writable)({ write(chunk, encoding, callback) { callback(); } });
    child.finish = () => { child.exitCode = 1; child.emit('close', 1, null); };
    children.push(child); return child;
  } });
  queue.add('https://a.reestr35.ru\nhttps://b.reestr35.ru\nhttps://c.reestr35.ru\nhttps://d.reestr35.ru');
  queue.autoStart = true; queue.pump();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { queue.closing = true; for (const child of children) if (child.exitCode === null) child.finish(); await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !document.querySelector('#concurrency-slider').disabled);
  assert.equal(children.length, 1);
  await page.locator('#concurrency-slider').fill('3');
  await page.waitForFunction(() => document.querySelector('#concurrency-slider').getAttribute('aria-busy') === 'false' && document.querySelector('#concurrency-value').textContent === '3');
  assert.equal(children.length, 3); assert.equal(queue.active.size, 3);
  await page.locator('#concurrency-slider').fill('1');
  await page.waitForFunction(() => document.querySelector('#concurrency-slider').getAttribute('aria-busy') === 'false' && document.querySelector('#concurrency-value').textContent === '1');
  assert.equal(queue.active.size, 3); assert.ok(children.every(child => child.exitCode === null));
  children[0].finish(); children[1].finish(); assert.equal(children.length, 3);
  children[2].finish(); assert.equal(children.length, 4); assert.equal(queue.active.size, 1);
  children[3].finish();
  assert.equal(new Queue({ root, concurrency: 8, autoStart: false }).concurrency, 1);
  const slider = page.locator('#concurrency-slider');
  const idle = () => page.waitForFunction(() => document.querySelector('#concurrency-slider').getAttribute('aria-busy') === 'false');
  await slider.fill('2'); await idle();
  await slider.focus();
  for (const expected of [3, 4]) {
    await page.keyboard.press('ArrowRight'); await idle();
    assert.equal(queue.concurrency, expected);
    assert.equal(await slider.evaluate(node => document.activeElement === node), true, 'keyboard focus survives each successful save');
  }
  const requests = [];
  let releaseFirst, firstArrived;
  const released = new Promise(resolve => { releaseFirst = resolve; });
  const arrived = new Promise(resolve => { firstArrived = resolve; });
  await page.route('**/api/settings', async route => {
    requests.push(route.request().postDataJSON().concurrency);
    const response = await route.fetch();
    if (requests.length === 1) { firstArrived(); await released; }
    await route.fulfill({ response });
  });
  await page.keyboard.press('ArrowRight'); await arrived;
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  assert.equal(await slider.inputValue(), '7');
  assert.equal(await slider.isDisabled(), false);
  assert.deepEqual(requests, [5], 'only one settings request is in flight');
  releaseFirst(); await idle();
  assert.deepEqual(requests, [5, 7], 'rapid updates coalesce to the newest requested limit');
  assert.equal(await slider.inputValue(), '7'); assert.equal(queue.concurrency, 7);
  assert.equal(await slider.evaluate(node => document.activeElement === node), true);
  await page.unroute('**/api/settings');
  // Failures restore the confirmed value without losing keyboard focus.
  let failures = 0;
  await page.route('**/api/settings', route => { failures++; return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"fixture rejection"}' }); });
  for (let index = 0; index < 2; index++) {
    await page.keyboard.press('ArrowLeft'); await idle();
    assert.equal(await slider.inputValue(), '7');
    assert.equal(await slider.evaluate(node => document.activeElement === node), true);
    assert.equal(await page.locator('#settings-error').isVisible(), true);
  }
  assert.equal(failures, 2); assert.equal(queue.concurrency, 7);
});

test('queue icons expose every action, preserve selection, handle races and show elapsed time', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-actions-'));
  const children = [];
  const queue = new Queue({ root, autoStart: false, stopFn: async () => {}, spawnFn() {
    const child = new (require('node:events').EventEmitter)();
    child.pid = 800000 + children.length; child.exitCode = null;
    child.stdin = new (require('node:stream').Writable)({ write(chunk, encoding, callback) { callback(); } });
    child.finish = () => { child.exitCode = 1; child.emit('close', 1, null); };
    children.push(child); return child;
  } });
  const statuses = ['paused', 'queued', 'running', 'pausing', 'complete', 'needs_review', 'incomplete', 'failed', 'interrupted', 'cancelled', 'validating', 'validating', 'queued', 'queued'];
  queue.add(statuses.map((status, i) => `https://icon-${i}.reestr35.ru/`).join('\n'));
  queue.launch(queue.jobs[2]); queue.launch(queue.jobs[11]); queue.closing = true;
  statuses.forEach((status, i) => { queue.jobs[i].attempts[0].status = status; });
  queue.jobs[2].attempts[0].startedAt = new Date(Date.now() - 5000).toISOString();
  Object.assign(queue.jobs[4].attempts[0], { startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:05Z', activeDurationMs: 5000 });
  Object.assign(queue.jobs[13].attempts[0], { phase: 'qa', startedAt: '2026-01-01T00:00:00Z' });
  queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.finish(); await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(new URL(request.url()).pathname); });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('[data-job-action]').length === 14);
  assert.equal(await page.locator('#jobs-body a').count(), 0, 'queue rows contain no links');
  const action = i => page.locator(`[data-job-action="${queue.jobs[i].id}"]`);
  const select = i => page.locator(`[data-job-id="${queue.jobs[i].id}"]`).evaluate(row => row.click());
  const waitStatus = (i, status) => page.waitForFunction(([id, status]) => document.querySelector(`[data-job-action="${id}"]`)?.dataset.status === status, [queue.jobs[i].id, status]);
  const expected = [
    ['resume', 'pause', 'secondary', 'Продолжить'], ['pause', 'clock', 'blue', 'Приостановить'],
    ['pause', 'running', 'blue', 'Приостановить'], ['', 'running', 'yellow', 'Недоступно'],
    ['retry', 'check', 'green', 'Перезапустить'], ['retry', 'alert', 'red', 'Перезапустить'],
    ['retry', 'alert', 'orange', 'Перезапустить'], ['retry', 'alert', 'red', 'Перезапустить'],
    ['retry', 'alert', 'red', 'Перезапустить'], ['retry', 'square', 'secondary', 'Перезапустить'],
    ['', 'running', 'blue', 'Недоступно'], ['pause', 'running', 'blue', 'Приостановить'], ['pause', 'clock', 'blue', 'Приостановить'],
    ['pause', 'clock', 'blue', 'Приостановить']
  ];
  for (let i = 0; i < expected.length; i++) {
    const [operation, icon, color, label] = expected[i], button = action(i);
    assert.equal(await button.getAttribute('data-action'), operation);
    assert.equal(await button.getAttribute('data-icon'), icon);
    assert.ok((await button.getAttribute('class')).includes(`text-${color}`));
    assert.equal((await button.getAttribute('title')).split(' · ')[1], label);
    assert.ok((await button.getAttribute('aria-label')).includes(queue.jobs[i].url));
    assert.equal(await button.isDisabled(), !operation);
    assert.equal(await button.innerText(), '', 'status/action has no visible text badge');
    assert.equal(await button.locator(icon === 'running' ? `.status-dot-animated.bg-${color}` : 'svg.icon').count(), 1);
    assert.equal(await button.evaluate(node => getComputedStyle(node).opacity), '1', 'disabled indicators retain full color');
    if ([2, 3, 5, 10, 11].includes(i)) {
      const title = await button.getAttribute('title');
      await button.locator('..').hover();
      await page.waitForFunction(text => [...document.querySelectorAll('.tooltip.show .tooltip-inner')].some(node => node.textContent === text), title);
      await page.mouse.move(0, 0);
    }
  }
  const qaRetry = page.locator(`[data-job-secondary-action="${queue.jobs[5].id}"]`);
  assert.equal(await qaRetry.count(), 0);
  const output = testOutput(); fs.mkdirSync(output, { recursive: true });
  for (let index = 0; index < statuses.length; index++) {
    if (statuses[index] === 'complete') continue;
    await select(index);
    assert.equal(await page.locator('#stage-step-2').getAttribute('aria-disabled'), 'true', `step 2 is locked for ${statuses[index]}`);
    await page.locator('#stage-step-2').evaluate(step => step.click());
    assert.equal(await page.locator('#stage-two-panel').isHidden(), true);
  }
  await select(5);
  assert.equal(await page.locator('#stage-step-1.step-state-error').count(), 1, 'needs_review colors step 1 red without a separate header badge');
  assert.equal(await page.locator('#stage-step-2').getAttribute('aria-disabled'), 'true');
  await page.locator('#stage-step-2').evaluate(step => step.click());
  assert.equal(await page.locator('#stage-two-panel').isHidden(), true, 'step 2 cannot open before step 1 is complete');
  await select(11); assert.equal(await page.locator('#stage-step-1.step-state-active').count(), 1, 'active QA colors step 1 gray');
  await page.locator(`[data-job-id="${queue.jobs[2].id}"]`).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[2].url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), 'Enter on a queue row selects its result');
  await page.locator(`[data-job-id="${queue.jobs[4].id}"]`).focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), 'Space on a queue row selects its result');
  await select(2);
  const initialDuration = await page.locator('#attempt-duration').innerText();
  await page.waitForFunction(value => document.querySelector('#attempt-duration').textContent !== value, initialDuration);
  assert.match(await page.locator('#attempt-duration').innerText(), /^\d{2}:\d{2}:\d{2}$/);
  const activeBackground = await page.locator('#stage-step-1').evaluate(node => getComputedStyle(node, '::before').backgroundColor);
  await select(7);
  const errorBackground = await page.locator('#stage-step-1').evaluate(node => getComputedStyle(node, '::before').backgroundColor);
  await select(4); assert.equal(await page.locator('#attempt-duration').innerText(), '00:00:05');
  const recapture = page.locator('#recapture-button');
  assert.equal(await recapture.innerText(), '', 'restart is an icon-only button');
  assert.equal(await recapture.getAttribute('aria-label'), 'Перезапустить');
  assert.equal(await recapture.getAttribute('title'), 'Перезапустить');
  assert.equal(await recapture.locator('svg.icon').count(), 1, 'restart uses one recognizable refresh icon');
  assert.equal(await recapture.locator('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(await recapture.locator('path').count(), 2);
  const recaptureBox = await recapture.evaluate(node => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height }; });
  assert.equal(recaptureBox.width, recaptureBox.height, 'restart icon button is square');
  assert.equal(await page.locator('#detail-status').count(), 0, 'attempt status is absent from the result header');
  assert.equal(await page.locator('#stage-step-1.step-state-success').count(), 1);
  assert.equal(await page.locator('#stage-step-2.step-state-active').getAttribute('aria-disabled'), 'false');
  assert.equal(await page.locator('#stage-step-2').getAttribute('aria-selected'), 'true', 'complete attempt opens the latest available step by default');
  assert.equal(await page.locator('#stage-two-panel').isVisible(), true);
  assert.equal(await recapture.isVisible(), true, 'restart remains visible on step 2');
  assert.equal(await page.locator('#qa-progress').evaluate(node => node.classList.contains('stage-hidden')), true, 'QA progress is hidden outside step 1');
  assert.deepEqual(await page.locator('.result-steps .step-item').allInnerTexts(), ['Скриншоты', 'HTML и медиа', 'Новая страница']);
  assert.equal(await page.title(), 'АРМ миграции страниц');
  assert.equal(await page.locator('.navbar-brand').innerText(), 'АРМ миграции страниц · Реестр 35');
  assert.deepEqual(await page.locator('.result-steps .step-item').evaluateAll(nodes => nodes.map(node => node.getAttribute('title'))), [null, null, null]);
  await page.mouse.move(0, 0); await page.locator('#stage-step-2').hover(); await page.waitForTimeout(100);
  assert.equal(await page.locator('.tooltip.show').count(), 0, 'steps do not create tooltips');
  assert.deepEqual(await page.locator('#results-card > *').evaluateAll(nodes => nodes.map(node => node.id)), ['results-header', 'attempt-header', 'gallery-body', 'stage-two-panel', 'stage-three-panel']);
  assert.equal(await page.locator('#results-header > #results-common').count(), 1);
  assert.deepEqual(await page.locator('#results-common > *').evaluateAll(nodes => nodes.map(node => node.id)), ['header-control-group', 'result-steps']);
  assert.deepEqual(await page.locator('#header-control-group > *').evaluateAll(nodes => nodes.map(node => node.id)), ['detail-url', 'attempt-controls']);
  assert.equal(await page.locator('#detail-title').count(), 0, 'the redundant result title is absent');
  assert.doesNotMatch(await page.locator('#results-header').innerText(), /Результаты страницы/);
  assert.equal(await page.locator('#detail-url').innerText(), 'icon-4.reestr35.ru', 'the URL control omits the scheme and trailing slash');
  assert.deepEqual(await page.locator('#detail-url').evaluate(node => ({ tag: node.tagName, href: node.getAttribute('href'), target: node.target, rel: node.rel, button: node.classList.contains('btn') })), { tag: 'A', href: queue.jobs[4].url, target: '_blank', rel: 'noopener noreferrer', button: true });
  assert.equal(await page.locator('#results-header #attempt-controls').count(), 1);
  assert.equal(await page.locator('#results-header #qa-progress').count(), 0);
  assert.equal(await page.locator('#attempt-header > #attempt-controls').count(), 0);
  assert.equal(await page.locator('#attempt-header > #qa-progress').count(), 1);
  assert.deepEqual(await page.locator('#attempt-header > *').evaluateAll(nodes => nodes.map(node => node.id)), ['qa-progress', 'media-progress', 'builder-progress'], 'the lower header contains only progress variants');
  assert.deepEqual(await page.locator('#qa-progress .progress, #media-progress .progress, #builder-progress .progress').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).height)), ['4px', '4px', '4px']);
  assert.equal(await page.locator('#attempt-header').evaluate(header => {
    const source = document.querySelector('#queue-progress > .progress').getBoundingClientRect(), parent = header.getBoundingClientRect(), style = getComputedStyle(header);
    const left = parent.left + parseFloat(style.paddingLeft), right = parent.right - parseFloat(style.paddingRight);
    const lastStep = document.querySelector('#stage-step-3'), range = document.createRange();
    range.selectNodeContents(lastStep);
    const lastLabel = range.getBoundingClientRect();
    return [...header.children].every(node => {
      const saved = node.className;
      node.className = 'qa-progress';
      const box = node.getBoundingClientRect(), track = node.querySelector('.progress').getBoundingClientRect();
      node.className = saved;
      return Math.abs(box.left - left) <= 1 && Math.abs(box.right - right) <= 1 && Math.abs(track.right - lastLabel.right) <= 1 && track.height === source.height && track.height === 4;
    });
  }), true, 'all three full-width result tracks match the task track height and the right edge of the last step');
  assert.equal(await page.locator('#attempt-controls > #recapture-button').count(), 1);
  assert.equal(await page.locator('#attempt-controls').evaluate(node => node.firstElementChild.id), 'attempt-duration', 'time precedes restart');
  assert.deepEqual(await page.locator('#attempt-controls > *').evaluateAll(nodes => nodes.map(node => node.id)), ['attempt-duration', 'recapture-button']);
  assert.equal(await page.locator('#results-header #attempt-select').count(), 0);
  assert.equal(await page.locator('#technical-area #attempt-select').isVisible(), true);
  const controlStyles = await page.locator('#attempt-duration, #attempt-select').evaluateAll(nodes => nodes.map(node => { const style = getComputedStyle(node); return { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, border: style.border, height: node.getBoundingClientRect().height }; }));
  assert.deepEqual(controlStyles[0], controlStyles[1], 'active time matches the attempt selector font, frame and height');
  const attemptControlBoxes = await page.locator('#attempt-controls > *').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
  const attemptControlGap = attemptControlBoxes[1].left - attemptControlBoxes[0].right;
  assert.ok(attemptControlGap > 0, 'restart appears to the right of time with a gap');
  const urlControlGeometry = await page.locator('#detail-url').evaluate(node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node), range = document.createRange();
    range.selectNodeContents(node);
    return { width: box.width, textWidth: range.getBoundingClientRect().width, paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight), borderLeft: parseFloat(style.borderLeftWidth), borderRight: parseFloat(style.borderRightWidth), right: box.right };
  });
  assert.ok(Math.abs(urlControlGeometry.paddingLeft - urlControlGeometry.paddingRight) <= .01, 'URL control has symmetric inline padding');
  assert.ok(Math.abs(urlControlGeometry.width - urlControlGeometry.textWidth - urlControlGeometry.paddingLeft - urlControlGeometry.paddingRight - urlControlGeometry.borderLeft - urlControlGeometry.borderRight) <= 1, 'short URL control uses only its content width and symmetric chrome');
  assert.ok(Math.abs(attemptControlBoxes[0].left - urlControlGeometry.right - attemptControlGap) <= .5, 'URL-to-time gap equals the time-to-restart gap');
  assert.equal(await page.locator('#results-card > #stage-two-panel').count(), 1, 'step 2 is an alternate body of the same card');
  const stepVisuals = await page.locator('.result-steps .step-item').evaluateAll(nodes => nodes.map(node => {
    const dot = getComputedStyle(node, '::before'), connector = getComputedStyle(node, '::after'), bounds = node.getBoundingClientRect(), range = document.createRange();
    range.selectNodeContents(node);
    const label = range.getBoundingClientRect();
    return { top: bounds.top, width: bounds.width, labelTop: label.top - bounds.top, dotTop: parseFloat(dot.top), dotHeight: parseFloat(dot.height), dotLeft: parseFloat(dot.left), markerLeft: bounds.left + parseFloat(dot.left), dotBackground: dot.backgroundColor, connectorContent: connector.content, connectorPosition: connector.position, connectorRight: parseFloat(connector.right), connectorTop: parseFloat(connector.top), connectorWidth: parseFloat(connector.width) || 0 };
  }));
  assert.ok(Math.max(...stepVisuals.map(step => step.top)) - Math.min(...stepVisuals.map(step => step.top)) <= 1, 'all steps stay on one horizontal line');
  for (const step of stepVisuals) {
    assert.ok(step.labelTop >= step.dotTop + step.dotHeight + 4, 'the step label is below its circle and connector line');
  }
  const markerGaps = stepVisuals.slice(1).map((step, index) => step.markerLeft - stepVisuals[index].markerLeft);
  assert.ok(markerGaps.every(gap => gap > 0), `desktop markers remain in visual order: ${markerGaps}`);
  assert.ok(Math.abs(markerGaps[0] - markerGaps[1]) <= 1, 'desktop marker centers are equally spaced');
  assert.equal(stepVisuals[0].connectorContent, 'none', 'step 1 has only its circle');
  for (const [index, step] of stepVisuals.slice(1).entries()) {
    assert.equal(step.connectorPosition, 'absolute');
    assert.ok(step.connectorRight >= 0, 'the connector stays inside the three-step track');
    assert.ok(Math.abs(step.connectorTop - (step.dotTop + step.dotHeight / 2)) <= 1, 'the connector and circles share one horizontal line');
    assert.ok(Math.abs(step.connectorWidth - markerGaps[index]) <= 1, 'each connector spans the actual distance between its circles');
  }
  assert.equal(stepVisuals[1].dotBackground, activeBackground, 'step 2 uses the same neutral gray as an active step 1');
  assert.equal(new Set([stepVisuals[0].dotBackground, stepVisuals[1].dotBackground, stepVisuals[2].dotBackground, errorBackground]).size, 4, 'steps use exactly distinct success, active, inactive and error colors');
  assert.equal(await page.locator('#stage-two-panel .html-source-card').innerText(), 'HTML не найден — выбрать файл');
  assert.equal(await page.locator('#stage-three-panel #page-builder-loading').textContent(), 'Загрузка страницы…');
  await page.screenshot({ path: path.join(output, 'ui-stage-two-1440.png'), fullPage: true });
  assert.equal(await page.locator('#gallery-body').isHidden(), true);
  const topGeometry = () => page.locator('#results-header, #result-steps, .result-steps .step-item').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return [node.id || node.className, box.x, box.y, box.width, box.height]; }));
  const stepTwoGeometry = await topGeometry();
  const headerGeometry = await page.locator('#detail-url, #attempt-controls, #result-steps').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; }));
  assert.ok(headerGeometry[0].right < headerGeometry[1].left && headerGeometry[1].right < headerGeometry[2].left, 'attempt controls are immediately right of the URL and steps are farther right');
  assert.equal(await page.locator('#result-steps').evaluate(node => { const box = node.getBoundingClientRect(), parent = node.parentElement.getBoundingClientRect(); return Math.abs(box.right - parent.right) <= 1 && box.width >= 400; }), true, 'desktop steps use the widened track up to the right header edge');
  assert.equal(await page.locator('#results-header').evaluate(node => getComputedStyle(node).borderBottomWidth), '0px', 'there is no divider between the main and attempt headers');
  await page.locator('#stage-step-1').click();
  assert.equal(await page.locator('#gallery-body').isVisible(), true);
  const alignment = await page.evaluate(() => {
    const steps = document.querySelector('#result-steps .steps').getBoundingClientRect(), items = [...document.querySelectorAll('.result-steps .step-item')];
    const markers = items.map(item => item.getBoundingClientRect().left + parseFloat(getComputedStyle(item, '::before').left));
    const lines = items.slice(1).map(item => { const bounds = item.getBoundingClientRect(), style = getComputedStyle(item, '::after'), right = bounds.right - parseFloat(style.right); return { left: right - parseFloat(style.width), right }; });
    const labels = items.map(item => { const range = document.createRange(); range.selectNodeContents(item); const box = range.getBoundingClientRect(); return { left: box.left, right: box.right, center: box.left + box.width / 2, bottom: box.bottom }; });
    const labelsBottom = Math.max(...labels.map(label => label.bottom));
    const progress = document.querySelector('#qa-progress-bar').getBoundingClientRect(), controls = document.querySelector('#attempt-controls').getBoundingClientRect();
    const header = document.querySelector('#results-common').getBoundingClientRect();
    const attemptHeaderNode = document.querySelector('#attempt-header'), attemptHeader = attemptHeaderNode.getBoundingClientRect(), attemptHeaderStyle = getComputedStyle(attemptHeaderNode);
    return { markers, lines, labels, header: { left: header.left, right: header.right }, attemptHeader: { left: attemptHeader.left, right: attemptHeader.right, paddingLeft: parseFloat(attemptHeaderStyle.paddingLeft), paddingRight: parseFloat(attemptHeaderStyle.paddingRight) }, progress: { left: progress.left, right: progress.right, width: progress.width, height: progress.height, top: progress.top }, controls: { bottom: controls.bottom }, rowGap: controls.top - labelsBottom, width: steps.width };
  });
  const labelClearance = alignment.header.right - alignment.labels.at(-1).right;
  assert.ok(Math.abs(labelClearance) <= 1, `last centered caption reaches the result header edge: ${labelClearance}`);
  assert.ok(Math.abs(alignment.lines.at(-1).right - alignment.markers.at(-1)) <= 1, 'connector line ends at the last marker');
  assert.ok(Math.abs(alignment.lines[0].left - alignment.markers[0]) <= 1, 'the first connector starts at the first marker');
  alignment.labels.forEach((label, index) => { assert.ok(Math.abs(label.center - alignment.markers[index]) <= 1, `caption ${index + 1} is centered under its marker`); assert.ok(label.left >= alignment.header.left && label.right <= alignment.header.right, `caption ${index + 1} stays inside the header`); });
  assert.ok(alignment.rowGap < 0, 'the controls and step labels share the upper header row');
  assert.ok(alignment.progress.top > alignment.controls.bottom, 'the progress bar has its own row below the attempt controls');
  const taskProgressHeight = await page.locator('#queue-progress > .progress').evaluate(node => node.getBoundingClientRect().height);
  assert.ok(Math.abs(alignment.labels.at(-1).right - alignment.progress.right) <= 1, 'the last caption and result progress share the same right edge');
  assert.equal(alignment.progress.height, taskProgressHeight, 'the result and task progress tracks have equal pixel heights');
  assert.equal(alignment.progress.height, 4, 'the full-width result progress bar uses the standard four-pixel compact track');
  fs.writeFileSync(path.join(output, 'ui-steps-alignment-1440.json'), JSON.stringify(alignment, null, 2));
  await page.screenshot({ path: path.join(output, 'ui-steps-wide-1440.png'), fullPage: true });
  assert.equal(await page.locator('#stage-two-panel').isHidden(), true);
  assert.equal(await page.locator('#stage-step-1.step-state-success').count(), 1, 'manual selection does not erase completed step success');
  assert.equal(await page.locator('#recapture-button').isVisible(), true);
  const centers = await page.locator('#attempt-controls > *').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return rect.y + rect.height / 2; }));
  assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, 'attempt controls are vertically centered');
  assert.deepEqual(await topGeometry(), stepTwoGeometry, 'common header and step geometry remain stable between step bodies');
  await page.waitForResponse(response => response.url() === `${base}/api/state`);
  assert.equal(await page.locator('#stage-step-1').getAttribute('aria-selected'), 'true', 'polling preserves a manual stage choice');
  await page.locator('#stage-step-1').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#stage-step-2').getAttribute('aria-selected'), 'true', 'arrow keys activate the next available tab');
  assert.equal(await page.locator('#stage-step-2').evaluate(node => document.activeElement === node), true);
  assert.equal(await recapture.isVisible(), true, 'keyboard navigation keeps restart visible on step 2');
  await page.locator('#detail-url').evaluate(node => { node.textContent = 'very-long-company-name.reestr35.ru/catalog/section/company-page-with-a-long-address'; });
  const measureProgressAlignment = () => page.evaluate(() => {
    const source = document.querySelector('#queue-progress > .progress').getBoundingClientRect(), header = document.querySelector('#attempt-header'), headerBox = header.getBoundingClientRect(), headerStyle = getComputedStyle(header);
    const headerInner = { left: headerBox.left + parseFloat(headerStyle.paddingLeft), right: headerBox.right - parseFloat(headerStyle.paddingRight) };
    const lastStep = document.querySelector('#stage-step-3'), lastStepBox = lastStep.getBoundingClientRect(), range = document.createRange();
    range.selectNodeContents(lastStep);
    const lastLabel = range.getBoundingClientRect(), marker = lastStepBox.left + parseFloat(getComputedStyle(lastStep, '::before').left);
    const resultTracks = ['qa-progress', 'media-progress', 'builder-progress'].map(id => {
      const wrapper = document.getElementById(id), saved = wrapper.className;
      wrapper.className = 'qa-progress';
      const track = wrapper.querySelector('.progress').getBoundingClientRect();
      wrapper.className = saved;
      return { width: track.width, right: track.right, height: track.height };
    });
    return { source: { height: source.height }, headerInner, lastStepRight: lastStepBox.right, lastLabel: { left: lastLabel.left, right: lastLabel.right, center: lastLabel.left + lastLabel.width / 2 }, marker, resultTracks };
  });
  for (const viewportWidth of [1440, 1200, 1024, 768, 390, 375, 360, 320]) {
    await page.setViewportSize({ width: viewportWidth, height: 844 });
    await page.waitForFunction(() => { const range = document.createRange(), last = document.querySelector('#stage-step-3'), box = last.getBoundingClientRect(); range.selectNodeContents(last); const label = range.getBoundingClientRect(); return Math.abs(box.right - label.right) <= 1 && Math.abs(box.left + parseFloat(getComputedStyle(last, '::before').left) - label.left - label.width / 2) <= 1; });
    const responsiveHeader = await page.locator('#detail-url, #attempt-controls, #result-steps').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; }));
    if (viewportWidth >= 1400) assert.ok(responsiveHeader[0].right < responsiveHeader[1].left && responsiveHeader[1].right < responsiveHeader[2].left, `${viewportWidth}px keeps URL, controls and steps in order on one row`);
    else if (viewportWidth >= 768) assert.ok(responsiveHeader[0].right < responsiveHeader[1].left && responsiveHeader[1].bottom < responsiveHeader[2].top, `${viewportWidth}px keeps controls right of URL and moves steps to a compact second row`);
    else assert.ok(responsiveHeader[0].bottom < responsiveHeader[1].top && responsiveHeader[1].bottom < responsiveHeader[2].top, `${viewportWidth}px stacks URL, controls and steps in order`);
    assert.equal(await page.locator('#detail-url').innerText(), 'very-long-company-name.reestr35.ru/catalog/section/company-page-with-a-long-address', `${viewportWidth}px preserves the long visible address`);
    const mobileSteps = await page.locator('.result-steps').evaluate(node => {
      const steps = [...node.querySelectorAll('.step-item')], textRects = steps.map(step => {
        const range = document.createRange();
        range.selectNodeContents(step);
        return [...range.getClientRects()];
      });
      return {
        trackWidth: node.getBoundingClientRect().width,
        widths: steps.map(step => step.getBoundingClientRect().width),
        textLines: textRects.map(rects => new Set(rects.map(rect => Math.round(rect.top * 10))).size),
        tops: steps.map(step => step.getBoundingClientRect().top),
        connectorWidths: steps.slice(1).map(step => parseFloat(getComputedStyle(step, '::after').width)),
        markers: steps.map(step => step.getBoundingClientRect().left + parseFloat(getComputedStyle(step, '::before').left)),
        labelCenters: steps.map(step => { const label = step.querySelector('.step-label').getBoundingClientRect(); return label.left + label.width / 2; }),
        labelsFit: textRects.every((rects, index) => {
          const bounds = steps[index].getBoundingClientRect();
          return rects.every(rect => rect.left >= bounds.left - .5 && rect.right <= bounds.right + .5);
        })
      };
    });
    assert.ok(Math.max(...mobileSteps.tops) - Math.min(...mobileSteps.tops) <= 1, `${viewportWidth}px keeps the steps on one horizontal line`);
    assert.ok(Math.max(...mobileSteps.widths) - Math.min(...mobileSteps.widths) <= .5, `${viewportWidth}px keeps all three step cells equal within subpixel tolerance`);
    if (viewportWidth === 320) assert.ok(mobileSteps.textLines.some(lines => lines > 1), `${viewportWidth}px wraps a long label below the marker line when the widened track reaches the available width`);
    assert.equal(mobileSteps.labelsFit, true, `${viewportWidth}px keeps labels inside their cells`);
    assert.ok(Math.max(...mobileSteps.connectorWidths) < mobileSteps.trackWidth, `${viewportWidth}px keeps every connector inside the widened step track`);
    const distances = mobileSteps.markers.slice(1).map((marker, index) => marker - mobileSteps.markers[index]);
    assert.ok(Math.abs(distances[0] - distances[1]) <= 1, `${viewportWidth}px has equal marker-center distances: ${distances}`);
    mobileSteps.labelCenters.forEach((center, index) => assert.ok(Math.abs(center - mobileSteps.markers[index]) <= 1, `${viewportWidth}px caption ${index + 1} is centered under its marker`));
    mobileSteps.connectorWidths.forEach((width, index) => assert.ok(Math.abs(width - distances[index]) <= 1, `${viewportWidth}px connector ${index + 1} reaches adjacent markers`));
    const progressAlignment = await measureProgressAlignment();
    for (const [index, track] of progressAlignment.resultTracks.entries()) {
      assert.equal(track.height, progressAlignment.source.height, `${viewportWidth}px stage ${index + 1} progress matches the task track height`);
      assert.ok(Math.abs(track.width - (progressAlignment.headerInner.right - progressAlignment.headerInner.left)) <= 1, `${viewportWidth}px stage ${index + 1} progress fills its header`);
      assert.ok(Math.abs(track.right - progressAlignment.lastLabel.right) <= 1, `${viewportWidth}px stage ${index + 1} progress aligns with the last caption`);
      assert.equal(track.height, 4, `${viewportWidth}px stage ${index + 1} progress stays four pixels thick`);
    }
    assert.ok(Math.abs(progressAlignment.lastStepRight - progressAlignment.lastLabel.right) <= 1, `${viewportWidth}px the last step and its caption share the right edge`);
    assert.ok(Math.abs(progressAlignment.marker - progressAlignment.lastLabel.center) <= 1, `${viewportWidth}px the last caption remains centered under its marker`);
    if (viewportWidth === 320) {
      const lastStepLines = await page.locator('#stage-step-3').evaluate(node => {
        const marker = node.getBoundingClientRect().left + parseFloat(getComputedStyle(node, '::before').left), range = document.createRange();
        range.selectNodeContents(node.querySelector('.step-label'));
        return { marker, centers: [...range.getClientRects()].map(rect => rect.left + rect.width / 2) };
      });
      assert.ok(lastStepLines.centers.length > 1, '320px wraps the last caption into multiple lines');
      lastStepLines.centers.forEach((center, index) => assert.ok(Math.abs(center - lastStepLines.marker) <= 1, `320px last-caption line ${index + 1} stays centered under its marker`));
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${viewportWidth}px has no page overflow`);
    if ([1440, 1024, 390, 320].includes(viewportWidth)) await page.screenshot({ path: path.join(output, `ui-stage-two-${viewportWidth}.png`), fullPage: true });
  }
  await page.locator('#detail-url').evaluate(node => { node.textContent = 'icon-4.reestr35.ru'; });
  const sourceCardWidth = await page.locator('#stage-two-panel .html-source-card').evaluate(node => ({ source: node.getBoundingClientRect().width, card: node.closest('.card').getBoundingClientRect().width }));
  assert.ok(sourceCardWidth.source <= sourceCardWidth.card);
  await page.locator('#stage-step-1').click(); await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.locator('#attempt-duration').innerText(), '00:00:05');
  await action(5).click();
  await waitStatus(5, 'queued');
  assert.ok(requests.includes(`/api/jobs/${queue.jobs[5].id}/retry`));
  assert.equal(queue.jobs[5].attempts.length, 2, 'restart creates a new attempt');
  assert.equal(queue.jobs[5].attempts[0].status, 'needs_review', 'history is preserved');
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), 'restart does not select its row');
  await page.screenshot({ path: path.join(output, 'ui-queue-actions-1440.png'), fullPage: true });
  await action(0).click(); await waitStatus(0, 'queued');
  assert.equal(queue.jobs[0].attempts.length, 1);
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), 'resume does not select its row');
  await action(1).click(); await waitStatus(1, 'paused');
  const order = queue.jobs[1].attempts[0].queueOrder;
  await action(1).focus(); await page.keyboard.press('Enter'); await waitStatus(1, 'queued');
  assert.ok(queue.jobs[1].attempts[0].queueOrder > order);
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), 'keyboard action does not select its row');
  for (const i of [3, 10]) { const count = requests.length; await action(i).evaluate(button => button.click()); assert.equal(requests.length, count); }
  await action(13).click(); await waitStatus(13, 'paused');
  assert.ok(requests.includes(`/api/jobs/${queue.jobs[13].id}/pause`));
  assert.equal(queue.jobs[13].attempts.length, 1, 'pausing queued QA keeps the current capture attempt');
  await action(2).click(); await waitStatus(2, 'pausing'); assert.equal(await action(2).isDisabled(), true);
  children[0].finish(); await waitStatus(2, 'interrupted');
  await action(11).click(); await waitStatus(11, 'pausing'); assert.equal(await action(11).isDisabled(), true);
  children[1].finish(); await waitStatus(11, 'interrupted');
  for (const i of [4, 6, 7, 8, 9]) {
    const oldStatus = queue.jobs[i].attempts[0].status;
    await select(i);
    if (i === 4) assert.equal(await page.locator('#stage-step-2').getAttribute('aria-selected'), 'true', 'complete attempt exposes restart on step 2');
    await ([4, 9].includes(i) ? page.locator('#recapture-button') : action(i)).click(); await waitStatus(i, 'queued');
    assert.equal(queue.jobs[i].attempts.length, 2);
    assert.equal(queue.jobs[i].attempts[0].status, oldStatus, 'terminal and legacy attempts remain history');
    assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[i].url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''));
  }
  await select(4);
  assert.equal(await page.locator('#attempt-select').inputValue(), '2', 'recapture updates the selected job to its new attempt');
  assert.equal(await page.locator('#stage-step-1').getAttribute('aria-selected'), 'true', 'retry resets the new attempt to step 1');
  await page.selectOption('#attempt-select', '1');
  assert.equal(await page.locator('#stage-step-1.step-state-success').count(), 1);
  assert.equal(await page.locator('#stage-step-2').getAttribute('aria-selected'), 'true', 'changing to a complete attempt defaults to step 2');
  assert.equal(await page.locator('#attempt-duration').innerText(), '00:00:05');
  await page.route(`**/api/jobs/${queue.jobs[12].id}/pause`, async route => { queue.launch(queue.jobs[12]); await route.continue(); });
  await action(12).click();
  await waitStatus(12, 'pausing');
  assert.equal(await action(12).evaluate(node => node.classList.contains('btn-loading')), false);
  assert.equal(await action(12).isEnabled(), false, 'running pause stays disabled while checkpoint is pending');
  assert.equal(queue.jobs[12].attempts[0].status, 'pausing');
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''));
  assert.equal(await page.locator('#results-column [data-job-action], #refresh-logs, #detail-actions').count(), 0);
  queue.jobs[0].url = null;
  queue.save();
  await page.waitForFunction(id => document.querySelector(`[data-job-id="${id}"] td:first-child`)?.textContent.trim() === '—', queue.jobs[0].id);
  await select(0);
  assert.equal(await page.locator('#detail-url').innerText(), '—', 'missing URL renders a safe placeholder');
  for (const attribute of ['href', 'target', 'rel']) assert.equal(await page.locator('#detail-url').getAttribute(attribute), null, `missing URL omits ${attribute}`);
});

test('technical area follows steps and attempts, preserves modern capture evidence and media outcomes', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-technical-ui-'));
  const queue = new Queue({ root, autoStart: false, spawnFn() { throw new Error('UI fixture must not spawn'); } });
  queue.add('https://technical.reestr35.ru/');
  const job = queue.jobs[0], oldAttempt = job.attempts[0];
  Object.assign(oldAttempt, { status: 'needs_review', phase: 'qa', summary: 'Сводка прежней попытки', issues: ['Старое замечание'] });
  const attempt = queue.newAttempt(job);
  const manifest = queue.stage.media.create(job, attempt, Buffer.from('<p>Источник</p>'), 'uploaded');
  manifest.status = 'ready_with_issues';
  manifest.resources = ['downloaded', 'external', 'failed', 'unsupported'].map((status, index) => ({ id: index + 1, status, originalUrl: `https://example.org/resource-${index}`, resolvedUrl: `https://example.org/resource-${index}`, mime: 'text/plain', object: 'objects/fixture', bytes: 10, error: status === 'failed' ? 'Ошибка fixture' : undefined }));
  queue.stage.media.publish(job, attempt, manifest);
  Object.assign(attempt, {
    status: 'complete', phase: 'html-media', captureStatus: 'complete', workflow: 1,
    finishedAt: '2026-09-18T12:00:00Z', exitCode: 17,
    captureSummary: { status: 'complete', finished: '2026-09-18T10:00:00Z', pngCount: 3, segments: 3, issues: [] },
    qa: { total: 3, reviewed: 3, passed: 3, issues: 0, unreviewed: 0 }, issues: []
  });
  delete attempt.summary;
  queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-job-id]').click();
  assert.equal(await page.locator('#stage-three-panel').isVisible(), true);
  assert.equal(await page.locator('#technical-area').isVisible(), true);
  assert.equal(await page.locator('#attempt-select').isVisible(), true);
  assert.equal(await page.locator('#technical-area .card:visible').count(), 1, 'step 3 shows only the shared attempt selector');
  for (const id of ['metadata-panel', 'summary-panel', 'logs-card', 'media-source-panel', 'media-outcome-panel']) assert.equal(await page.locator(`#${id}`).isHidden(), true);
  assert.equal(await page.locator('#results-header #attempt-select').count(), 0);
  assert.deepEqual(await page.locator('#attempt-controls > *').evaluateAll(nodes => nodes.map(node => node.id)), ['attempt-duration', 'recapture-button']);

  await page.locator('#stage-step-1').click();
  assert.equal(await page.locator('#technical-area #attempt-select').isVisible(), true);
  assert.equal(await page.locator('#technical-area > .row > div:not([id]) #attempt-select').count(), 1, 'attempt selection has a shared standalone card');
  const attemptSelector = await page.locator('#attempt-select').elementHandle();
  for (const id of ['metadata-panel', 'summary-panel', 'logs-card']) assert.equal(await page.locator(`#${id}`).isVisible(), true);
  assert.equal(await page.locator('#technical-area details').count(), 0, 'technical information has no collapsed sections');
  let summary = JSON.parse(await page.locator('#summary-output').innerText());
  assert.equal(summary['Итог скриншотов и QA'], 'Готово');
  assert.equal(summary['Съёмка'].pngCount, 3);
  assert.equal(summary['Съёмка'].finished, '2026-09-18T10:00:00Z', 'capture finish is independent of the later process finish');
  assert.equal(summary['Проверка PNG']['Принято'], 3);
  assert.match(await page.locator('#attempt-meta').innerText(), /Код выхода в данных попытки\s+17/);
  assert.match(await page.locator('#attempt-meta').innerText(), /Завершение в данных попытки/);
  assert.doesNotMatch(await page.locator('#attempt-meta').innerText(), /последнего процесса/);
  assert.doesNotMatch(await page.locator('#technical-area').innerText(), /только к этой попытке|выбранной попытки|могут сохраняться от предыдущей фазы/);
  attempt.qa = { total: 3, reviewed: 3, passed: 2, issues: 1, unreviewed: 0 };
  attempt.issues = ['Замечание QA']; queue.save();
  await page.waitForFunction(() => document.querySelector('#summary-output').textContent.includes('Завершено с замечаниями'));
  assert.match(await page.locator('#issues-output').innerText(), /Замечание QA/);
  summary = JSON.parse(await page.locator('#summary-output').innerText());
  assert.equal(summary['Проверка PNG']['С замечаниями'], 1);
  attempt.captureStatus = 'incomplete'; queue.save();
  await page.waitForFunction(() => document.querySelector('#summary-output').textContent.includes('Неполный результат'));
  attempt.captureStatus = 'complete'; queue.save();
  await page.waitForFunction(() => document.querySelector('#stage-step-2').getAttribute('aria-disabled') === 'false');

  await page.locator('#stage-step-2').click();
  assert.equal(await page.locator('#technical-area #attempt-select').isVisible(), true);
  assert.equal(await page.locator('#technical-area > .row > div:not([id]) #attempt-select').isVisible(), true);
  assert.equal(await page.locator('#attempt-select').count(), 1);
  assert.equal(await attemptSelector.evaluate(node => node === document.querySelector('#attempt-select')), true, 'steps share one selector node');
  for (const id of ['metadata-panel', 'summary-panel', 'logs-card']) assert.equal(await page.locator(`#${id}`).isHidden(), true);
  assert.equal(await page.locator('#media-source-panel').isVisible(), true);
  assert.equal(await page.locator('#media-outcome-status').innerText(), 'Завершено с замечаниями');
  const source = await page.locator('#media-source-meta').innerText();
  assert.match(source, /uploaded/); assert.match(source, new RegExp(manifest.source.sha256));
  assert.match(source, new RegExp(`Размер, байт\\s+${manifest.source.bytes}`));
  assert.match(await page.locator('#media-outcome-meta').innerText(), /Обработано \/ всего\s+4 \/ 4\s+Скачано\s+1\s+Внешние\s+1\s+Требуют внимания\s+2/);
  assert.doesNotMatch(await page.locator('#technical-area').innerText(), /resource-2|Ошибка fixture/, 'resource details remain in the existing accordion');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `technical information fits at ${width}px`);
  }
  manifest.status = 'paused'; manifest.resources[0].status = 'pending'; queue.stage.media.publish(job, attempt, manifest);
  attempt.status = 'paused'; queue.save();
  await page.waitForFunction(() => document.querySelector('#media-outcome-status').textContent === 'На паузе');
  assert.match(await page.locator('#media-outcome-meta').innerText(), /Обработано \/ всего\s+3 \/ 4/);
  assert.equal(await page.locator('#stage-step-2').getAttribute('aria-selected'), 'true', 'polling preserves manually selected step');
  await page.selectOption('#attempt-select', '1');
  assert.equal(await page.locator('#stage-step-1').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#technical-area #attempt-select').isVisible(), true);
  assert.match(await page.locator('#summary-output').innerText(), /Сводка прежней попытки/);
  await page.selectOption('#attempt-select', '2');
  assert.equal(await page.locator('#stage-step-2').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#technical-area #attempt-select').isVisible(), true);
  manifest.status = 'ready_with_issues'; manifest.resources[0].status = 'downloaded'; queue.stage.media.publish(job, attempt, manifest);
  attempt.status = 'complete'; queue.save();
  await page.waitForFunction(() => document.querySelector('#stage-step-3').getAttribute('aria-selected') === 'true');
  assert.equal(await page.locator('#technical-area .card:visible').count(), 1);
  assert.equal(await page.locator('#attempt-select').isVisible(), true);
  await page.selectOption('#attempt-select', '1');
  assert.equal(await page.locator('#stage-step-1').getAttribute('aria-selected'), 'true', 'step 3 selector switches to an earlier attempt');
  await page.selectOption('#attempt-select', '2');
  assert.equal(await page.locator('#stage-step-3').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#technical-area .card:visible').count(), 1);
  assert.deepEqual(errors, []);
});

test('new empty page can add and delete its only tab at 320px', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-empty-tabs-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://new-page.reestr35.ru/');
  const job = queue.jobs[0]; Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } }), errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/page-builder/${job.id}`) posts.push(response.status()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  assert.deepEqual(queue.pageBuilder.read(job.id).document.tabs, []);
  assert.equal(queue.pageBuilder.read(job.id).document.source.hostname, 'new-page.reestr35.ru');
  const emptyAdd = page.getByRole('button', { name: 'Добавить вкладку' });
  assert.equal(await emptyAdd.getAttribute('title'), 'Добавить вкладку');
  assert.equal(await emptyAdd.innerText(), '+');
  assert.equal(await emptyAdd.evaluate(node => { const box = node.getBoundingClientRect(), section = node.closest('.builder-tabs-section').getBoundingClientRect(); return box.width >= section.width - 2 && box.right <= innerWidth && box.height >= 55; }), true);
  await emptyAdd.focus(); await page.keyboard.press('Enter'); await page.waitForSelector('#page-builder-modal.show');
  await page.locator('#builder-title').fill('Новая вкладка'); await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  await page.waitForSelector('.builder-tab');
  const compactAdd = page.locator('.builder-tab-add');
  assert.equal(await compactAdd.evaluate(node => getComputedStyle(node).color), 'rgb(0, 0, 0)');
  await compactAdd.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.builder-tab-add')).color !== 'rgb(0, 0, 0)');
  for (const name of ['Перетащить вкладку: Новая вкладка', 'Действия вкладки: Новая вкладка']) {
    const control = page.getByRole('button', { name });
    assert.equal(await control.evaluate(node => getComputedStyle(node).borderWidth), '0px');
    await control.hover();
    await page.waitForFunction(label => { const node = [...document.querySelectorAll('.builder-tab-handle, .builder-tab-menu-button')].find(node => node.getAttribute('aria-label') === label); return node && getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)'; }, name);
  }
  await page.getByRole('button', { name: 'Действия вкладки: Новая вкладка' }).click(); await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.builder-tab-empty-add') && !document.querySelector('.builder-tab'));
  assert.deepEqual(queue.pageBuilder.read(job.id).document.tabs, []);
  assert.deepEqual(posts, [200, 200]); assert.equal(await page.locator('#page-builder-error').isVisible(), false); assert.deepEqual(errors, []);
});

test('step 3 attempt switching isolates equal revisions, media, progress and pending drafts', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-attempt-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  const job = queue.jobs[0]; seedMoriPage(queue, job);
  const complete = { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } };
  Object.assign(job.attempts[0], structuredClone(complete)); queue.retry(job.id); Object.assign(job.attempts[1], structuredClone(complete)); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  assert.equal(await page.locator('#attempt-select').inputValue(), '2');
  assert.equal(await page.locator('.builder-block-open').count(), 0); assert.equal(await page.locator('#builder-progress-count').innerText(), '0/0');
  await page.locator('#attempt-select').selectOption('1');
  await page.waitForFunction(() => document.querySelector('#builder-progress-count').textContent === '4/10');
  assert.ok(await page.locator('.builder-block-open').count() > 0);
  assert.match(await page.locator('.builder-block img').first().getAttribute('src'), /attempt=1/);
  await page.locator('.builder-block-open').first().click(); await page.locator('#builder-title').fill('Не переносить в новую попытку');
  // Exercise a context update while an editor owns a draft, as with polling/retry.
  await page.evaluate(async () => {
    const snapshot = await (await fetch('/api/state')).json(), job = snapshot.jobs[0];
    await window.PageBuilder.render(job, { attempt: job.attempts[1], api: async (url, options = {}) => { const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', 'x-csrf-token': snapshot.csrfToken } }); const value = await response.json(); if (!response.ok) throw new Error(value.error); return value; } });
  });
  assert.equal(await page.locator('#page-builder-content').evaluate(node => node.classList.contains('d-none')), true);
  await page.locator('#page-builder-save').click(); assert.match(await page.locator('#page-builder-form-error').innerText(), /Страница обновилась/);
  await page.keyboard.press('Escape'); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  await page.locator('#attempt-select').selectOption('2'); await page.waitForSelector('#page-builder-content:not(.d-none)');
  assert.equal(await page.locator('.builder-block-open').count(), 0);
  await page.locator('[data-add-section="common"]').click(); await page.locator('#builder-title').fill('Блок второй попытки'); await page.locator('#page-builder-save').click();
  await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.builder-block-open[aria-label^="Блок второй попытки"]');
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('.builder-block-open[aria-label^="Блок второй попытки"]');
  await page.locator('#attempt-select').selectOption('1'); await page.waitForFunction(() => document.querySelector('#builder-progress-count').textContent === '4/10');
  assert.equal(await page.locator('.builder-block-open[aria-label^="Блок второй попытки"]').count(), 0);
  assert.equal(queue.pageBuilder.read(job.id, { attempt: 1 }).revision, 1); assert.equal(queue.pageBuilder.read(job.id, { attempt: 2 }).revision, 2);
  assert.deepEqual(errors, []);
});

test('step 3 tab controls create, rename, reorder and delete tabs without breaking block drag or ARIA panels', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-tabs-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  seedMoriPage(queue, queue.jobs[0]);
  const job = queue.jobs[0]; Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const close = async () => { await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); };
  await page.getByRole('button', { name: 'Добавить вкладку' }).click();
  await page.locator('#builder-title').fill('Новая вкладка'); await page.locator('#page-builder-save').click(); await close();
  const tabId = queue.pageBuilder.read(job.id).document.tabs.at(-1).id;
  await page.waitForSelector(`#builder-tab-${tabId}`);
  assert.equal(await page.locator(`#builder-tab-${tabId}`).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator(`#builder-tab-${tabId}`).getAttribute('aria-controls'), `builder-panel-${tabId}`);
  assert.equal(await page.locator(`#builder-panel-${tabId}`).getAttribute('aria-labelledby'), `builder-tab-${tabId}`);
  await page.getByRole('button', { name: 'Действия вкладки: Новая вкладка' }).click();
  await page.getByRole('button', { name: 'Переименовать' }).click(); await page.locator('#builder-title').fill('Добавленная'); await page.locator('#page-builder-save').click(); await close();
  await page.waitForFunction(id => document.getElementById(`builder-tab-${id}`)?.textContent.includes('Добавленная'), tabId);
  assert.equal(queue.pageBuilder.read(job.id).document.tabs.at(-1).title, 'Добавленная');
  const menuButton = page.getByRole('button', { name: 'Действия вкладки: Добавленная' });
  for (const actionName of ['Переименовать', 'Удалить']) {
    await menuButton.click(); const action = page.getByRole('button', { name: actionName, exact: true }); await action.focus(); const oldAction = await action.elementHandle();
    const current = queue.pageBuilder.read(job.id), external = structuredClone(current.document); external.common.title = `Внешнее обновление ${actionName}`;
    queue.pageBuilder.write(job.id, current.revision, external);
    await page.waitForFunction(node => !node.isConnected, oldAction);
    assert.equal(await action.evaluate(node => node === document.activeElement), true, `poll keeps focus on «${actionName}»`);
    assert.equal(await menuButton.getAttribute('aria-expanded'), 'true');
    assert.equal(await menuButton.evaluate(node => Boolean(document.getElementById(node.getAttribute('aria-controls')))), true);
    await page.keyboard.press('Escape'); assert.equal(await menuButton.evaluate(node => node === document.activeElement), true);
  }
  const pattern = `**/api/page-builder/${job.id}?attempt=*`;
  const conflict = async route => {
    if (route.request().method() === 'POST') {
      const current = queue.pageBuilder.read(job.id), external = structuredClone(current.document); external.tabs[0].title = 'Акции обновлены извне';
      queue.pageBuilder.write(job.id, current.revision, external);
    }
    await route.continue();
  };
  await page.route(pattern, conflict);
  const rejected = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/page-builder/${job.id}`);
  await page.getByRole('button', { name: 'Перетащить вкладку: Добавленная' }).focus(); await page.keyboard.press('ArrowLeft');
  assert.equal((await rejected).status(), 409); await page.waitForFunction(() => !document.querySelector('#page-builder-content').hasAttribute('aria-busy') && document.querySelector('#page-builder-error').textContent.includes('уже изменены'));
  await page.unroute(pattern, conflict);
  assert.equal(queue.pageBuilder.read(job.id).document.tabs.at(-1).id, tabId, 'stale reorder never reaches disk');
  assert.equal(await page.evaluate(id => document.activeElement?.dataset.tabId === id, tabId), true, 'conflict returns focus to the tab');
  await page.getByRole('button', { name: 'Перетащить вкладку: Добавленная' }).focus(); await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(id => [...document.querySelectorAll('.builder-tab')].at(-2)?.dataset.tabId === id, tabId);
  assert.equal(queue.pageBuilder.read(job.id).document.tabs.at(-2).id, tabId);
  await page.getByRole('button', { name: 'Перетащить вкладку: Добавленная' }).dragTo(page.locator('.builder-tab-item').first(), { targetPosition: { x: 4, y: 15 } });
  await page.waitForFunction(id => document.querySelector('.builder-tab')?.dataset.tabId === id, tabId);
  assert.equal(queue.pageBuilder.read(job.id).document.tabs[0].id, tabId);
  await page.getByRole('button', { name: 'Перетащить блок: MORI CINEMA', exact: true }).dragTo(page.locator(`#builder-tab-${tabId}`));
  await page.waitForFunction(id => document.querySelector(`#builder-panel-${id}`)?.querySelector('[data-builder-id="common-hero"]'), tabId);
  assert.equal(queue.pageBuilder.read(job.id).document.tabs[0].blocks.some(block => block.id === 'common-hero'), true);
  await page.getByRole('button', { name: 'Действия вкладки: Добавленная' }).click(); await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).document.tabs[0].id, tabId, 'cancel preserves the tab and its blocks');
  await page.getByRole('button', { name: 'Действия вкладки: Добавленная' }).click(); await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  assert.match(await page.locator('#page-builder-fields').innerText(), /1 блок/);
  await page.locator('#page-builder-save').click(); await close(); await page.waitForFunction(id => !document.getElementById(`builder-tab-${id}`), tabId);
  assert.equal(queue.pageBuilder.read(job.id).document.tabs.some(tab => tab.id === tabId), false);
  for (const tab of [...queue.pageBuilder.read(job.id).document.tabs]) {
    await page.getByRole('button', { name: `Действия вкладки: ${tab.title}` }).click(); await page.getByRole('button', { name: 'Удалить', exact: true }).click();
    await page.locator('#page-builder-save').click(); await close(); await page.waitForFunction(id => !document.getElementById(`builder-tab-${id}`), tab.id);
  }
  assert.equal(await page.locator('.builder-tab').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Добавить вкладку' }).isEnabled(), true);
  assert.equal(await page.locator('.builder-tab-empty-add').count(), 1);
  assert.equal(await page.locator('.builder-tab-empty-add').getAttribute('title'), 'Добавить вкладку');
  assert.equal(await page.locator('.builder-tab-empty-add').innerText(), '+');
  assert.deepEqual(queue.pageBuilder.read(job.id).document.tabs, []);
  await page.getByRole('button', { name: 'Добавить вкладку' }).click(); await page.locator('#builder-title').fill('После удаления'); await page.locator('#page-builder-save').click(); await close();
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  assert.deepEqual(await page.locator('.builder-tab').allInnerTexts(), ['После удаления']);
  await page.getByRole('button', { name: 'Действия вкладки: После удаления' }).click();
  const oldRename = await page.getByRole('button', { name: 'Переименовать', exact: true }).elementHandle();
  const current = queue.pageBuilder.read(job.id), external = structuredClone(current.document); external.tabs = []; queue.pageBuilder.write(job.id, current.revision, external);
  await page.waitForFunction(node => !node.isConnected, oldRename);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.tabAdd), 'true', 'external deletion of the open menu tab focuses the add button');
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.locator('.builder-tab-empty-add').evaluate(node => { const box = node.getBoundingClientRect(), section = node.closest('.builder-tabs-section').getBoundingClientRect(); return box.left >= section.left && box.right <= section.right && box.right <= innerWidth && box.width >= section.width - 2 && box.height >= 55; }), true);
  await page.getByRole('button', { name: 'Добавить вкладку' }).focus(); await page.keyboard.press('Enter');
  await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('#page-builder-modal').isVisible(), true, 'empty add area works from the keyboard');
  assert.deepEqual(errors, []);
});

test('step 3 template edits, review statuses, cancel rollback and responsive modal are local and durable', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  seedMoriPage(queue, queue.jobs[0]);
  const job = queue.jobs[0], attempt = job.attempts[0]; Object.assign(attempt, { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), external = [], errors = [], builderPosts = [];
  page.on('request', request => { if (!request.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) external.push(request.url()); if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/page-builder/${job.id}`) builderPosts.push(request); }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click();
  await page.waitForSelector('#page-builder-content:not(.d-none)'); assert.equal(await page.locator('#stage-step-3').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#stage-step-4, #stage-four-panel').count(), 0, 'step 4 is absent from UI and bodies');
  assert.equal(await page.locator('#stage-step-3.step-state-review-failed').count(), 1, 'failed visual review has its own yellow step state');
  assert.equal(await page.locator('#attempt-header > #builder-progress').count(), 1, 'step 3 progress lives in the attempt header');
  assert.equal(await page.locator('#builder-progress').evaluate(node => !node.classList.contains('stage-hidden')), true);
  assert.equal(await page.locator('#builder-progress-bar').evaluate(node => getComputedStyle(node).height), '4px');
  assert.equal(await page.locator('#builder-progress').evaluate(node => { const box = node.getBoundingClientRect(), source = document.querySelector('#queue-progress > .progress').getBoundingClientRect(), lastStep = document.querySelector('#stage-step-3').getBoundingClientRect(), parent = node.parentElement.getBoundingClientRect(), style = getComputedStyle(node.parentElement); return box.height > 0 && Math.abs(box.left - parent.left - parseFloat(style.paddingLeft)) <= 1 && Math.abs(parent.right - box.right - parseFloat(style.paddingRight)) <= 1 && node.querySelector('.progress').getBoundingClientRect().height === source.height && Math.abs(box.right - lastStep.right) <= 1; }), true, 'step 3 progress fills the lower header, matches task track height and the last step edge');
  assert.equal(await page.locator('#builder-progress-count').innerText(), '4/10', 'only reviewed blocks contribute to the counter');
  assert.equal(await page.locator('#builder-progress-bar').getAttribute('aria-label'), 'Проверено 4 из 10 блоков: пройдено 3, не пройдено 1, не проверено 6');
  assert.deepEqual(await page.locator('#builder-progress-bar > *').evaluateAll(nodes => nodes.map(node => [...node.classList].find(name => /^bg-(green|yellow|secondary)$/.test(name)))), ['bg-green', 'bg-secondary', 'bg-green', 'bg-yellow', 'bg-secondary', 'bg-green', 'bg-secondary', 'bg-secondary', 'bg-secondary', 'bg-secondary']);
  await page.locator('#stage-step-2').click(); assert.equal(await page.locator('#builder-progress').evaluate(node => node.classList.contains('stage-hidden')), true, 'step 3 progress is hidden on another active step');
  await page.locator('#stage-step-3').click(); assert.equal(await page.locator('#builder-progress').evaluate(node => node.classList.contains('stage-hidden')), false);
  assert.equal(await page.locator('.builder-overview, .builder-section-header, .builder-edit').count(), 0, 'overview and manual section controls are absent');
  assert.deepEqual(await page.locator('.builder-tab').allInnerTexts(), ['Акции/новости', 'Афиша', 'Цены', 'О нас']);
  assert.ok(await page.locator('.builder-block').count() >= 5); assert.match(await page.locator('.builder-failure-reason').first().innerText(), /проверить|сверить/i);
  assert.equal(await page.locator('.builder-block-status').count(), 0, 'cards do not duplicate the left-border status with a marker');
  assert.equal(await page.locator('.builder-block').evaluateAll(nodes => nodes.every(node => node.querySelector('.builder-type-icon > svg') && node.querySelector('.builder-block-title') && !node.querySelector('.builder-block-heading'))), true, 'each compact card uses a square type icon and a dedicated title row');
  assert.equal(await page.locator('.builder-block').first().evaluate(node => { const css = getComputedStyle(node), root = getComputedStyle(document.documentElement), surface = document.createElement('span'); surface.style.backgroundColor = root.getPropertyValue('--tblr-bg-surface'); document.body.append(surface); const expected = getComputedStyle(surface).backgroundColor; surface.remove(); const rgb = css.backgroundColor.match(/\d+/g).slice(0, 3).map(Number); return css.backgroundColor === expected && rgb.every(channel => channel > 224); }), true, 'block cards use the ARM light surface theme token');
  assert.equal(await page.locator('.builder-text-preview').evaluateAll(nodes => nodes.every(node => { const css = getComputedStyle(node); return css.overflow === 'hidden' && css.webkitLineClamp === '2'; })), true, 'card text excerpts stay within two lines');
  const gallery = page.locator('[data-builder-id="news-promos"] .builder-media-preview');
  assert.equal(await gallery.locator('img').count(), 2); assert.equal((await gallery.locator('.builder-media-more').innerText()).trim(), '+2', 'media preview uses two thumbnails and a compact overflow count');
  await page.setViewportSize({ width: 600, height: 900 });
  assert.equal(await page.locator('[data-builder-id="common-actions"] .builder-media-preview img:visible').count(), 2, '600px keeps both thumbnails when the block has two media');
  assert.equal(await page.locator('[data-builder-id="common-actions"] .builder-media-more').count(), 0, '600px does not invent an overflow count for two visible media');
  assert.equal(await gallery.locator('img:visible').count(), 2, '600px keeps the two thumbnails represented by the overflow count');
  assert.equal((await gallery.locator('.builder-media-more:visible').innerText()).trim(), '+2', '600px overflow count matches the two remaining media');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '600px media previews do not cause horizontal overflow');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const borderColors = await page.locator('.builder-block').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.classList.contains('review-failed') ? 'failed' : node.classList.contains('review-passed') ? 'passed' : 'unreviewed', getComputedStyle(node).borderLeftColor])));
  assert.deepEqual(Object.keys(borderColors).sort(), ['failed', 'passed', 'unreviewed']); assert.equal(new Set(Object.values(borderColors)).size, 3, 'passed, failed and unreviewed use distinct left-border colors');
  assert.match(await page.locator('.builder-block.review-failed .builder-failure-reason').innerText(), /сверить/i, 'failed reason remains visible');
  const columns = await page.locator('.builder-section .row').evaluateAll(rows => rows.map(row => ({ rowWidth: row.getBoundingClientRect().width, cards: [...row.children].map(column => ({ columnWidth: column.getBoundingClientRect().width, cardHeight: column.querySelector('.builder-block').getBoundingClientRect().height, classes: column.className })) })));
  for (const row of columns) for (const card of row.cards) { assert.match(card.classes, /\bcol-12\b/); assert.doesNotMatch(card.classes, /\bcol-(?:sm|md|lg|xl|xxl)-/); assert.ok(Math.abs(card.columnWidth - row.rowWidth) < 2, 'block occupies one full-width column'); assert.ok(card.cardHeight < 240, 'block card stays compact'); }
  const tabs = page.locator('.builder-tab');
  assert.deepEqual(await tabs.evaluateAll(nodes => nodes.map(node => ({ id: node.id, controls: node.getAttribute('aria-controls'), selected: node.getAttribute('aria-selected'), tabIndex: node.tabIndex }))), [
    { id: 'builder-tab-news', controls: 'builder-panel-news', selected: 'true', tabIndex: 0 },
    { id: 'builder-tab-posters', controls: 'builder-panel-posters', selected: 'false', tabIndex: -1 },
    { id: 'builder-tab-prices', controls: 'builder-panel-prices', selected: 'false', tabIndex: -1 },
    { id: 'builder-tab-about', controls: 'builder-panel-about', selected: 'false', tabIndex: -1 }
  ]);
  assert.deepEqual(await tabs.evaluateAll(nodes => nodes.map(node => { const panel = document.getElementById(node.getAttribute('aria-controls')); return { exists: Boolean(panel), labelledBy: panel?.getAttribute('aria-labelledby'), hidden: panel?.hidden }; })), [
    { exists: true, labelledBy: 'builder-tab-news', hidden: false },
    { exists: true, labelledBy: 'builder-tab-posters', hidden: true },
    { exists: true, labelledBy: 'builder-tab-prices', hidden: true },
    { exists: true, labelledBy: 'builder-tab-about', hidden: true }
  ]);
  assert.equal(await page.locator('.builder-tab-panel:visible').count(), 1, 'exactly one tab panel is visible');
  await tabs.first().focus(); await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#builder-tab-posters').getAttribute('aria-selected'), 'true'); assert.equal(await page.locator('#builder-tab-posters').evaluate(node => document.activeElement === node), true); assert.equal(await page.locator('#builder-panel-posters').getAttribute('aria-labelledby'), 'builder-tab-posters'); assert.equal(await page.locator('#builder-panel-news').evaluate(node => node.hidden), true); assert.equal(await page.locator('#builder-panel-posters').evaluate(node => node.hidden), false);
  await page.locator('#builder-tab-prices').click(); assert.equal(await page.locator('#builder-tab-prices').getAttribute('aria-selected'), 'true'); assert.equal(await page.locator('#builder-panel-posters').evaluate(node => node.hidden), true); assert.equal(await page.locator('#builder-panel-prices').evaluate(node => node.hidden), false); assert.equal(await page.locator('.builder-tab-panel:visible').count(), 1, 'click keeps only its controlled panel visible');
  await page.locator('#builder-tab-news').click();
  await page.keyboard.press('End'); assert.equal(await page.locator('#builder-tab-about').evaluate(node => document.activeElement === node), true); await page.keyboard.press('Home'); assert.equal(await page.locator('#builder-tab-news').evaluate(node => document.activeElement === node), true); await page.keyboard.press('ArrowLeft'); assert.equal(await page.locator('#builder-tab-about').evaluate(node => document.activeElement === node), true); await page.keyboard.press('Home');
  const commonHero = page.locator('#page-builder-content > .builder-section').first().locator('.builder-block').first(), commonHeroOpener = commonHero.locator('.builder-block-open');
  await commonHeroOpener.evaluate(opener => new Promise(resolve => { document.getElementById('page-builder-modal').addEventListener('hidden.bs.modal', resolve, { once: true }); opener.click(); document.getElementById('page-builder-form').requestSubmit(); }));
  assert.equal(await page.locator('#page-builder-modal').isHidden(), true, 'unchanged submit before shown waits for shown and then closes'); assert.equal(builderPosts.length, 0); assert.equal(queue.pageBuilder.read(job.id).revision, 1); assert.equal(await commonHeroOpener.evaluate(node => node === document.activeElement), true, 'deferred no-op close restores focus to its opener');
  await commonHero.click(); await page.waitForSelector('#page-builder-modal.show'); await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  assert.equal(builderPosts.length, 0, 'unchanged edit submit sends no POST'); assert.equal(queue.pageBuilder.read(job.id).revision, 1, 'unchanged edit does not consume a revision'); assert.equal(await commonHeroOpener.evaluate(node => node === document.activeElement), true, 'unchanged edit closes normally and restores focus');
  await commonHero.click(); await page.waitForSelector('#page-builder-modal.show'); await page.locator('#builder-title').fill('MORI CINEMA · Годовикова, 37'); await page.locator('#builder-review-status').selectOption('passed'); await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#page-builder-content > .builder-section')?.textContent.includes('MORI CINEMA · Годовикова, 37'));
  let stored = queue.pageBuilder.read(job.id); assert.equal(stored.revision, 2); assert.equal(stored.document.common.blocks[0].title, 'MORI CINEMA · Годовикова, 37', 'common block is located and persisted');
  const vacancy = page.getByRole('button', { name: /^Вакансии\./ }); await vacancy.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('#builder-review-status').inputValue(), 'failed'); assert.match(await page.locator('#builder-review-reason').inputValue(), /сверить/i);
  await page.locator('#builder-title').fill('Не сохранять'); await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  assert.match(await vacancy.innerText(), /^Вакансии\nВ кинотеатр MORI CINEMA/m, 'Cancel leaves the document unchanged');
  await vacancy.click(); await page.waitForSelector('#page-builder-modal.show'); await page.locator('#builder-title').fill('Черновик пользователя');
  const externalStored = queue.pageBuilder.read(job.id), externalDocument = structuredClone(externalStored.document); externalDocument.tabs[0].blocks[1].title = 'Внешняя запись'; queue.pageBuilder.write(job.id, externalStored.revision, externalDocument);
  await page.waitForRequest(request => new URL(request.url()).pathname === '/api/state'); await page.waitForTimeout(100);
  assert.equal(await vacancy.evaluate(node => node.isConnected), true, 'polling with a newer revision does not replace the live opener'); assert.equal(await page.locator('#builder-title').inputValue(), 'Черновик пользователя');
  const postsBeforeMismatch = builderPosts.length; await page.locator('#page-builder-save').click(); await page.waitForFunction(() => document.querySelector('#page-builder-form-error').textContent.includes('Страница обновилась'));
  assert.equal(builderPosts.length, postsBeforeMismatch, 'draft revision mismatch sends no POST'); assert.equal(await page.locator('#page-builder-modal').isVisible(), true); stored = queue.pageBuilder.read(job.id); assert.equal(stored.revision, 3); assert.equal(stored.document.tabs[0].blocks[1].title, 'Внешняя запись', 'stale draft guard preserves the external write');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); await page.waitForFunction(() => document.querySelector('.builder-tab-panel')?.textContent.includes('Внешняя запись')); assert.equal(await page.evaluate(() => document.activeElement?.dataset.builderId), 'news-vacancy', 'focus maps to the refreshed opener after conflict cancel');
  const externalVacancy = page.getByRole('button', { name: /^Внешняя запись\./ }); await externalVacancy.click(); await page.locator('#builder-title').fill('Вакансии кинотеатра'); await page.locator('#builder-review-status').selectOption('failed'); await page.locator('#builder-review-reason').fill('');
  await page.locator('#page-builder-save').click(); assert.match(await page.locator('#page-builder-form-error').innerText(), /Укажите причину/);
  await page.locator('#builder-review-status').selectOption('passed'); await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.builder-tab-panel')?.textContent.includes('Вакансии кинотеатра'));
  stored = queue.pageBuilder.read(job.id); assert.equal(stored.revision, 4); assert.equal(stored.document.tabs[0].blocks[1].review.status, 'passed');
  let releaseDelayedSave, markDelayedSaveArrived; const delayedSaveGate = new Promise(resolve => { releaseDelayedSave = resolve; }), delayedSaveArrived = new Promise(resolve => { markDelayedSaveArrived = resolve; });
  const builderApiPattern = `**/api/page-builder/${job.id}?attempt=*`, delayedSaveHandler = async route => { if (route.request().method() !== 'POST') return route.continue(); markDelayedSaveArrived(); await delayedSaveGate; await route.continue(); };
  await page.route(builderApiPattern, delayedSaveHandler); const delayedCommon = page.getByRole('button', { name: /^MORI CINEMA · Годовикова, 37\./ }); await delayedCommon.click(); await page.locator('#builder-title').fill('MORI CINEMA · атомарное сохранение'); await page.locator('#page-builder-save').click(); await delayedSaveArrived;
  const cancelSave = page.getByRole('button', { name: 'Отмена', exact: true }), closeSave = page.getByRole('button', { name: 'Отменить и закрыть', exact: true }); assert.equal(await cancelSave.isDisabled(), true); assert.equal(await closeSave.isDisabled(), true); assert.equal(await page.locator('#page-builder-modal').getAttribute('aria-busy'), '');
  await cancelSave.evaluate(node => node.click()); assert.equal(await page.locator('#page-builder-modal').isVisible(), true, 'Cancel cannot interrupt an in-flight save'); await page.keyboard.press('Escape'); assert.equal(await page.locator('#page-builder-modal').isVisible(), true, 'Escape cannot interrupt an in-flight save'); await closeSave.evaluate(node => node.click()); assert.equal(await page.locator('#page-builder-modal').isVisible(), true, 'close cannot interrupt an in-flight save');
  await page.getByRole('button', { name: /^Быстрые действия\./ }).evaluate(node => node.click()); assert.equal(await page.locator('#builder-title').inputValue(), 'MORI CINEMA · атомарное сохранение', 'another block cannot replace the pending draft');
  releaseDelayedSave(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); await page.unroute(builderApiPattern, delayedSaveHandler); await page.waitForFunction(() => document.querySelector('#page-builder-content > .builder-section')?.textContent.includes('MORI CINEMA · атомарное сохранение'));
  stored = queue.pageBuilder.read(job.id); assert.equal(stored.revision, 5); assert.equal(stored.document.common.blocks[0].title, 'MORI CINEMA · атомарное сохранение'); assert.equal(await page.evaluate(() => document.activeElement?.dataset.builderId), 'common-hero', 'completed delayed save renders and restores focus to its opener');
  const edit = page.locator('.builder-tab-panel .builder-block-open').first(); await edit.focus(); const editHandle = await edit.elementHandle(); await edit.click(); await page.waitForSelector('#page-builder-modal.show'); await page.waitForFunction(() => document.activeElement?.closest('#page-builder-modal')); await page.waitForRequest(request => new URL(request.url()).pathname === '/api/state'); await page.waitForRequest(request => new URL(request.url()).pathname === '/api/state'); assert.equal(await editHandle.evaluate(node => node.isConnected), true, 'unchanged polling keeps the opener node alive'); await page.keyboard.press('Escape'); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); assert.equal(await editHandle.evaluate(node => document.activeElement === node), true, 'Escape restores focus after multiple polls');
  for (const width of [1440, 390, 375, 360, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); await page.locator('.builder-block').filter({ hasText: 'Вакансии кинотеатра' }).click(); await page.waitForSelector('#page-builder-modal.show');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: no horizontal document overflow`);
    assert.equal(await page.locator('.builder-block').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().right <= innerWidth + 1)), true, `${width}: full-width cards fit the viewport`);
    const dialog = await page.locator('#page-builder-modal .modal-dialog').evaluate(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; }); assert.ok(dialog.left >= -1 && dialog.right <= width + 1, `${width}: modal fits viewport`);
    await page.waitForFunction(() => document.activeElement?.closest('#page-builder-modal')); await page.keyboard.press('Escape'); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  }
  stored = queue.pageBuilder.read(job.id); const allPassed = structuredClone(stored.document); for (const section of [allPassed.common, ...allPassed.tabs]) { section.review = { status: 'failed', reason: 'Устаревший ручной статус раздела.' }; section.blocks.forEach(block => { block.review = { status: 'passed', reason: '' }; }); }
  queue.pageBuilder.write(job.id, stored.revision, allPassed); await page.waitForFunction(() => document.querySelector('#stage-step-3')?.classList.contains('step-state-success'));
  await page.waitForFunction(() => document.querySelector('#builder-progress-count')?.textContent === '10/10'); assert.equal(await page.locator('#builder-progress-bar .bg-yellow').count(), 0, 'stale section failure does not affect block progress');
  fs.writeFileSync(queue.pageBuilder.file(job.id), '{broken'); await page.waitForFunction(() => document.querySelector('#stage-step-3')?.classList.contains('step-state-error'));
  assert.deepEqual(external, [], 'step 3 does not fetch Mori media from the network'); assert.deepEqual(errors, []);
});

test('step 3 block management supports create, drag, keyboard move, delete, conflicts and reload', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-management-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  seedMoriPage(queue, queue.jobs[0]);
  const job = queue.jobs[0]; Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], builderPosts = []; page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/page-builder/${job.id}`) builderPosts.push(request); });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const waitClosed = async () => { await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); };
  const waitRevision = async revision => { await page.waitForFunction(() => !document.querySelector('#page-builder-content').hasAttribute('aria-busy')); assert.equal(queue.pageBuilder.read(job.id).revision, revision, await page.locator('#page-builder-error').textContent()); };
  assert.equal(await page.locator('.builder-block-actions').count(), 0, 'the old separate action row is absent');
  assert.equal(await page.locator('.builder-actions-toggle').count(), 0, 'there is no ellipsis menu button');
  assert.equal(await page.locator('.builder-block button button, .builder-block button select').count(), 0, 'interactive controls are never nested');
  assert.equal(await page.locator('.builder-action-panel:visible').count(), 0, 'additional actions are closed by default');
  assert.equal(await page.locator('.builder-delete').evaluateAll(nodes => nodes.every(node => node.textContent === '' && node.title === 'Удалить блок' && node.getAttribute('aria-label').startsWith('Удалить блок:') && node.querySelector('svg'))), true, 'delete is a labelled trash icon without visible button text');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement?.blur());
    await page.locator('.builder-add').evaluateAll(nodes => Promise.all(nodes.flatMap(node => node.getAnimations().map(animation => animation.finished))));
    const geometry = await page.locator('.builder-block:visible').evaluateAll(cards => cards.map(card => {
      const box = card.getBoundingClientRect(), opener = card.querySelector('.builder-block-open').getBoundingClientRect();
      const icon = card.querySelector('.builder-type-icon').getBoundingClientRect(), description = card.querySelector('.builder-text-preview'), descriptionCss = description && getComputedStyle(description);
      return { tag: card.tagName, width: box.width, iconSquare: Math.abs(icon.width - icon.height) < 1, descriptionSingleLine: !description || (descriptionCss.webkitLineClamp === '2'), controls: [...card.querySelectorAll('.builder-card-tools > .btn, .builder-drag-handle')].map(control => { const rect = control.getBoundingClientRect(); return rect.left >= opener.right - 1 && rect.right <= box.right + 1 && rect.top >= box.top && rect.bottom <= box.bottom + 1; }) };
    }));
    assert.ok(geometry.every(card => card.tag === 'DIV' && card.iconSquare && card.descriptionSingleLine && card.controls.length === 2 && card.controls.every(Boolean)), `${width}: compact card geometry retains square type icons, two-line text excerpts, and right-side controls`);
    assert.equal(await page.locator('.builder-add:visible').evaluateAll(nodes => nodes.every(node => { const box = node.getBoundingClientRect(), parent = node.parentElement.getBoundingClientRect(), plus = node.querySelector('.builder-add-plus').getBoundingClientRect(); return Math.abs(box.width - parent.width) < 2 && getComputedStyle(node).borderTopStyle === 'dashed' && node.innerText === '+' && node.title === node.getAttribute('aria-label') && node.title.startsWith('Добавить блок:') && Math.abs((plus.left + plus.right - box.left - box.right) / 2) < 1 && Math.abs((plus.top + plus.bottom - box.top - box.bottom) / 2) < 1; })), true, `${width}: full-width dashed add area displays only one centered plus and retains its accessible name`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: no horizontal overflow`);
    if ([1440, 320].includes(width)) await page.locator('#stage-three-panel').screenshot({ path: path.join(testOutput(), `ui-stage-three-controls-${width}.png`) });
    const addArea = page.locator('[data-add-section="common"]'); await addArea.scrollIntoViewIfNeeded();
    const baseline = await addArea.evaluate(node => {
      const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;visibility:hidden;background:transparent;border:1px dashed var(--tblr-border-color);color:var(--tblr-primary)'; node.append(probe);
      const read = () => { const css = getComputedStyle(probe); return { background: css.backgroundColor, border: css.borderTop, color: css.color }; };
      const normal = read(); probe.style.background = 'var(--tblr-primary-lt)'; probe.style.borderColor = 'var(--tblr-primary)'; probe.style.color = 'var(--tblr-btn-hover-color, var(--tblr-body-color))'; const active = read(); probe.remove(); return { normal, active };
    });
    const appearance = () => addArea.evaluate(node => { const box = node.getBoundingClientRect(), css = getComputedStyle(node); return { width: box.width, height: box.height, border: css.borderTop, borderStyle: css.borderTopStyle, borderWidth: css.borderTopWidth, borderColor: css.borderTopColor, background: css.backgroundColor, plusColor: getComputedStyle(node.querySelector('.builder-add-plus')).color, shadow: css.boxShadow, outline: css.outlineStyle }; });
    const idle = await appearance(); await addArea.hover(); await addArea.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
    const hovered = await appearance();
    assert.equal(idle.background, baseline.normal.background); assert.equal(idle.border, baseline.normal.border, 'normal background and border retain the original plus-only styling');
    assert.equal(hovered.background, baseline.active.background); assert.equal(hovered.border, baseline.active.border, 'hover background and border retain the original plus-only styling');
    assert.equal(idle.plusColor, idle.borderColor, 'normal plus exactly matches the dashed border color'); assert.equal(hovered.plusColor, baseline.normal.color, 'hover and focus plus retain the existing primary color');
    assert.equal(hovered.width, idle.width); assert.equal(hovered.height, idle.height); assert.equal(hovered.borderStyle, 'dashed'); assert.equal(hovered.borderWidth, idle.borderWidth); assert.equal(hovered.shadow, 'none'); assert.equal(hovered.outline, 'none'); assert.notEqual(hovered.borderColor, idle.borderColor); assert.notEqual(hovered.background, idle.background);
    if ([1440, 320].includes(width)) await addArea.screenshot({ path: path.join(testOutput(), `ui-stage-three-add-hover-${width}.png`) });
    await addArea.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await page.mouse.move(0, 0);
    assert.equal(await addArea.evaluate(node => node.matches(':focus-visible')), true);
    assert.deepEqual(await appearance(), hovered, `${width}: keyboard focus and hover share a single stable border/background with no geometry shift`);
    if ([1440, 320].includes(width)) await addArea.screenshot({ path: path.join(testOutput(), `ui-stage-three-add-focus-${width}.png`) });
  }
  await page.emulateMedia({ forcedColors: 'active' });
  const forcedAdd = page.locator('[data-add-section="common"]');
  assert.equal(await forcedAdd.evaluate(node => { const css = getComputedStyle(node); return node.matches(':focus-visible') && css.color !== css.backgroundColor && css.borderTopStyle === 'dashed' && css.boxShadow === 'none'; }), true, 'forced colors preserves a distinguishable keyboard focus state');
  await page.emulateMedia({ forcedColors: 'none' });
  const tools = page.getByRole('button', { name: 'Перетащить блок: MORI CINEMA', exact: true }); await tools.focus(); await page.keyboard.press('Enter');
  assert.equal(await tools.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#builder-actions-common-hero').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }), true, 'actions panel fits at 320px');
  await page.keyboard.press('Escape'); assert.equal(await tools.getAttribute('aria-expanded'), 'false'); assert.equal(await tools.evaluate(node => node === document.activeElement), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { window.builderModalShown = new Promise(resolve => document.getElementById('page-builder-modal').addEventListener('shown.bs.modal', resolve, { once: true })); });
  await page.locator('[data-add-section="common"]').click(); await page.locator('#builder-title').fill('Отменённый блок'); await page.evaluate(() => window.builderModalShown.then(() => true)); await page.keyboard.press('Escape'); await waitClosed();
  assert.equal(queue.pageBuilder.read(job.id).revision, 1); assert.equal(await page.locator('[data-add-section="common"]').evaluate(node => node === document.activeElement), true);
  await page.locator('[data-add-section="common"]').click(); await page.locator('#builder-title').fill('Новый общий блок'); await page.locator('#builder-type').selectOption('table'); await page.locator('#builder-content').fill('Колонка; Значение'); await page.locator('#page-builder-save').click(); await waitClosed();
  await page.waitForSelector('.builder-block-open[data-builder-id^="block-"]');
  const created = queue.pageBuilder.read(job.id).document.common.blocks.at(-1); assert.match(created.id, /^block-[a-f0-9-]{36}$/); assert.equal(created.type, 'table'); assert.equal(created.review.status, 'unreviewed');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.builderId), created.id, 'create focuses persisted block');
  await page.getByRole('button', { name: 'Перетащить блок: Новый общий блок', exact: true }).focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Выше: Новый общий блок', 'keyboard opens actions and reaches reorder');
  await page.keyboard.press('Enter'); await waitRevision(3);
  assert.deepEqual(queue.pageBuilder.read(job.id).document.common.blocks.map(block => block.id), ['common-hero', created.id, 'common-actions']);
  await page.getByRole('button', { name: 'Перетащить блок: Новый общий блок', exact: true }).focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowDown'); await waitRevision(4);
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).id, created.id);
  // Native browser drag to an inactive tab moves the block and selects its destination.
  await page.getByRole('button', { name: 'Перетащить блок: Новый общий блок', exact: true }).dragTo(page.locator('#builder-tab-posters')); await waitRevision(5);
  assert.equal(await page.locator('#builder-tab-posters').getAttribute('aria-selected'), 'true');
  assert.equal(queue.pageBuilder.read(job.id).document.tabs[1].blocks.at(-1).id, created.id);
  // The upper half of a card is a precise insertion target.
  await page.getByRole('button', { name: 'Перетащить блок: Новый общий блок', exact: true }).dragTo(page.locator('[data-block-id="posters-gallery"]'), { targetPosition: { x: 30, y: 5 } }); await waitRevision(6);
  assert.deepEqual(queue.pageBuilder.read(job.id).document.tabs[1].blocks.map(block => block.id), [created.id, 'posters-gallery']);
  await page.getByRole('button', { name: 'Перетащить блок: Афиша', exact: true }).click(); await page.getByLabel('Перенести блок: Афиша', { exact: true }).selectOption('common'); await waitRevision(7);
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).review.status, 'unreviewed');
  await page.locator('#builder-tab-posters').click(); await page.getByRole('button', { name: 'Удалить блок: Новый общий блок', exact: true }).click();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await waitClosed(); assert.equal(queue.pageBuilder.read(job.id).revision, 7);
  await page.getByRole('button', { name: 'Удалить блок: Новый общий блок', exact: true }).click(); await page.locator('#page-builder-save').click(); await waitClosed(); await page.waitForFunction(() => document.activeElement?.dataset.addSection === 'posters');
  assert.deepEqual(queue.pageBuilder.read(job.id).document.tabs[1].blocks, []); assert.equal(await page.locator('[data-drop-section="posters"]').innerText(), '+', 'empty sections also display only the add symbol');
  await page.getByRole('button', { name: 'Перетащить блок: MORI CINEMA', exact: true }).dragTo(page.locator('[data-drop-section="posters"]')); await waitRevision(9);
  assert.equal(queue.pageBuilder.read(job.id).document.tabs[1].blocks[0].id, 'common-hero');
  // Creation keeps its opening revision across polling and cannot overwrite external edits.
  await page.locator('[data-add-section="posters"]').click(); await page.locator('#builder-title').fill('Конфликт создания');
  const beforeConflict = queue.pageBuilder.read(job.id), external = structuredClone(beforeConflict.document); external.common.blocks[0].title = 'Изменено извне'; queue.pageBuilder.write(job.id, beforeConflict.revision, external);
  await page.waitForRequest(request => new URL(request.url()).pathname === '/api/state');
  const postsBeforeConflict = builderPosts.length; await page.locator('#page-builder-save').click(); await page.waitForFunction(() => document.querySelector('#page-builder-form-error').textContent.includes('Страница обновилась'));
  assert.equal(builderPosts.length, postsBeforeConflict, 'stale create draft sends no POST'); assert.equal(queue.pageBuilder.read(job.id).revision, 10); assert.equal(queue.pageBuilder.read(job.id).document.tabs[1].blocks.length, 1);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await waitClosed(); await page.waitForSelector('.builder-block-open[data-builder-id="common-actions"][aria-label^="Изменено извне"]');
  // Delayed creation freezes other mutations, Escape and polling until the CAS completes.
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { arrived = resolve; });
  const pattern = `**/api/page-builder/${job.id}?attempt=*`, delay = async route => { if (route.request().method() !== 'POST') return route.continue(); arrived(); await gate; await route.continue(); };
  await page.route(pattern, delay); await page.locator('[data-add-section="posters"]').click(); await page.locator('#builder-title').fill('Сохранённая вкладка'); await page.locator('#builder-type').selectOption('embed'); await page.locator('#page-builder-save').click(); await started;
  assert.equal(await page.getByRole('button', { name: 'Отмена', exact: true }).isDisabled(), true); await page.keyboard.press('Escape'); assert.equal(await page.locator('#page-builder-modal').isVisible(), true);
  await page.locator('[data-add-section="common"]').evaluate(node => node.click()); assert.equal(await page.locator('#builder-title').inputValue(), 'Сохранённая вкладка');
  release(); await waitClosed(); await page.unroute(pattern, delay); await page.waitForSelector('.builder-block-open[aria-label^="Сохранённая вкладка"]');
  const final = queue.pageBuilder.read(job.id); assert.equal(final.revision, 11); assert.equal(final.document.tabs[1].blocks.at(-1).type, 'embed');
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)'); await page.locator('#builder-tab-posters').click();
  assert.deepEqual(await page.locator('#builder-panel-posters .builder-block-open').evaluateAll(nodes => nodes.map(node => node.dataset.builderId)), final.document.tabs[1].blocks.map(block => block.id));
  assert.deepEqual(queue.pageBuilder.read(job.id), final);
  await page.setViewportSize({ width: 320, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test('step 3 canonical editor offers dependent views, browser media selection and safe review with reload', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-editor-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0];
  seedMoriPage(queue, job);
  const openedFolders = []; let selectedPath = null;
  queue.mediaPicker.openDialog = async directory => { openedFolders.push(directory); return selectedPath; };
  const previewBytes = installLocalPreview(queue, job, queue.pageBuilder.read(job.id).document.common.blocks[0].media[0]);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), external = [], errors = [], origin = `http://127.0.0.1:${server.address().port}`;
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const opener = page.locator('[data-builder-id="common-hero"]'), modal = page.locator('#page-builder-modal');
  const close = async () => { await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); };
  const initial = queue.pageBuilder.read(job.id);
  await opener.click();
  assert.equal(await page.getByRole('button', { name: 'Выбрать основную картинку из шага 2' }).isDisabled(), false);
  assert.equal(await page.locator('.builder-media-status').count(), 0, 'there is no media preparation stage');
  const preview = await page.locator('.builder-image-row img').first().evaluate(async image => { const response = await fetch(image.src); return { type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength }; });
  assert.deepEqual(preview, { type: 'image/png', bytes: previewBytes.length }, 'saved media uses the verified local stage-2 image instead of the SVG placeholder');
  const savedAsset = initial.document.common.blocks[0].media[0], savedRow = page.locator('.builder-image-row').first(), originalUrl = savedRow.getByLabel('URL изображения', { exact: true }), bigUrl = savedRow.getByLabel('URL крупной версии', { exact: true });
  const legacyFilename = decodeURIComponent(new URL(savedAsset.originalUrl).pathname.split('/').at(-1)); assert.equal(await originalUrl.inputValue(), legacyFilename);
  assert.equal(await originalUrl.isDisabled(), true); assert.equal(await bigUrl.isDisabled(), true); assert.equal(await originalUrl.evaluate(node => node.readOnly), true);
  assert.equal(await savedRow.locator('figcaption').count(), 0); assert.equal(await savedRow.locator('label').count(), 0);
  assert.deepEqual(await savedRow.locator('.builder-media-placeholder').allTextContents(), ['Большая картинка'], 'only the empty preview shows its label');
  const placeholderCentered = async row => row.locator('.builder-media-placeholder').evaluateAll(nodes => nodes.every(node => {
    const style = getComputedStyle(node);
    return style.display === 'grid' && style.placeItems === 'center' && style.textAlign === 'center';
  }));
  assert.equal(await placeholderCentered(savedRow), true);
  assert.equal(await savedRow.locator('.builder-image-picker button').evaluateAll(buttons => buttons.every(button => button.textContent === '' && button.querySelector('svg[aria-hidden="true"]'))), true, 'image picker uses a vector icon without emoji');
  assert.equal(await page.locator('#builder-title').getAttribute('placeholder'), 'Заголовок');
  for (const [label, placeholder] of [['URL изображения', 'Основная картинка'], ['URL крупной версии', 'Большая картинка'], ['Ссылка изображения', 'Ссылка'], ['Альтернативный текст', 'Альтернативный текст'], ['Подпись', 'Подпись']]) assert.equal(await savedRow.getByLabel(label, { exact: true }).getAttribute('placeholder'), placeholder);
  const imageDirectory = path.join(queue.stage.media.directory(job, job.attempts[0]), 'images'), imageName = fs.readdirSync(imageDirectory)[0];
  assert.equal(await savedRow.locator('.builder-image-picker button').count(), 2, 'one folder button per image variant');
  assert.equal(await savedRow.locator('input[type="file"]').count(), 0, 'browser upload button is removed');
  const folderButton = savedRow.getByRole('button', { name: 'Выбрать основную картинку из шага 2' });
  const selectImage = async (row, kind, file, status = 200) => {
    selectedPath = file;
    const done = page.waitForResponse(response => response.url().endsWith('/pick-prepared-media'));
    await row.getByRole('button', { name: `Выбрать ${kind} картинку из шага 2`, exact: true }).click();
    const response = await done; assert.equal(response.status(), status);
    await page.waitForFunction(() => !document.getElementById('page-builder-save').disabled);
  };
  await selectImage(savedRow, 'основную', null); assert.deepEqual(openedFolders, [imageDirectory]);
  assert.equal(await originalUrl.inputValue(), legacyFilename);
  let dialogStarted, finishDialog, dialogSignal;
  const started = new Promise(resolve => { dialogStarted = resolve; });
  queue.mediaPicker.openDialog = (_directory, signal) => {
    dialogSignal = signal;
    const pending = new Promise((_, reject) => { finishDialog = () => reject(new Error('Диалог закрыт')); });
    dialogStarted(); return pending;
  };
  await folderButton.click(); await started;
  assert.equal(queue.mediaPicker.dialogBusy, true);
  assert.equal(await savedRow.locator('.builder-picker-feedback:visible').count(), 0, 'opening the system picker adds no instruction below the fields');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close();
  await new Promise((resolve, reject) => {
    if (dialogSignal.aborted) return resolve();
    const timer = setTimeout(() => reject(new Error('modal close did not abort the native dialog')), 3000);
    dialogSignal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  assert.equal(queue.mediaPicker.dialogBusy, true, 'modal close waits for native process exit');
  finishDialog();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => queue.mediaPicker.dialogBusy ? (Date.now() < deadline ? setTimeout(check, 10) : reject(new Error('dialog did not close'))) : resolve();
    check();
  });
  queue.mediaPicker.openDialog = async directory => { openedFolders.push(directory); return selectedPath; };
  await opener.click(); await page.waitForFunction(() => !document.getElementById('builder-media-common-hero-media-originalUrl-choose')?.disabled);
  assert.equal(await originalUrl.inputValue(), legacyFilename, 'closing a dialog leaves the draft unchanged');
  selectedPath = path.join(root, 'outside.png');
  await selectImage(savedRow, 'большую', selectedPath, 400);
  assert.match(await savedRow.locator('.builder-picker-feedback[role="alert"]').innerText(), /папки изображений шага 2/);
  assert.equal(await bigUrl.inputValue(), '', 'wrong filename leaves the draft unchanged');
  const changed = Buffer.from(previewBytes); changed[changed.length - 1] ^= 1; fs.writeFileSync(path.join(imageDirectory, imageName), changed);
  await selectImage(savedRow, 'большую', path.join(imageDirectory, imageName), 400);
  assert.match(await savedRow.locator('.builder-picker-feedback[role="alert"]').innerText(), /не совпадает/);
  assert.equal(await bigUrl.inputValue(), '', 'wrong bytes leave the draft unchanged');
  fs.writeFileSync(path.join(imageDirectory, imageName), previewBytes);
  await selectImage(savedRow, 'большую', path.join(imageDirectory, imageName)); assert.equal(await savedRow.locator('img').count(), 2); assert.match(await bigUrl.inputValue(), /\.png$/);
  assert.equal(await originalUrl.inputValue(), legacyFilename, 'big-image selection leaves the original variant unchanged');
  assert.deepEqual(queue.pageBuilder.read(job.id), initial, 'browser selection changes only the draft');
  assert.equal(await page.locator('.builder-image-row').first().getByText(/Изображение 1/).count(), 0, 'image number is not visibly rendered');
  assert.equal(await page.locator('.builder-image-row').first().getByRole('button', { name: /Выше|Ниже/ }).count(), 0, 'separate arrow buttons are removed');
  assert.equal(await page.locator('.builder-image-row').first().locator('.builder-image-tools').count(), 1); assert.equal(await page.locator('.builder-image-tools svg').count(), 1);
  assert.equal((await page.locator('#builder-add-image').innerText()).trim(), '+'); assert.equal(await page.locator('#builder-add-image').getAttribute('aria-label'), 'Добавить изображение'); assert.equal(await page.locator('#builder-add-image').evaluate(node => node.classList.contains('builder-add')), true);
  assert.equal(await page.locator('.builder-images-section').evaluate(node => parseFloat(getComputedStyle(node).marginBottom) > 0), true, 'image section keeps vertical separation before review status');
  await page.locator('#builder-add-image').click();
  assert.equal(await page.locator('.builder-image-row').last().getByLabel('URL изображения', { exact: true }).evaluate(node => node.required), false);
  const emptyRow = page.locator('.builder-image-row').last();
  assert.deepEqual(await emptyRow.locator('.builder-media-placeholder').allTextContents(), ['Основная картинка', 'Большая картинка']);
  assert.equal(await placeholderCentered(emptyRow), true, 'both labels are centered in empty previews');
  const picksBeforeDrop = openedFolders.length;
  await emptyRow.locator('.builder-media-placeholder').first().evaluate((target, data) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(data.bytes)], data.name, { type: 'image/png' }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { name: imageName, bytes: [...previewBytes] });
  assert.equal(openedFolders.length, picksBeforeDrop, 'dropping a file on preview does not select it');
  assert.equal(await page.locator('.builder-image-row').last().locator('img').count(), 0);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close(); assert.deepEqual(queue.pageBuilder.read(job.id), initial, 'cancel discards newly added media');
  await opener.click(); assert.deepEqual(await page.locator('.builder-type-view label').allInnerTexts(), ['Тип блока', 'Вид отображения']);
  assert.deepEqual(await page.locator('#page-builder-fields > .mb-3 label').allInnerTexts(), ['Заголовок', 'Причина непройденной визуальной проверки']);
  assert.equal(await page.locator('.modal-footer #builder-review-status').count(), 1);
  assert.doesNotMatch(await page.locator('#page-builder-fields').innerText(), /Mori|Принудительный|Описание карточки|Настройки|JSON/i);
  assert.deepEqual(await page.locator('#builder-type option').evaluateAll(nodes => nodes.map(node => node.value)), initial.blockTypes.map(type => type.name));
  await page.locator('#builder-type').selectOption('content');
  for (const type of initial.blockTypes) {
    await page.locator('#builder-type').selectOption(type.name);
    assert.deepEqual(await page.locator('#builder-view option').evaluateAll(nodes => nodes.map(node => node.value)), type.views);
    assert.equal(await page.locator('#builder-view').inputValue(), type.default_view);
    assert.equal(await page.locator('#builder-review-status').inputValue(), 'unreviewed');
    for (const name of new Set(initial.blockTypes.flatMap(item => item.fields.map(field => field.name)))) assert.equal(await page.locator(`#builder-${name}`).count(), Number(type.fields.some(field => field.name === name)), `${type.name}: only applicable scalar ${name}`);
    const structured = ['table', 'grid', 'data-table', 'links', 'sections'].includes(type.name);
    assert.equal(await page.locator('.builder-editor-placeholder').count(), Number(structured), `${type.name}: structured editor is explicitly unavailable`);
    assert.equal(await page.locator('#builder-add-image').count(), Number(['big-media', 'service', 'content'].includes(type.name)), `${type.name}: images only appear for supported media fields`);
    if (structured) {
      assert.equal(await page.locator('.builder-editor-placeholder img').getAttribute('src'), '/assets/astronaut.png');
      assert.deepEqual(await page.locator('.builder-text-fields legend').allInnerTexts(), ['Текст']);
      assert.equal(await page.getByLabel('Текст в Markdown', { exact: true }).count(), 1);
    }
  }
  await page.locator('#builder-type').selectOption('service'); await page.locator('#builder-view').selectOption('media-right'); await page.locator('#builder-badge').fill('Новинка');
  await page.locator('#builder-link').fill('https://example.org/service'); await page.locator('#builder-link_text').fill('Подробнее'); await page.locator('#builder-title').fill('Новая услуга');
  await page.getByRole('button', { name: 'Удалить изображение 1', exact: true }).click();
  for (const name of ['first', 'second']) {
    await page.locator('#builder-add-image').click(); const row = page.locator('.builder-image-row').last();
    await selectImage(row, 'основную', path.join(imageDirectory, imageName)); await selectImage(row, 'большую', path.join(imageDirectory, imageName));
    await row.getByLabel('Ссылка изображения', { exact: true }).fill(`/${name}`); await row.getByLabel('Альтернативный текст', { exact: true }).fill(name); await row.getByLabel('Подпись', { exact: true }).fill(`Caption ${name}`);
  }
  const mediaIds = await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)); assert.ok(mediaIds.every(id => /^media-[a-f0-9-]{36}$/.test(id)));
  assert.equal(await page.locator('.builder-image-row img').count(), 4, 'both browser selections preview immediately before save');
  await page.locator(`.builder-image-row[data-media-id="${mediaIds[1]}"] .builder-media-drag`).focus(); await page.keyboard.press('ArrowUp');
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), [...mediaIds].reverse());
  await page.locator(`.builder-image-row[data-media-id="${mediaIds[0]}"] .builder-media-drag`).dragTo(page.locator(`.builder-image-row[data-media-id="${mediaIds[1]}"]`), { targetPosition: { x: 25, y: 5 } });
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), mediaIds, 'native image DnD restores first/second order');
  await page.locator('#builder-review-status').selectOption('passed'); await page.locator('.builder-image-row').first().getByLabel('Подпись', { exact: true }).fill('Изменена подпись'); assert.equal(await page.locator('#builder-review-status').inputValue(), 'unreviewed');
  for (const width of [1440, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); assert.equal(await modal.evaluate(node => { const box = node.querySelector('.modal-dialog').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && node.querySelector('.modal-body').scrollWidth <= node.querySelector('.modal-body').clientWidth; }), true, `${width}: canonical/media editor fits the modal`);
    const selectors = await page.locator('.builder-type-view').evaluate(node => { const [type, view] = [...node.querySelectorAll('select')].map(item => item.getBoundingClientRect()); return { sameRow: Math.abs(type.top - view.top) < 1, fits: view.right <= node.getBoundingClientRect().right + 1, separate: type.right <= view.left, labelsFit: [...node.querySelectorAll('label')].every(label => label.scrollWidth <= label.clientWidth) }; });
    assert.equal(selectors.sameRow, true, `${width}: type/view selectors stay in one row`); assert.equal(selectors.fits, true); assert.equal(selectors.separate, true); assert.equal(selectors.labelsFit, true);
    if ([1440, 320].includes(width)) {
      await page.locator('#builder-type').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(testOutput(), `ui-stage-three-editor-${width}.png`) });
      await page.locator('.builder-image-row').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(testOutput(), `ui-stage-three-media-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1100 }); await page.locator('#builder-review-status').selectOption('passed'); await page.locator('#page-builder-save').click(); await close();
  const saved = queue.pageBuilder.read(job.id), block = saved.document.common.blocks[0]; assert.equal(saved.revision, 2); assert.equal(block.type, 'service'); assert.equal(block.view, 'media-right'); assert.equal(block.badge, 'Новинка'); assert.equal(block.review.status, 'passed'); assert.deepEqual(block.media.map(item => item.id), mediaIds);
  assert.equal(block.media[0].bigUrl, savedAsset.originalUrl); assert.equal(block.media[0].bigMedia.sha256, block.media[0].originalMedia.sha256); assert.equal(block.media[0].href, '/first'); assert.equal(block.media[0].caption, 'Изменена подпись');
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)'); await opener.click();
  assert.equal(await page.locator('#builder-type').inputValue(), 'service'); assert.equal(await page.locator('#builder-view').inputValue(), 'media-right'); assert.equal(await page.locator('#builder-badge').inputValue(), 'Новинка');
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), mediaIds);
  await page.getByRole('button', { name: 'Удалить изображение 2', exact: true }).click(); await page.locator('#page-builder-save').click(); await close(); assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].media.length, 1); assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].review.status, 'unreviewed');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});

test('replacing the original image updates the card and reopened editor before reload', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-original-preview-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  const job = queue.jobs[0]; seedMoriPage(queue, job);
  const initial = queue.pageBuilder.read(job.id), asset = initial.document.common.blocks[0].media[0], attempt = job.attempts[0];
  const replacementUrl = new URL('/replacement.png', job.url).href;
  const manifest = queue.stage.media.create(job, attempt, Buffer.from(`<img src="${asset.originalUrl}"><img src="${replacementUrl}">`), 'test');
  const oldImage = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const newImage = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#0000ff' } }).png().toBuffer();
  const imageDirectory = queue.stage.media.directory(job, attempt);
  for (const [url, bytes] of [[asset.originalUrl, oldImage], [replacementUrl, newImage]]) {
    const resource = manifest.resources.find(item => item.originalUrl === url), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.ok(resource, `manifest contains ${url}`);
    fs.writeFileSync(path.join(imageDirectory, 'objects', sha256), bytes);
    Object.assign(resource, { status: 'downloaded', finalUrl: url, redirects: [], mime: 'image/png', bytes: bytes.length, sha256, object: `objects/${sha256}` });
    queue.stage.media.publishImage(job, attempt, resource);
  }
  queue.stage.media.publish(job, attempt, manifest);
  Object.assign(attempt, { status: 'complete', captureStatus: 'complete' }); attempt.htmlMedia.status = 'complete'; queue.save();
  queue.mediaPicker.openDialog = async directory => path.join(directory, fs.readdirSync(directory).find(name => name.startsWith('replacement-')));
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`;
  const pixel = image => image.evaluate(async element => {
    await element.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(element, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const opener = page.locator('[data-builder-id="common-hero"]'), cardImage = opener.locator('.builder-media-preview img').first();
  assert.deepEqual(await pixel(cardImage), [255, 0, 0, 255]);
  const before = await cardImage.elementHandle();
  await opener.click(); await page.waitForFunction(() => !document.getElementById('builder-media-common-hero-media-originalUrl-choose')?.disabled);
  const picked = page.waitForResponse(response => response.url().endsWith('/pick-prepared-media'));
  await page.getByRole('button', { name: 'Выбрать основную картинку из шага 2' }).click(); assert.equal((await picked).status(), 200);
  await page.waitForFunction(() => !document.getElementById('page-builder-save').disabled);
  assert.deepEqual(await pixel(page.locator('.builder-image-previews figure img').first()), [0, 0, 255, 255], 'draft previews the selected image');
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/page-builder/${job.id}`);
  await page.locator('#page-builder-save').click(); assert.equal((await saved).status(), 200);
  await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForFunction(node => !node.isConnected, before);
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].media[0].originalMedia.sha256, crypto.createHash('sha256').update(newImage).digest('hex'));
  assert.deepEqual(await pixel(cardImage), [0, 0, 255, 255], 'card shows the saved image immediately');
  await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.deepEqual(await pixel(page.locator('.builder-image-previews figure img').first()), [0, 0, 255, 255], 'reopened editor shows the saved image without reload');
});

test('media selection is immediately available when switching grid gallery to content', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-late-media-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0];
  seedMoriPage(queue, job);
  installLocalPreview(queue, job, queue.pageBuilder.read(job.id).document.common.blocks[0].media[0]);
  const stored = queue.pageBuilder.read(job.id), grid = structuredClone(stored.document);
  Object.assign(grid.common.blocks[0], { type: 'grid', view: 'gallery' }); queue.pageBuilder.write(job.id, stored.revision, grid);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`; let preparations = 0;
  page.on('request', request => { if (request.url().endsWith('/prepare-media')) preparations++; });
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator('[data-builder-id="common-hero"]').click(); assert.equal(await page.locator('#builder-type').inputValue(), 'grid');
  assert.equal(preparations, 0, 'grid gallery has not rendered image fields');
  await page.locator('#builder-type').selectOption('content');
  assert.equal(await page.getByRole('button', { name: 'Выбрать основную картинку из шага 2' }).isDisabled(), false);
  assert.equal(preparations, 0);
  await page.locator('#builder-type').selectOption('grid'); await page.locator('#builder-type').selectOption('content');
  assert.equal(preparations, 0, 'rerendering image fields does not prepare media');
  const directory = path.join(queue.stage.media.directory(job, job.attempts[0]), 'images'), filename = fs.readdirSync(directory)[0];
  queue.mediaPicker.openDialog = async () => path.join(directory, filename);
  const picked = page.waitForResponse(response => response.url().endsWith('/pick-prepared-media'));
  await page.getByRole('button', { name: 'Выбрать основную картинку из шага 2' }).click(); assert.equal((await picked).status(), 200);
  assert.equal(preparations, 0);
});

test('step 3 type and view changes keep drafts and explain unfinished structured editors', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-fields-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const original = queue.pageBuilder.read(job.id), opener = page.locator('[data-builder-id="common-hero"]');
  const close = async () => { await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); };
  await page.evaluate(() => { window.builderFieldsShown = new Promise(resolve => document.getElementById('page-builder-modal').addEventListener('shown.bs.modal', resolve, { once: true })); });
  await opener.click();
  await page.evaluate(() => window.builderFieldsShown.then(() => true));
  assert.deepEqual(await page.locator('#builder-type option').allTextContents(), original.blockTypes.map(type => type.label));
  for (const type of original.blockTypes) {
    await page.locator('#builder-type').selectOption(type.name);
    for (const view of type.views) {
      await page.locator('#builder-view').focus();
      await page.locator('#builder-view').selectOption(view);
      assert.match(await page.locator('#builder-view option:checked').innerText(), /[А-Яа-я]/, `${type.name}/${view}: descriptive Russian view name`);
      assert.equal(await page.locator('#builder-view').evaluate(node => node === document.activeElement), true, 'changing view keeps the selector focused');
      if (['table', 'grid', 'data-table', 'links', 'sections'].includes(type.name)) assert.match(await page.locator('.builder-editor-placeholder').innerText(), /Редактор содержимого в разработке[\s\S]+пока недоступно/);
    }
  }
  await page.locator('#builder-type').selectOption('service'); await page.locator('#builder-badge').fill('Черновик метки'); await page.locator('#builder-content').fill('Черновик текста');
  await page.locator('#builder-view').selectOption('media-left'); assert.equal(await page.locator('#builder-images-title').innerText(), 'Изображения слева');
  await page.locator('#builder-view').selectOption('media-right'); assert.equal(await page.locator('#builder-images-title').innerText(), 'Изображения справа');
  assert.equal(await page.locator('#builder-badge').inputValue(), 'Черновик метки'); assert.equal(await page.locator('#builder-content').inputValue(), 'Черновик текста');
  await page.locator('#builder-type').selectOption('embed'); await page.locator('#builder-ratio').selectOption('4:3'); await page.locator('#builder-source_url').fill('https://example.org/map');
  assert.deepEqual(await page.locator('#builder-provider option').allTextContents(), ['Не задано', 'Виджет (iframe)', 'Карта', 'Видео', 'Другой источник']);
  await page.locator('#builder-view').selectOption('map'); assert.equal(await page.locator('#builder-ratio').count(), 0); assert.equal(await page.getByLabel('URL карты', { exact: true }).inputValue(), 'https://example.org/map');
  await page.locator('#builder-view').selectOption('wide'); assert.equal(await page.locator('#builder-ratio').inputValue(), '4:3');
  await page.locator('#builder-type').selectOption('rich-content'); assert.equal(await page.getByLabel('HTML-код', { exact: true }).count(), 1); assert.equal(await page.getByLabel('Обоснование использования HTML', { exact: true }).getAttribute('required'), null);
  await page.locator('#builder-type').selectOption('service'); assert.equal(await page.locator('#builder-view').inputValue(), 'default'); assert.equal(await page.locator('#builder-badge').inputValue(), 'Черновик метки');
  assert.equal(await page.locator('.builder-image-row').count(), original.document.common.blocks[0].media.length, 'hidden media survives type/view switches');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close(); assert.deepEqual(queue.pageBuilder.read(job.id), original, 'type and view exploration never writes data');
  // A legacy structured block can still update its real common fields and review;
  // its existing text, media and settings are not replaced by pretend rows/items.
  const structured = structuredClone(original.document); Object.assign(structured.common.blocks[0], { type: 'grid', view: 'gallery' }); queue.pageBuilder.write(job.id, original.revision, structured);
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)'); await opener.click();
  assert.equal(await page.locator('.builder-editor-placeholder img').getAttribute('src'), '/assets/astronaut.png'); assert.equal(await page.locator('#builder-add-image').count(), 0);
  for (const width of [1440, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await page.locator('.builder-editor-placeholder').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#page-builder-modal .modal-body').evaluate(node => node.scrollWidth <= node.clientWidth), true, `${width}: placeholder has no horizontal overflow`);
    if ([1440, 320].includes(width)) await page.screenshot({ path: path.join(testOutput(), `ui-stage-three-placeholder-${width}.png`) });
  }
  await page.locator('#builder-title').fill('Галерея с новым заголовком'); await page.locator('#builder-review-status').selectOption('passed'); await page.locator('#page-builder-save').click(); await close();
  const saved = queue.pageBuilder.read(job.id).document.common.blocks[0];
  assert.equal(saved.review.status, 'passed'); assert.equal(saved.title, 'Галерея с новым заголовком');
  for (const field of ['text', 'content', 'settings', 'media']) assert.deepEqual(saved[field], original.document.common.blocks[0][field], `${field} survives a structured block edit`);
  assert.deepEqual(errors, []);
});

test('step 3 Markdown editor preserves source, optional fields, safe previews and footer keyboard geometry', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-markdown-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  const stored = queue.pageBuilder.read(job.id); stored.document.common.blocks[0].description = 'RETired description never shown';
  fs.writeFileSync(queue.pageBuilder.file(job.id), JSON.stringify(stored));
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], external = [], posts = [], origin = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); if (request.method() === 'POST') posts.push(request); });
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const opener = page.locator('[data-builder-id="common-hero"]'), close = async () => { await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); };
  assert.doesNotMatch(await opener.innerText(), /RETired/); await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('#page-builder-modal [required]').count(), 0);
  assert.deepEqual(await page.locator('.builder-link-fields legend').allInnerTexts(), ['Ссылка']);
  assert.equal(await page.locator('.builder-link-fields label').count(), 0);
  assert.equal(await page.getByLabel('URL', { exact: true }).count(), 1);
  assert.equal(await page.getByLabel('Текст ссылки', { exact: true }).count(), 1);
  assert.equal(await page.locator('#builder-link').getAttribute('placeholder'), 'URL');
  assert.equal(await page.locator('#builder-link_text').getAttribute('placeholder'), 'Текст ссылки');
  assert.deepEqual(await page.locator('.builder-text-fields legend').allInnerTexts(), ['Текст']);
  assert.equal(await page.locator('.builder-text-fields label, .builder-markdown .form-label, #builder-markdown-help').count(), 0);
  assert.equal(await page.locator('#builder-content').getAttribute('placeholder'), 'Текст в Markdown');
  assert.equal(await page.getByLabel('Текст в Markdown').count(), 1);
  assert.equal(await page.getByRole('region', { name: 'Предпросмотр Markdown' }).count(), 1);
  assert.equal(await page.locator('.builder-markdown').getByText('Предпросмотр', { exact: true }).count(), 0);
  assert.equal(await page.locator('.builder-markdown-tools').getByRole('button', { name: 'Код', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Маркированный список', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Список', exact: true }).count(), 0);
  await page.locator('#builder-content').fill(''); await page.getByRole('button', { name: 'Маркированный список', exact: true }).click();
  assert.equal(await page.locator('#builder-content').inputValue(), '- Пункт'); assert.equal(await page.locator('#builder-markdown-preview ul li').innerText(), 'Пункт');
  await page.locator('#builder-content').fill(''); await page.getByRole('button', { name: 'Нумерованный список', exact: true }).click();
  assert.equal(await page.locator('#builder-content').inputValue(), '1. Пункт'); assert.equal(await page.locator('#builder-markdown-preview ol li').innerText(), 'Пункт');
  const markdown = '# Заголовок\n\n**Жирный** и *курсив*\n- Первый\n- Второй\n\n[Каталог](https://example.org/catalog)\n![фото](https://example.org/image.png)\n[опасно](javascript:alert%281%29) [data](data:text/html,bad)\n<script>window.markdownPwned=1</script>\n<img src="https://example.org/raw.png" onerror="window.markdownPwned=2">\n\n```html\n<b>код</b>\n```';
  await page.locator('#builder-content').fill(markdown);
  const preview = page.locator('#builder-markdown-preview');
  assert.equal(await preview.locator('h1').innerText(), 'Заголовок'); assert.equal(await preview.locator('strong').innerText(), 'Жирный'); assert.deepEqual(await preview.locator('li').allInnerTexts(), ['Первый', 'Второй']);
  assert.equal(await preview.locator('a').count(), 1); assert.equal(await preview.locator('a').getAttribute('href'), 'https://example.org/catalog');
  assert.equal(await preview.locator('img,script,iframe,object,embed,style').count(), 0); assert.match(await preview.innerText(), /<script>window.markdownPwned=1<\/script>/);
  assert.equal(await page.evaluate(() => window.markdownPwned), undefined);
  await page.locator('#builder-view').selectOption('compact'); assert.equal(await page.locator('#builder-content').inputValue(), markdown);
  await page.locator('#builder-type').selectOption('rich-content'); assert.equal(await preview.count(), 0); assert.equal(await page.getByLabel('HTML-код', { exact: true }).inputValue(), markdown);
  await page.locator('#builder-type').selectOption('content'); assert.equal(await page.locator('#builder-content').inputValue(), markdown);
  await page.locator('#builder-content').fill('выделение'); await page.locator('#builder-content').press('Control+a'); await page.keyboard.press('Control+b'); assert.equal(await page.locator('#builder-content').inputValue(), '**выделение**');
  assert.equal(await page.locator('#builder-content').evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Tab'); assert.equal(await page.locator('#builder-content').evaluate(node => document.activeElement !== node), true, 'Tab leaves source editor normally');
  await page.locator('#builder-content').fill(markdown); await page.locator('#builder-title').fill('');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator('#page-builder-modal').evaluate(modal => {
      const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      const footer = modal.querySelector('.modal-footer'), status = modal.querySelector('#builder-review-status'), cancel = footer.querySelector('[data-bs-dismiss]'), save = modal.querySelector('#page-builder-save');
      const link = box(modal.querySelector('#builder-link')), linkText = box(modal.querySelector('#builder-link_text')), source = box(modal.querySelector('#builder-content')), preview = box(modal.querySelector('#builder-markdown-preview'));
      return { footer: box(footer), status: box(status), cancel: box(cancel), save: box(save), linkGap: linkText.top - link.bottom, previewGap: preview.top - source.bottom, overflow: modal.querySelector('.modal-body').scrollWidth > modal.querySelector('.modal-body').clientWidth };
    });
    assert.equal(geometry.overflow, false, `${width}: no horizontal form overflow`); assert.ok(geometry.status.left >= 0 && geometry.save.right <= width && geometry.status.right <= geometry.cancel.left, `${width}: footer controls fit without overlap`);
    assert.ok(Math.abs(geometry.linkGap - geometry.previewGap) < 1, `${width}: link inputs and Markdown preview have equal vertical gaps`);
    assert.ok(Math.abs(geometry.status.bottom - geometry.save.bottom) < 2, `${width}: review and buttons share baseline`);
    await page.locator('#builder-review-status').focus(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Отмена'); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'page-builder-save');
    await page.locator('#builder-content').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(testOutput(), `ui-stage-three-markdown-${width}.png`) });
  }
  await page.locator('#builder-review-status').selectOption('failed'); assert.equal(await page.locator('#builder-review-reason').isVisible(), true); assert.equal(await page.locator('#builder-review-reason').evaluate(node => node.required), true);
  assert.equal(await page.locator('#builder-review-reason').getAttribute('placeholder'), 'Что не так с блоком или какие правки нужны?');
  const beforeFailure = posts.length; await page.locator('#page-builder-save').click(); assert.equal(posts.length, beforeFailure); assert.equal(await page.evaluate(() => document.activeElement.id), 'builder-review-reason');
  await page.locator('#builder-review-reason').fill('Исправить отступы'); await page.locator('#builder-review-status').selectOption('passed'); assert.equal(await page.locator('#builder-review-reason').isVisible(), false); assert.equal(await page.locator('#builder-review-reason').inputValue(), '');
  await page.locator('#page-builder-save').click(); await close(); assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].text, markdown);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(queue.pageBuilder.file(job.id))).document.common.blocks[0], 'description'), false);
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const excerpt = await opener.locator('.builder-text-preview').innerText(); assert.match(excerpt, /Заголовок Жирный и курсив Первый Второй Каталог фото/); assert.doesNotMatch(excerpt, /RETired|\*\*|#|<script>|<img|https:\/\/|javascript:/); assert.match(await opener.innerText(), /Без заголовка/);
  await opener.click(); assert.equal(await page.locator('#builder-content').inputValue(), markdown);
  await page.locator('#builder-type').selectOption('rich-content'); await page.locator('#builder-content').fill(''); await page.locator('#builder-reason').fill(''); await page.locator('#page-builder-save').click(); await close(); assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].text, '');
  await opener.click(); await page.waitForFunction(() => document.activeElement?.closest('#page-builder-modal')); await page.keyboard.press('Escape'); await close(); assert.equal(await page.evaluate(() => document.activeElement.dataset.builderId), 'common-hero');
  await page.locator('[data-add-section="common"]').click(); await page.locator('#builder-add-image').click(); await page.locator('#page-builder-save').click(); await close();
  const blank = queue.pageBuilder.read(job.id).document.common.blocks.at(-1); assert.equal(blank.title, ''); assert.equal(blank.text, ''); assert.equal(blank.media[0].originalUrl, '');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});

test('step 3 native block drag keeps its source during a poll between pointerdown and dragstart', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-drag-poll-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  seedMoriPage(queue, queue.jobs[0]);
  const job = queue.jobs[0]; Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  // Exercise modal scroll/focus restoration before the pointer sequence, as in the original regression.
  await page.locator('.builder-block-open').first().click(); await page.locator('#builder-add-image').scrollIntoViewIfNeeded(); await page.keyboard.press('Escape');
  await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  const handle = page.getByRole('button', { name: 'Перетащить блок: MORI CINEMA', exact: true }); await handle.scrollIntoViewIfNeeded();
  let announceRead, releaseRead; const readStarted = new Promise(resolve => { announceRead = resolve; }), readGate = new Promise(resolve => { releaseRead = resolve; });
  const pattern = `**/api/page-builder/${job.id}?attempt=*`;
  await page.route(pattern, async route => { if (route.request().method() !== 'GET') return route.continue(); const response = await route.fetch(); announceRead(); await readGate; await route.fulfill({ response }); });
  const external = queue.pageBuilder.read(job.id); external.document.tabs[0].blocks[0].title = 'Внешнее изменение при нажатой ручке'; queue.pageBuilder.write(job.id, external.revision, external.document);
  await readStarted;
  const source = await handle.elementHandle(), box = await handle.boundingBox(), target = await page.locator('#builder-tab-posters').boundingBox();
  await handle.evaluate(node => { window.nativeBuilderDrags = 0; node.addEventListener('dragstart', () => { window.nativeBuilderDrags++; }); });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  const readFinished = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/page-builder/${job.id}`); releaseRead(); await readFinished;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await source.evaluate(node => node.isConnected), true, 'the in-flight response cannot detach the pressed native drag source');
  const rejectedDrop = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/page-builder/${job.id}`);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 }); await page.mouse.move(target.x + target.width / 2 + 1, target.y + target.height / 2); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.nativeBuilderDrags), 1, 'real mouse movement starts one native drag after the delayed read');
  assert.equal((await rejectedDrop).status(), 409, 'fencing rendering never weakens CAS for the stale drop');
  await page.waitForFunction(() => !document.querySelector('#page-builder-content').hasAttribute('aria-busy') && !document.querySelector('#page-builder-error').classList.contains('d-none'));
  assert.match(await page.locator('#page-builder-error').innerText(), /уже изменены/); assert.equal(await page.evaluate(() => document.activeElement?.dataset.builderId), 'common-hero');
  assert.equal(queue.pageBuilder.read(job.id).revision, 2); assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].id, 'common-hero');
});

test('step 3 structural CAS errors remain visible and preserve focus after reconciliation and polling', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-conflict-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  seedMoriPage(queue, queue.jobs[0]);
  const job = queue.jobs[0]; Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const pattern = `**/api/page-builder/${job.id}?attempt=*`;
  async function conflict(action, externalEdit) {
    const handler = async route => {
      if (route.request().method() === 'POST') { const current = queue.pageBuilder.read(job.id), changed = structuredClone(current.document); externalEdit(changed); queue.pageBuilder.write(job.id, current.revision, changed); }
      await route.continue();
    };
    await page.route(pattern, handler);
    const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/page-builder/${job.id}`);
    await action(); assert.equal((await response).status(), 409);
    await page.waitForFunction(() => !document.querySelector('#page-builder-content').hasAttribute('aria-busy') && document.querySelector('#page-builder-error').textContent.includes('уже изменены'));
    await page.unroute(pattern, handler);
    assert.equal(await page.locator('#page-builder-error').isVisible(), true);
  }
  await page.getByRole('button', { name: 'Перетащить блок: MORI CINEMA', exact: true }).click();
  await conflict(() => page.getByRole('button', { name: 'Ниже: MORI CINEMA', exact: true }).click(), doc => { doc.common.blocks[0].title = 'Баннер изменён извне'; });
  assert.equal(queue.pageBuilder.read(job.id).revision, 2);
  assert.deepEqual(queue.pageBuilder.read(job.id).document.common.blocks.map(block => block.id), ['common-hero', 'common-actions'], 'rejected reorder never reaches disk');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.builderId), 'common-hero');
  // A later ordinary poll must neither clear the error nor destroy the focused node's identity.
  await page.evaluate(() => {
    const box = document.querySelector('#page-builder-error'); window.builderErrorHidden = false;
    window.builderErrorObserver = new MutationObserver(records => { if (box.classList.contains('d-none') || records.some(record => /\bd-none\b/.test(record.oldValue || ''))) window.builderErrorHidden = true; });
    window.builderErrorObserver.observe(box, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  });
  const external = queue.pageBuilder.read(job.id); external.document.common.blocks[0].title = 'Обновлено ещё раз'; queue.pageBuilder.write(job.id, external.revision, external.document);
  await page.waitForSelector('.builder-block-open[aria-label^="Обновлено ещё раз"]');
  assert.equal(await page.locator('#page-builder-error').isVisible(), true); assert.match(await page.locator('#page-builder-error').innerText(), /уже изменены/);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.builderId), 'common-hero');
  assert.equal(await page.evaluate(() => { window.builderErrorObserver.disconnect(); return window.builderErrorHidden; }), false, 're-render never transiently hides the visible conflict');
  await page.getByRole('button', { name: 'Перетащить блок: Быстрые действия', exact: true }).click();
  await conflict(() => page.getByLabel('Перенести блок: Быстрые действия', { exact: true }).selectOption('news'), doc => { doc.common.blocks = doc.common.blocks.filter(block => block.id !== 'common-actions'); });
  assert.equal(queue.pageBuilder.read(job.id).revision, 4);
  assert.equal(queue.pageBuilder.read(job.id).document.tabs[0].blocks.some(block => block.id === 'common-actions'), false, 'rejected transfer does not resurrect an externally deleted block');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.addSection), 'common', 'missing block falls back to its original section add button');
  await page.waitForRequest(request => new URL(request.url()).pathname === '/api/state');
  assert.equal(await page.locator('#page-builder-error').isVisible(), true); assert.equal(await page.evaluate(() => document.activeElement?.dataset.addSection), 'common');
  assert.deepEqual(errors, []);
});

test('queue action loading survives a stale poll and waits for the next ordinary snapshot without an eager GET', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-action-poll-race-'));
  const queue = new Queue({ root, autoStart: false, spawnFn() { throw new Error('UI action race test must not spawn agents'); } });
  queue.add('https://action-race.reestr35.ru/');
  const job = queue.jobs[0];
  job.attempts[0].status = 'needs_review';
  queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => {
    await browser.close(); await queue.shutdown();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  let stateRequests = 0, staleRoute, staleResponse, announceStale;
  const staleStarted = new Promise(resolve => { announceStale = resolve; });
  await page.route('**/api/state', async route => {
    stateRequests++;
    const response = await route.fetch(), snapshot = await response.json();
    const projected = snapshot.jobs.find(item => item.id === job.id);
    if (projected) projected.canRecapture = true;
    if (stateRequests === 2) {
      staleRoute = route;
      staleResponse = { response, snapshot };
      announceStale();
      return;
    }
    await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(snapshot) });
  });
  let actionRoute, announceAction, actionPosts = 0;
  const actionStarted = new Promise(resolve => { announceAction = resolve; });
  await page.route(`**/api/jobs/${job.id}/retry`, route => {
    actionPosts++;
    actionRoute = route;
    announceAction();
  });
  await page.goto(origin);
  const primary = page.locator(`[data-job-action="${job.id}"]`);
  const secondary = page.locator('#recapture-button');
  await page.waitForFunction(id => document.querySelector(`[data-job-action="${id}"]`)?.dataset.action === 'retry', job.id);
  await page.locator(`[data-job-id="${job.id}"]`).evaluate(row => row.click());
  await staleStarted;
  await primary.click();
  await actionStarted;
  assert.equal(await primary.getAttribute('aria-busy'), 'true', 'the clicked action becomes busy before its POST settles');
  assert.equal(await primary.isDisabled(), true);
  assert.equal(await primary.evaluate(node => getComputedStyle(node).opacity), '1', 'pending action keeps its indicator opaque');
  assert.equal(await primary.locator('svg').evaluate(node => getComputedStyle(node).visibility), 'visible');
  assert.equal((await primary.getAttribute('title')).split(' · ')[1], 'Недоступно');
  assert.equal(await secondary.isDisabled(), true, 'all actions for the same job are fenced while one is pending');
  await primary.evaluate(node => { node.click(); node.click(); });
  assert.equal(actionPosts, 1, 'pending state fences repeated programmatic clicks');
  const accepted = page.waitForResponse(response => response.url() === `${origin}/api/jobs/${job.id}/retry`);
  await actionRoute.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  await accepted;
  await page.waitForTimeout(50);
  await staleRoute.fulfill({ response: staleResponse.response, contentType: 'application/json', body: JSON.stringify(staleResponse.snapshot) });
  await page.waitForTimeout(250);
  assert.equal(stateRequests, 2, 'the colliding action does not queue an immediate second state refresh');
  assert.equal(await primary.getAttribute('aria-busy'), 'true', 'the pre-POST snapshot cannot clear pending action');
  await page.waitForResponse(response => response.url() === `${origin}/api/state` && stateRequests >= 3);
  await page.waitForFunction(id => document.querySelector(`[data-job-action="${id}"]`)?.getAttribute('aria-busy') === 'false', job.id);
  assert.equal(stateRequests, 3, 'the next ordinary poll supplies the single confirming snapshot');
  assert.equal(await primary.getAttribute('aria-busy'), 'false');
  assert.equal(await primary.isEnabled(), true);
  assert.equal(await secondary.isEnabled(), true);
});

test('Tabler workspace, single URL, gallery, polling and responsive modal', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-arm-ui-'));
  const queue = new Queue({ root, autoStart: false, spawnFn() { throw new Error('UI tests must not spawn agents'); } });
  queue.add('https://mori-cinema.reestr35.ru/');
  const job = queue.jobs[0];
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=', 'base64');
  const names = ['00_header.png', '01_сегмент.png', '02_footer.png'];
  function artifacts(attempt, artifactNames, { status = 'cancelled', includeReport = true, finished = true, qaStatuses = [] } = {}) {
    const loc = layout(root, job, attempt);
    fs.mkdirSync(loc.hostDir, { recursive: true });
    for (const name of artifactNames) fs.writeFileSync(path.join(loc.hostDir, name), tinyPng);
    const report = { url: job.url, finalUrl: job.url, status: finished ? 'complete' : 'incomplete', errors: [], segments: artifactNames.map((file, i) => ({ file, status: i === 1 ? 'incomplete' : 'ok' })) };
    if (finished) report.finished = new Date().toISOString();
    if (includeReport) fs.writeFileSync(loc.report, JSON.stringify(report));
    fs.writeFileSync(path.join(loc.dir, 'events.jsonl'), '{"type":"fixture","note":"Тест без Codex"}\n');
    fs.writeFileSync(path.join(loc.dir, 'stderr.log'), 'Диагностический журнал fixture\n');
    const pngs = artifactNames.map((name, index) => ({ name, kind: 'png', segmentStatus: report.segments[index].status, qaStatus: qaStatuses[index] || 'unreviewed' }));
    const passed = pngs.filter(file => file.qaStatus === 'passed').length, issueCount = pngs.filter(file => file.qaStatus === 'issues').length;
    const segments = pngs.map(file => ({ name: file.name, status: file.qaStatus === 'unreviewed' ? 'pending' : file.qaStatus }));
    Object.assign(attempt, { status, files: [...(includeReport ? [{ name: 'capture-report.json', kind: 'report' }] : []), ...pngs], qa: { total: pngs.length, reviewed: passed + issueCount, passed, issues: issueCount, pending: pngs.length - passed - issueCount, unreviewed: pngs.length - passed - issueCount, segments }, summary: 'Тестовая попытка. Снимки сохранены, визуальная приёмка не подтверждена.', issues: ['Используются встроенные PNG-fixtures.'] });
    return { loc, report, names: artifactNames };
  }
  artifacts(job.attempts[0], names.slice(0, 1));
  const attempt = queue.newAttempt(job);
  let fixture = artifacts(attempt, names.slice(0, 1), { status: 'running', finished: false });
  attempt.files = [];
  delete attempt.qa;
  queue.save();
  const server = createServer(queue);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  let reportRequests = 0;
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  page.on('request', request => { if (request.method() === 'GET' && request.url().endsWith('/capture-report.json')) reportRequests++; });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function openFirstPng(keyboard = false) {
    const shown = page.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Modal show timeout: ${document.querySelector('#png-modal').className}`)), 5000);
      document.querySelector('#png-modal').addEventListener('shown.bs.modal', () => { clearTimeout(timer); resolve(); }, { once: true });
    }));
    if (keyboard) {
      await page.locator('#png-gallery button').first().focus();
      await page.keyboard.press('Enter');
    } else await page.locator('#png-gallery button').first().click();
    await shown;
  }
  await page.addInitScript(() => { window.copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; }, write: async items => { const blob = await items[0].getType('image/png'); window.copied = { type: blob.type, size: blob.size }; } } }); });
  async function closePng() {
    const hidden = page.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Modal hide timeout: ${document.querySelector('#png-modal').className}, focus=${document.activeElement.id}`)), 5000);
      document.querySelector('#png-modal').addEventListener('hidden.bs.modal', () => { clearTimeout(timer); resolve(); }, { once: true });
    }));
    await page.keyboard.press('Escape');
    await hidden;
  }
  fs.unlinkSync(path.join(fixture.loc.hostDir, names[0]));
  await page.goto(origin);
  await page.locator(`[data-job-id="${job.id}"]`).evaluate(row => row.click());
  assert.equal(await page.locator('#qa-progress').isVisible(), true, 'step 1 starts with a visible empty progress bar');
  assert.equal(await page.locator('#qa-progress-count').innerText(), '0/0');
  fs.writeFileSync(path.join(fixture.loc.hostDir, names[0]), tinyPng);
  await page.waitForFunction(() => document.querySelectorAll('#png-gallery img').length === 1);
  assert.equal(await page.locator('#png-gallery .image-status').getAttribute('aria-label'), 'Не проверено', 'an early PNG is visible before capture finishes');
  assert.equal(await page.locator('#qa-progress').isVisible(), true, 'QA indicator includes PNGs before the immutable manifest exists');
  assert.equal(await page.locator('#qa-progress-count').innerText(), '0/1');
  assert.equal(await page.locator('#qa-progress-count').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#files-list button').count(), 1);
  assert.equal(reportRequests, 0, 'gallery never reads the QA report in the background');
  fs.writeFileSync(path.join(fixture.loc.hostDir, names[1]), tinyPng);
  fixture.report.segments.push({ file: names[1], status: 'ok' });
  fs.writeFileSync(fixture.loc.report, JSON.stringify(fixture.report));
  await page.waitForFunction(() => document.querySelector('#qa-progress-count').textContent === '0/2');
  assert.equal(await page.locator('#qa-progress-bar').getAttribute('aria-valuenow'), '0', 'new captures increase the denominator without claiming QA completion');
  fixture = artifacts(attempt, names, { qaStatuses: ['passed', 'issues', 'unreviewed'] });
  attempt.workflow = 1;
  queue.save();
  await page.waitForFunction(() => document.querySelectorAll('#png-gallery .image-status').length === 3);
  assert.equal(await page.locator('#png-gallery img').count(), 3);
  assert.deepEqual(await page.locator('#png-gallery .image-status').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Проверено', 'Есть замечания', 'Не проверено']);
  assert.deepEqual(await page.locator('#png-gallery .image-status').allInnerTexts(), ['', '', '']);
  assert.equal(await page.locator('#png-gallery .badge').count(), 0, 'statuses are compact icons, not body badges');
  const statusGeometry = await page.locator('#png-gallery .image-status').first().evaluate(node => { const circle = node.getBoundingClientRect(), card = node.closest('.card').getBoundingClientRect(), style = getComputedStyle(node); return { width: circle.width, height: circle.height, top: circle.top - card.top, right: card.right - circle.right, color: style.color, background: style.backgroundColor, radius: style.borderRadius }; });
  assert.deepEqual(statusGeometry, { width: 24, height: 24, top: 9, right: 9, color: 'rgb(255, 255, 255)', background: 'color(srgb 0.184314 0.701961 0.266667)', radius: '50%' });
  const qaProgress = page.locator('#qa-progress-bar');
  const qaSegments = qaProgress.locator('.qa-progress-segment');
  const tooltipTexts = names.map((name, index) => `${index + 1} — ${name}`);
  assert.equal(await page.locator('#qa-progress-count').innerText(), '2/3');
  assert.deepEqual(await qaProgress.locator('.qa-progress-segment').evaluateAll(nodes => nodes.map(node => [node.dataset.qaName, node.dataset.qaStatus])), names.map((name, index) => [name, ['passed', 'issues', 'pending'][index]]));
  assert.deepEqual(await qaSegments.evaluateAll(nodes => nodes.map(node => node.dataset.qaTooltip)), tooltipTexts, 'tooltips follow immutable manifest order');
  assert.deepEqual(await qaSegments.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-hidden'))), ['true', 'true', 'true']);
  assert.deepEqual(await qaProgress.locator('.qa-progress-segment').evaluateAll(nodes => nodes.map(node => [...node.classList].find(name => /^bg-(green|red|secondary)$/.test(name)))), ['bg-green', 'bg-red', 'bg-secondary']);
  const segmentWidths = await qaProgress.locator('.qa-progress-segment').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  assert.ok(Math.max(...segmentWidths) - Math.min(...segmentWidths) < 0.02, 'manifest segments have equal widths');
  assert.equal(await qaProgress.getAttribute('role'), 'progressbar');
  assert.deepEqual(await Promise.all(['aria-valuemin', 'aria-valuemax', 'aria-valuenow'].map(name => qaProgress.getAttribute(name))), ['0', '100', '67']);
  assert.match(await qaProgress.getAttribute('aria-label'), /Проверено 2 из 3 PNG: без замечаний 1, с замечаниями 1, ожидают проверки 1/);
  assert.equal(await page.locator('#qa-progress').evaluate(node => node.parentElement.id), 'attempt-header');
  const attemptHeaderPositions = await page.locator('#attempt-controls, #qa-progress').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; }));
  const attemptHeaderInner = await page.locator('#attempt-header').evaluate(node => { const box = node.getBoundingClientRect(), style = getComputedStyle(node); return { left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) }; });
  assert.ok(attemptHeaderPositions[0].bottom < attemptHeaderPositions[1].top, 'QA progress occupies a separate row below the attempt controls');
  assert.ok(Math.abs(attemptHeaderPositions[1].left - attemptHeaderInner.left) <= 1 && Math.abs(attemptHeaderPositions[1].right - attemptHeaderInner.right) <= 1, 'QA progress uses the full header width');
  const liveAttemptControlBoxes = await page.locator('#detail-url, #attempt-controls > *').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; }));
  const liveAttemptControlGaps = [liveAttemptControlBoxes[1].left - liveAttemptControlBoxes[0].right, liveAttemptControlBoxes[2].left - liveAttemptControlBoxes[1].right];
  assert.ok(Math.abs(liveAttemptControlGaps[0] - liveAttemptControlGaps[1]) <= .5, 'URL, time and restart retain equal visible spacing');
  await page.locator('#stage-step-1').click();
  attempt.status = 'complete'; queue.save();
  await page.waitForFunction(() => document.querySelector('#stage-step-2').getAttribute('aria-disabled') === 'false');
  assert.equal(await page.locator('#stage-step-1').getAttribute('aria-selected'), 'true', 'manual step 1 survives a poll that unlocks step 2');
  assert.equal(await page.locator('#qa-progress').isVisible(), true);
  await page.locator('#stage-step-2').click();
  assert.equal(await page.locator('#qa-progress').isHidden(), true, 'QA progress is hidden on step 2');
  assert.equal(await page.locator('#recapture-button').isVisible(), true, 'restart stays visible on step 2');
  await page.locator('#stage-step-1').click();
  assert.equal(await page.locator('#qa-progress').isVisible(), true, 'QA progress returns with step 1');
  attempt.status = 'cancelled'; queue.save();
  await page.waitForFunction(() => document.querySelector('#stage-step-2').getAttribute('aria-disabled') === 'true');
  await qaSegments.first().hover();
  const tooltip = page.locator('.tooltip.show');
  await tooltip.waitFor({ state: 'visible' });
  assert.equal(await tooltip.innerText(), tooltipTexts[0]);
  assert.equal(await page.locator('.tooltip').count(), 1, 'hover creates exactly one tooltip');
  await page.mouse.move(0, 0);
  await tooltip.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#files-list button').count(), 1);
  assert.match(await page.locator('#files-list').innerText(), /capture-report.json/);
  const columns = await page.locator('#workspace > section').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }));
  assert.equal(columns.length, 2);
  assert.equal(new Set(columns.map(item => Math.round(item.y))).size, 1);
  assert.ok(columns[0].x < columns[1].x);
  assert.ok(Math.abs(columns[1].width / columns[0].width - 2) < 0.02, 'left/results use the standard 4/8 grid');
  assert.equal(await page.locator('.page-header').count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /Локальное АРМ|Снимки legacy-страниц/);
  for (const id of ['batch-form', 'progress-bar', 'concurrency-slider', 'jobs-body']) assert.equal(await page.locator(`#left-column #${id}`).count(), 1);
  assert.equal(await page.locator('#left-column #logs-card').count(), 0);
  assert.equal(await page.locator('#results-column #logs-card').count(), 1);
  assert.equal(await page.locator('#left-column .card').count(), 1);
  assert.equal(await page.locator('#left-column .card-header').count(), 0);
  assert.deepEqual(await page.locator('#queue-progress > div:first-child > *').evaluateAll(nodes => nodes.map(node => ({ tag: node.tagName, text: node.textContent.trim(), id: node.id, badge: node.classList.contains('badge') }))), [
    { tag: 'SPAN', text: 'Прогресс', id: '', badge: false },
    { tag: 'OUTPUT', text: '0 / 1', id: 'progress-label', badge: true },
  ], 'task progress uses the same label/value row pattern as concurrency');
  assert.ok(Math.abs(await page.locator('#concurrency-label-row, #concurrency-slider').evaluateAll(nodes => nodes[1].getBoundingClientRect().top - nodes[0].getBoundingClientRect().bottom) - 4) <= .5, 'concurrency label row has a four-pixel gap before the range track');
  const leftOrder = await page.locator('#batch-form, #queue-progress, #jobs-body').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
  assert.ok(leftOrder[0] < leftOrder[1] && leftOrder[1] < leftOrder[2]);
  const queueDivider = page.locator('#queue-progress + .job-table-wrap');
  assert.equal(await queueDivider.getAttribute('class').then(value => value.split(/\s+/).includes('border-top')), true);
  assert.equal(await queueDivider.evaluate(node => getComputedStyle(node).borderTopWidth), '1px');
  assert.equal(await page.locator('#settings-error').evaluate(node => node.parentElement.id), 'queue-progress', 'settings errors stay above the queue divider');
  async function assertGalleryFirst() {
    assert.equal(await page.locator('#job-detail.card').count(), 0);
    assert.equal(await page.locator('#job-detail > div > .card').count(), 1);
    assert.deepEqual(await page.locator('#results-card > *').evaluateAll(nodes => nodes.map(node => node.id)), ['results-header', 'attempt-header', 'gallery-body', 'stage-two-panel', 'stage-three-panel']);
    for (const id of ['attempt-duration', 'recapture-button']) assert.equal(await page.locator(`#results-header #${id}`).count(), 1);
    assert.equal(await page.locator('#results-header #attempt-select').count(), 0);
    assert.equal(await page.locator('#technical-area #attempt-select').isVisible(), true);
    assert.equal(await page.locator('#attempt-controls > #recapture-button').count(), 1);
    assert.equal(await page.locator('#attempt-controls').evaluate(node => node.firstElementChild.id), 'attempt-duration');
    assert.equal(await page.locator('#results-header #detail-status').count(), 0);
    assert.equal(await page.locator('#results-common > #header-control-group + .result-steps').count(), 1, 'the control group precedes steps in the upper header');
    assert.equal(await page.locator('#header-control-group > #detail-url + #attempt-controls').count(), 1, 'URL immediately precedes attempt controls in their shared group');
    assert.equal(await page.locator('#attempt-header > #qa-progress').count(), 1);
    assert.equal(await page.locator('#gallery-message').count(), 0);
    assert.equal(await page.locator('#metadata-panel select').count(), 0);
    assert.equal(await page.locator('#detail-actions, #refresh-logs').count(), 0);
    assert.doesNotMatch(await page.locator('#results-column').innerText(), /Галерея PNG|Сведения о попытке/);
    assert.match(await page.locator('#metadata-panel').innerText(), /Детали попытки/);
    for (const id of ['metadata-panel', 'summary-panel', 'logs-card']) {
      assert.equal(await page.locator('#png-gallery').evaluate((node, id) => Boolean(node.compareDocumentPosition(document.getElementById(id)) & Node.DOCUMENT_POSITION_FOLLOWING), id), true);
      assert.ok(await page.locator('#gallery-body').evaluate((node, id) => node.getBoundingClientRect().bottom <= document.getElementById(id).getBoundingClientRect().top, id));
    }
  }
  async function assertInputControls() {
    assert.equal(await page.locator('#batch-form input').count(), 1);
    assert.equal(await page.locator('#add-url').count(), 0);
    assert.equal(await page.locator('#batch-form .card-footer').count(), 0);
    assert.equal(await page.locator('#batch-form button[type="submit"]').count(), 1);
    const buttons = await page.locator('#clear-url, #submit-button').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    assert.equal(buttons[0].width, buttons[0].height);
    assert.equal(buttons[0].width, buttons[1].width);
    assert.equal(buttons[0].height, buttons[1].height);
    assert.equal(buttons[0].y, buttons[1].y);
    assert.ok(buttons[1].x > buttons[0].x + buttons[0].width);
    assert.equal(await page.locator('#clear-url').evaluate(node => node.nextElementSibling.id), 'submit-button');
  }
  await assertGalleryFirst(); await assertInputControls();
  const galleryColumns = await page.locator('#png-gallery > div').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width }; }));
  assert.equal(new Set(galleryColumns.map(item => Math.round(item.y))).size, 1, '1440px uses three gallery cards in the expanded results column');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const output = testOutput();
  fs.mkdirSync(output, { recursive: true });
  assert.equal(await page.locator('#batch-form label').count(), 0);
  assert.equal(await page.locator('#url-input').getAttribute('aria-label'), 'URL страницы');
  assert.doesNotMatch(await page.locator('body').innerText(), /Добавить ещё URL/);
  assert.doesNotMatch(await page.locator('body').innerText(), /Один адрес в каждом поле|Статус сегмента —|URL 1|Страница \/ попытки/);
  assert.equal(await page.locator('#left-column thead').count(), 0);
  assert.equal(await page.locator('#queue-card #jobs-body').count(), 1);
  assert.equal(await page.locator('#queue-card #progress-bar').count(), 1);
  assert.equal(await page.locator('#queue-card #concurrency-slider').count(), 1);
  assert.doesNotMatch(await page.locator('#jobs-body').innerText(), /Попыток:|\d{2}\.\d{2}\.\d{4}/, 'queue rows omit attempt counts and dates');
  assert.equal(await page.locator('#progress-label').innerText(), '0 / 1', 'cancelled is not complete');
  assert.equal(await page.locator('#progress-bar').evaluate(node => node.style.width), '0%');
  await page.locator('#concurrency-slider').fill('5');
  await page.waitForFunction(() => document.querySelector('#concurrency-slider').getAttribute('aria-busy') === 'false' && document.querySelector('#concurrency-value').textContent === '5');
  assert.equal(queue.concurrency, 5);
  assert.equal(new Queue({ root, concurrency: 2, autoStart: false }).concurrency, 5);
  async function openJson() {
    const shown = page.evaluate(() => new Promise(resolve => document.querySelector('#json-modal').addEventListener('shown.bs.modal', () => resolve(), { once: true })));
    await page.getByRole('button', { name: 'Открыть capture-report.json', exact: true }).click();
    await shown;
  }
  async function closeJson() {
    const hidden = page.evaluate(() => new Promise(resolve => document.querySelector('#json-modal').addEventListener('hidden.bs.modal', () => resolve(), { once: true })));
    await page.getByRole('button', { name: 'Закрыть JSON', exact: true }).click();
    await hidden;
  }
  await openJson();
  await page.waitForSelector('#json-output .jse-main');
  assert.equal(await page.evaluate(() => window.ArmEditors.text('json-output')), JSON.stringify(fixture.report, null, 2));
  assert.equal(reportRequests, 1, 'capture report is fetched only after the explicit preview action');
  assert.ok((await page.locator('#json-download').getAttribute('data-source-url')).startsWith(`${origin}/api/files/${job.id}/2/`));
  await page.locator('#json-copy').click(); await page.waitForFunction(() => document.querySelector('#json-action-status').textContent === 'Скопировано');
  assert.equal(await page.evaluate(() => window.copied), JSON.stringify(fixture.report, null, 2));
  const jsonDownload = page.waitForEvent('download'); await page.locator('#json-download').click();
  const jsonFile = await jsonDownload; assert.equal(jsonFile.suggestedFilename(), 'capture-report.json'); assert.equal(fs.readFileSync(await jsonFile.path(), 'utf8'), JSON.stringify(fixture.report));
  assert.equal(browser.contexts()[0].pages().length, 1, 'report stays in same tab');
  await page.screenshot({ path: path.join(output, 'ui-json-modal-1440.png') });
  await closeJson();
  fs.writeFileSync(fixture.loc.report, '<script>throw "not JSON"</script>');
  await openJson();
  await page.waitForSelector('#json-error:not(.d-none)');
  assert.match(await page.locator('#json-error').innerText(), /Не удалось загрузить JSON/);
  assert.equal(await page.locator('#json-output').textContent(), '');
  await closeJson();
  fs.writeFileSync(fixture.loc.report, JSON.stringify(fixture.report));
  await page.route('**/api/files/**/capture-report.json', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture unavailable"}' }));
  await openJson();
  await page.waitForSelector('#json-error:not(.d-none)');
  assert.match(await page.locator('#json-error').innerText(), /fixture unavailable/);
  await closeJson();
  await page.unroute('**/api/files/**/capture-report.json');
  await page.waitForFunction(() => document.querySelectorAll('#png-gallery img').length === 3);
  assert.doesNotMatch(await page.locator('#results-card').innerText(), /\b\d+ PNG\b|Снимков пока нет/);
  await page.screenshot({ path: path.join(output, 'ui-two-columns-1440.png'), fullPage: true });

  const originalTrigger = await page.locator('#png-gallery button').first().elementHandle();
  await openFirstPng(true);
  await page.waitForFunction(() => document.querySelector('#png-full').naturalWidth > 0);
  assert.equal(await page.locator('#png-counter').innerText(), '1 / 3');
  assert.equal(await page.locator('#png-prev').isDisabled(), true);
  assert.equal(await page.locator('#png-full').evaluate(img => img.width === img.naturalWidth && img.height === img.naturalHeight), true);
  assert.equal(await page.locator('#png-modal .modal-footer a').count(), 0);
  await page.locator('#png-copy').click(); await page.waitForFunction(() => document.querySelector('#png-action-status').textContent === 'Скопировано');
  assert.deepEqual(await page.evaluate(() => window.copied), { type: 'image/png', size: tinyPng.length });
  const pngDownload = page.waitForEvent('download'); await page.locator('#png-download').click();
  const pngFile = await pngDownload; assert.equal(pngFile.suggestedFilename(), names[0]); assert.deepEqual(fs.readFileSync(await pngFile.path()), tinyPng);
  await page.locator('#png-next').click();
  assert.equal(await page.locator('#png-counter').innerText(), '2 / 3');
  assert.equal(await page.locator('#png-modal .image-status, #png-status').count(), 0);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#png-counter').innerText(), '3 / 3');
  assert.equal(await page.locator('#png-next').isDisabled(), true);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#png-counter').innerText(), '2 / 3');
  await page.screenshot({ path: path.join(output, 'ui-gallery-modal-1440.png') });
  const segmentsBeforeSse = await qaProgress.locator('.qa-progress-segment').elementHandles();
  // The common image status comes from QA state in the snapshot, never from capture-report.json.
  for (const file of attempt.files.filter(file => file.kind === 'png')) {
    if (file.name === names[1]) { file.segmentStatus = 'ok'; file.qaStatus = 'passed'; }
    if (file.name === names[2]) file.qaStatus = 'passed';
  }
  attempt.qa = { total: 3, reviewed: 3, passed: 3, issues: 0, pending: 0, unreviewed: 0, segments: names.map(name => ({ name, status: 'passed' })) };
  queue.save();
  const pushedAt = Date.now(), pushedState = page.waitForResponse(response => response.url() === `${origin}/api/state`);
  queue.notifyReviewAccepted({ jobId: job.id, attempt: attempt.number, name: names[2] });
  await pushedState;
  await page.waitForFunction(() => [...document.querySelectorAll('#png-gallery .image-status')].every(node => node.getAttribute('aria-label') === 'Проверено'));
  await page.waitForFunction(node => !node.isConnected, segmentsBeforeSse[0]);
  assert.ok(Date.now() - pushedAt < 1000, 'SSE refresh arrives before the 1500ms polling fallback');
  assert.equal(await page.locator('#qa-progress-count').innerText(), '3/3');
  assert.deepEqual(await qaProgress.locator('.qa-progress-segment').evaluateAll(nodes => nodes.map(node => node.dataset.qaStatus)), ['passed', 'passed', 'passed']);
  assert.deepEqual(await qaProgress.locator('.qa-progress-segment').evaluateAll(nodes => nodes.map(node => node.dataset.qaTooltip)), tooltipTexts);
  assert.equal(await page.locator('.tooltip').count(), 0, 'SSE rerender disposes stale tooltip instances');
  assert.deepEqual(await Promise.all(segmentsBeforeSse.map(handle => handle.evaluate(node => node.isConnected))), [false, false, false]);
  assert.equal(await qaProgress.getAttribute('aria-valuenow'), '100');
  assert.match(await qaProgress.getAttribute('aria-label'), /Проверено 3 из 3 PNG/);
  const reportRequestsAfterPreview = reportRequests;
  await page.waitForTimeout(1700);
  assert.equal(reportRequests, reportRequestsAfterPreview, 'polling does not inspect capture-report.json for QA state');
  assert.equal(await page.locator('#png-counter').innerText(), '2 / 3');
  assert.ok((await page.locator('#png-download').getAttribute('data-source-url')).startsWith(`${origin}/api/files/${job.id}/2/`));
  await closePng();
  assert.equal(await originalTrigger.evaluate(node => node.isConnected), false, 'polling replaced the original gallery trigger');
  assert.equal(await page.locator('#png-gallery button').first().evaluate(node => document.activeElement === node), true, 'Escape restores focus to the current button with the original file identity');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#png-gallery .image-status').first().evaluate(node => document.activeElement === node), true, 'compact status is keyboard accessible');
  await page.waitForSelector('.tooltip.show');
  assert.equal(await page.locator('.tooltip.show .tooltip-inner').innerText(), 'Проверено');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#png-gallery button').nth(1).evaluate(node => document.activeElement === node), true, 'next Tab continues through the gallery, not the URL form');
  await page.selectOption('#attempt-select', '1');
  await page.waitForFunction(() => document.querySelectorAll('#png-gallery img').length === 1);
  await openFirstPng();
  assert.equal(await page.locator('#png-counter').innerText(), '1 / 1');
  assert.ok((await page.locator('#png-download').getAttribute('data-source-url')).includes(`/1/`));
  await closePng();

  const invalid = ['http://a.reestr35.ru', 'https://reestr35.ru', 'https://a.reestr35.ru.evil.test', 'https://x:y@a.reestr35.ru', 'https://a.reestr35.ru:444', 'https://a.reestr35.ru./', 'https://a.reestr35.ru\\@evil.test', 'https://-a.reestr35.ru', '/relative', '', 'https://a.reestr35.ru/a b'];
  const valid = ['https://MORI-CINEMA.reestr35.ru:443/#fragment', 'https://new.reestr35.ru/', 'https://NEW.reestr35.ru:443/#same', 'https://nested.a.reestr35.ru/'];
  const input = page.locator('#url-input');
  await input.fill('https://clear.reestr35.ru/');
  await page.locator('#clear-url').click();
  assert.equal(await input.inputValue(), '');
  assert.equal(await input.evaluate(node => document.activeElement === node), true);
  const submissions = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url() === `${origin}/api/jobs`) submissions.push(request.postDataJSON()); });
  for (const value of invalid) {
    await input.fill(value); await page.locator('#submit-button').click();
    assert.throws(() => normalizeUrl(value));
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    assert.ok(await page.locator('#url-feedback.invalid-feedback').isVisible());
  }
  assert.deepEqual(submissions, [], 'invalid URLs never submit');
  await page.screenshot({ path: path.join(output, 'ui-single-validation-1440.png'), fullPage: true });
  await page.locator('#clear-url').click();
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.locator('#url-feedback').isVisible(), false);
  for (let index = 0; index < valid.length; index++) {
    await input.fill(valid[index]);
    if (index === valid.length - 1) await input.press('Enter');
    else await page.locator('#submit-button').click();
    await page.waitForFunction(() => document.querySelector('#submit-button').getAttribute('aria-busy') === 'false');
    if ([1, 3].includes(index)) {
      assert.equal(await input.inputValue(), '', 'newly added URL clears the field');
      assert.equal(await page.locator('#batch-result').isVisible(), false, 'successful addition has no notification');
    }
    else assert.match(await page.locator('#url-feedback').innerText(), /Уже в очереди/);
  }
  assert.deepEqual(submissions, valid.map(value => ({ urls: normalizeUrl(value) })), 'each request contains exactly one canonical URL');
  assert.deepEqual(queue.jobs.map(item => item.url), [job.url, 'https://new.reestr35.ru/', 'https://nested.a.reestr35.ru/']);
  assert.deepEqual(await page.locator('#jobs-body tr').evaluateAll(rows => rows.map(row => row.dataset.jobId)), queue.jobs.map(item => item.id).reverse(), 'newest jobs render first');
  assert.equal(await page.locator('#jobs-body a').count(), 0, 'queue URLs are plain text');
  const newJobRow = page.locator(`[data-job-id="${queue.jobs[1].id}"]`);
  await newJobRow.locator('td').first().locator('span').click();
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[1].url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), 'clicking URL text selects its row');
  const externalLink = page.locator('#detail-url');
  assert.equal(await externalLink.getAttribute('href'), queue.jobs[1].url);
  assert.equal(await externalLink.getAttribute('target'), '_blank');
  assert.equal(await externalLink.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await externalLink.getAttribute('class'), 'btn btn-outline-primary result-url', 'detail URL uses the agreed control styling');
  const externalLinkStyle = await externalLink.evaluate(node => ({
    color: (() => { const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); context.fillStyle = getComputedStyle(node).color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; })(),
    bodyColor: (() => { const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); context.fillStyle = getComputedStyle(document.body).color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; })(),
    decoration: getComputedStyle(node).textDecorationLine,
  }));
  assert.notDeepEqual(externalLinkStyle.color, externalLinkStyle.bodyColor, 'detail URL uses the primary outline control color');
  assert.equal(externalLinkStyle.decoration, 'none', 'the URL control is not underlined');
  await externalLink.hover();
  assert.equal(await externalLink.evaluate(node => getComputedStyle(node).textDecorationLine), 'none', 'button hover does not add link decoration');
  await page.context().route('https://new.reestr35.ru/', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>External fixture</title>' }));
  const popupPromise = page.waitForEvent('popup');
  await externalLink.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[1].url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), 'detail URL click preserves the selected result');
  await popup.close();
  await page.locator(`[data-job-id="${job.id}"]`).evaluate(row => row.click());
  assert.equal(queue.active.size, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.selectOption('#attempt-select', '2');
  await page.waitForFunction(() => document.querySelectorAll('#png-gallery img').length === 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const mobileColumns = await page.locator('#workspace > section').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
  assert.equal(mobileColumns.length, 2);
  assert.ok(mobileColumns[0] < mobileColumns[1]);
  const mobileCards = await page.locator('#png-gallery > div').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
  assert.ok(mobileCards[0] < mobileCards[1] && mobileCards[1] < mobileCards[2]);
  await assertGalleryFirst(); await assertInputControls();
  await page.screenshot({ path: path.join(output, 'ui-two-columns-390.png'), fullPage: true });
  await openFirstPng();
  await page.locator('#png-next').click();
  await page.waitForFunction(() => document.querySelector('#png-full').complete && document.querySelector('#png-full').naturalWidth > 0);
  assert.equal(await page.locator('#png-full').evaluate(img => img.width === img.naturalWidth && img.height === img.naturalHeight), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'ui-gallery-modal-390.png') });
  await page.locator('#png-prev').click();
  assert.equal(await page.locator('#png-counter').innerText(), '1 / 3');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.waitForSelector('#png-modal', { state: 'hidden' });
  await input.fill('https://clear-mobile.reestr35.ru/'); await page.locator('#clear-url').click();
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.locator('#batch-form input').count(), 1);
  queue.add('https://p1.reestr35.ru\nhttps://p2.reestr35.ru\nhttps://p3.reestr35.ru\nhttps://p4.reestr35.ru\nhttps://p5.reestr35.ru');
  ['complete', 'needs_review', 'incomplete', 'failed', 'cancelled', 'interrupted', 'queued', 'running'].forEach((status, index) => { queue.jobs[index].attempts.at(-1).status = status; });
  await page.waitForFunction(() => document.querySelector('#progress-label').textContent === '1 / 8');
  assert.equal(await page.locator('#progress-bar').evaluate(node => node.style.width), '13%');
  queue.newAttempt(job);
  await page.waitForFunction(() => document.querySelector('#progress-label').textContent === '0 / 8');
  assert.deepEqual(errors, []);
});
