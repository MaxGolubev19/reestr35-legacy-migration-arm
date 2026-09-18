'use strict';
// Optional browser acceptance suite: uses temporary fixtures, never starts Codex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { testTempRoot, testOutput } = require('./support.cjs');
const path = require('node:path');
const { chromium } = require('playwright');
const { Queue, createServer } = require('../src/server.cjs');
const { layout, normalizeUrl } = require('../src/lib.cjs');
const { publishLease } = require('../src/launcher.cjs');

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
  assert.equal(await page.locator('#stage-three-panel #page-builder-loading').textContent(), 'Загрузка шаблона…');
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

test('step 3 template edits, review statuses, cancel rollback and responsive modal are local and durable', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  const job = queue.jobs[0], attempt = job.attempts[0]; Object.assign(attempt, { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), external = [], errors = [];
  page.on('request', request => { if (!request.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) external.push(request.url()); }); page.on('pageerror', error => errors.push(error.message));
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
  const commonHero = page.locator('#page-builder-content > .builder-section').first().locator('.builder-block').first(); await commonHero.click(); await page.waitForSelector('#page-builder-modal.show'); await page.locator('#builder-title').fill('MORI CINEMA · Годовикова, 37'); await page.locator('#builder-review-status').selectOption('passed'); await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#page-builder-content > .builder-section')?.textContent.includes('MORI CINEMA · Годовикова, 37'));
  let stored = queue.pageBuilder.read(job.id); assert.equal(stored.revision, 2); assert.equal(stored.document.common.blocks[0].title, 'MORI CINEMA · Годовикова, 37', 'common block is located and persisted');
  const vacancy = page.getByRole('button', { name: /^Вакансии\./ }); await vacancy.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('#builder-review-status').inputValue(), 'failed'); assert.match(await page.locator('#builder-review-reason').inputValue(), /сверить/i);
  await page.locator('#builder-title').fill('Не сохранять'); await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  assert.match(await vacancy.innerText(), /^Текст\nВакансии/m, 'Cancel leaves the document unchanged');
  await vacancy.click(); await page.waitForSelector('#page-builder-modal.show'); await page.locator('#builder-title').fill('Черновик пользователя');
  const externalStored = queue.pageBuilder.read(job.id), externalDocument = structuredClone(externalStored.document); externalDocument.tabs[0].blocks[1].title = 'Внешняя запись'; queue.pageBuilder.write(job.id, externalStored.revision, externalDocument);
  await page.waitForRequest(request => new URL(request.url()).pathname === '/api/state'); await page.waitForTimeout(100);
  assert.equal(await vacancy.evaluate(node => node.isConnected), true, 'polling with a newer revision does not replace the live opener'); assert.equal(await page.locator('#builder-title').inputValue(), 'Черновик пользователя');
  const conflictedPost = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === `/api/page-builder/${job.id}`), conflictResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/page-builder/${job.id}`); await page.locator('#page-builder-save').click(); const [conflictRequest, conflictResponse] = await Promise.all([conflictedPost, conflictResponsePromise]);
  assert.equal(conflictRequest.postDataJSON().revision, 2, 'save uses the revision captured when the draft opened'); assert.equal(conflictResponse.status(), 409, 'stale draft receives a CAS conflict'); await page.waitForFunction(() => document.querySelector('#page-builder-form-error').textContent.includes('уже изменены'));
  assert.equal(await page.locator('#page-builder-modal').isVisible(), true); stored = queue.pageBuilder.read(job.id); assert.equal(stored.revision, 3); assert.equal(stored.document.tabs[0].blocks[1].title, 'Внешняя запись', '409 preserves the external write');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); await page.waitForFunction(() => document.querySelector('.builder-tab-panel')?.textContent.includes('Внешняя запись')); assert.equal(await page.evaluate(() => document.activeElement?.dataset.builderId), 'news-vacancy', 'focus maps to the refreshed opener after conflict cancel');
  const externalVacancy = page.getByRole('button', { name: /^Внешняя запись\./ }); await externalVacancy.click(); await page.locator('#builder-title').fill('Вакансии кинотеатра'); await page.locator('#builder-review-status').selectOption('failed'); await page.locator('#builder-review-reason').fill('');
  await page.locator('#page-builder-save').click(); assert.match(await page.locator('#page-builder-form-error').innerText(), /Укажите причину/);
  await page.locator('#builder-review-status').selectOption('passed'); await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.builder-tab-panel')?.textContent.includes('Вакансии кинотеатра'));
  stored = queue.pageBuilder.read(job.id); assert.equal(stored.revision, 4); assert.equal(stored.document.tabs[0].blocks[1].review.status, 'passed');
  let releaseDelayedSave, markDelayedSaveArrived; const delayedSaveGate = new Promise(resolve => { releaseDelayedSave = resolve; }), delayedSaveArrived = new Promise(resolve => { markDelayedSaveArrived = resolve; });
  const builderApiPattern = `**/api/page-builder/${job.id}`, delayedSaveHandler = async route => { if (route.request().method() !== 'POST') return route.continue(); markDelayedSaveArrived(); await delayedSaveGate; await route.continue(); };
  await page.route(builderApiPattern, delayedSaveHandler); const delayedCommon = page.getByRole('button', { name: /^MORI CINEMA · Годовикова, 37\./ }); await delayedCommon.click(); await page.locator('#builder-title').fill('MORI CINEMA · атомарное сохранение'); await page.locator('#page-builder-save').click(); await delayedSaveArrived;
  const cancelSave = page.getByRole('button', { name: 'Отмена', exact: true }), closeSave = page.getByRole('button', { name: 'Отменить и закрыть', exact: true }); assert.equal(await cancelSave.isDisabled(), true); assert.equal(await closeSave.isDisabled(), true); assert.equal(await page.locator('#page-builder-modal').getAttribute('aria-busy'), '');
  await cancelSave.evaluate(node => node.click()); assert.equal(await page.locator('#page-builder-modal').isVisible(), true, 'Cancel cannot interrupt an in-flight save'); await page.keyboard.press('Escape'); assert.equal(await page.locator('#page-builder-modal').isVisible(), true, 'Escape cannot interrupt an in-flight save'); await closeSave.evaluate(node => node.click()); assert.equal(await page.locator('#page-builder-modal').isVisible(), true, 'close cannot interrupt an in-flight save');
  await page.getByRole('button', { name: /^Быстрые действия\./ }).evaluate(node => node.click()); assert.equal(await page.locator('#builder-title').inputValue(), 'MORI CINEMA · атомарное сохранение', 'another block cannot replace the pending draft');
  releaseDelayedSave(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); await page.unroute(builderApiPattern, delayedSaveHandler); await page.waitForFunction(() => document.querySelector('#page-builder-content > .builder-section')?.textContent.includes('MORI CINEMA · атомарное сохранение'));
  stored = queue.pageBuilder.read(job.id); assert.equal(stored.revision, 5); assert.equal(stored.document.common.blocks[0].title, 'MORI CINEMA · атомарное сохранение'); assert.equal(await page.evaluate(() => document.activeElement?.dataset.builderId), 'common-hero', 'completed delayed save renders and restores focus to its opener');
  const edit = page.locator('.builder-tab-panel .builder-block').first(); await edit.focus(); const editHandle = await edit.elementHandle(); await edit.click(); await page.waitForSelector('#page-builder-modal.show'); await page.waitForFunction(() => document.activeElement?.closest('#page-builder-modal')); await page.waitForRequest(request => new URL(request.url()).pathname === '/api/state'); await page.waitForRequest(request => new URL(request.url()).pathname === '/api/state'); assert.equal(await editHandle.evaluate(node => node.isConnected), true, 'unchanged polling keeps the opener node alive'); await page.keyboard.press('Escape'); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); assert.equal(await editHandle.evaluate(node => document.activeElement === node), true, 'Escape restores focus after multiple polls');
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
