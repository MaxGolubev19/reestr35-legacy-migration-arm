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
  assert.match(await page.locator('#empty-detail .empty-subtitle').innerText(), /галерея снимков, отчёт и попытки/);
  const desktop = await image.boundingBox();
  assert.ok(desktop.width <= 352 && desktop.width >= 300, 'desktop illustration uses the intended capped size');
  const asset = await page.request.get(`${base}/assets/astronaut.png`);
  assert.equal(asset.status(), 200); assert.match(asset.headers()['content-type'], /^image\/png/);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await image.boundingBox();
  assert.ok(mobile.width < desktop.width, 'illustration shrinks on the mobile layout');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('terminal idle result retains an effective retry-stop action through the protected API', { timeout: 30000 }, async t => {
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
  assert.equal(await button.getAttribute('data-action'), 'stop'); assert.match(await button.getAttribute('title'), /Повторить остановку/);
  assert.equal(await button.isDisabled(), false); await button.click();
  await page.waitForFunction(id => document.querySelector(`[data-job-action="${id}"]`)?.dataset.action === 'continue-qa', job.id);
  assert.deepEqual(posts, [`/api/jobs/${job.id}/stop`]); assert.equal(stops, 2);
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
  const makeJob = (id, status, canStop = false) => ({ id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, url: `https://favicon-${id}.reestr35.ru/`, status, canStop, attempts: [{ number: 1, status, files: [] }] });
  const readIcon = () => page.locator('#dynamic-favicon').getAttribute('href').then(href => decodeURIComponent(href.split(',')[1]));
  const waitForIcon = (fragment) => page.waitForFunction(fragment => decodeURIComponent(document.querySelector('#dynamic-favicon').href.split(',')[1]).includes(fragment), fragment);

  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await waitForIcon('#2fb344');
  assert.match(await readIcon(), /<path .*stroke="#fff"/);
  assert.equal(await page.title(), 'Снимки страниц — Реестр 35');
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
  assert.equal(await page.title(), 'Снимки страниц — Реестр 35');

  const writes = await page.evaluate(() => window.faviconWrites);
  const observedPolls = polls;
  await page.waitForFunction(writes => window.faviconWrites > writes, writes);
  assert.ok(polls > observedPolls, 'an unchanged subsequent state poll rewrites the favicon');

  jobs = [...Array.from({ length: 1000 }, (_, index) => makeJob(index + 10, 'failed')), makeJob(2000, 'paused'), makeJob(2001, 'cancelled')];
  await page.waitForFunction(() => decodeURIComponent(document.querySelector('#dynamic-favicon').href.split(',')[1]).includes('>1000</text>'));
  assert.match(await readIcon(), /font-size="10"[^>]*>1000<\/text>/, 'large counts remain exact decimal values and use a smaller font');
  assert.equal(await page.title(), 'Снимки страниц — Реестр 35');
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
  const statuses = ['paused', 'queued', 'running', 'stopping', 'complete', 'needs_review', 'incomplete', 'failed', 'interrupted', 'cancelled', 'validating', 'validating', 'queued', 'queued'];
  queue.add(statuses.map((status, i) => `https://icon-${i}.reestr35.ru/`).join('\n'));
  queue.launch(queue.jobs[2]); queue.launch(queue.jobs[11]); queue.closing = true;
  statuses.forEach((status, i) => { queue.jobs[i].attempts[0].status = status; });
  queue.jobs[2].attempts[0].startedAt = new Date(Date.now() - 5000).toISOString();
  Object.assign(queue.jobs[4].attempts[0], { startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:05Z' });
  Object.assign(queue.jobs[13].attempts[0], { phase: 'qa', startedAt: '2026-01-01T00:00:00Z' });
  queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.finish(); await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  let exposeContinueQa = true;
  await page.route('**/api/state', async route => {
    const response = await route.fetch(), snapshot = await response.json();
    const resumable = snapshot.jobs.find(item => item.id === queue.jobs[5].id);
    if (resumable) {
      resumable.canContinueQa = exposeContinueQa;
      resumable.attempts.at(-1).qa = { total: 1, reviewed: 0, passed: 0, issues: 0, unreviewed: 1 };
    }
    await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(snapshot) });
  });
  await page.route(`**/api/jobs/${queue.jobs[5].id}/continue-qa`, route => {
    exposeContinueQa = false;
    return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  page.on('request', request => { if (request.method() === 'POST') requests.push(new URL(request.url()).pathname); });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('[data-job-action]').length === 14);
  assert.equal(await page.locator('#jobs-body a').count(), 0, 'queue rows contain no links');
  const action = i => page.locator(`[data-job-action="${queue.jobs[i].id}"]`);
  const select = i => page.locator(`[data-job-id="${queue.jobs[i].id}"]`).evaluate(row => row.click());
  const waitStatus = (i, status) => page.waitForFunction(([id, status]) => document.querySelector(`[data-job-action="${id}"]`)?.dataset.status === status, [queue.jobs[i].id, status]);
  const expected = [
    ['resume', 'pause', 'secondary', 'Возобновить'], ['pause', 'clock', 'blue', 'Поставить на паузу'],
    ['stop', 'running', 'blue', 'Остановить'], ['', 'square', 'yellow', 'Остановка уже выполняется'],
    ['retry', 'check', 'green', 'Повторить'], ['continue-qa', 'check', 'blue', 'Продолжить проверку'],
    ['retry', 'alert', 'red', 'Повторить'], ['retry', 'alert', 'red', 'Повторить'],
    ['retry', 'alert', 'red', 'Повторить'], ['retry', 'square', 'secondary', 'Повторить'],
    ['', 'running', 'blue', 'Остановка недоступна'], ['stop', 'running', 'blue', 'Остановить'], ['pause', 'clock', 'blue', 'Поставить на паузу'],
    ['stop', 'clock', 'blue', 'Отменить проверку']
  ];
  for (let i = 0; i < expected.length; i++) {
    const [operation, icon, color, label] = expected[i], button = action(i);
    assert.equal(await button.getAttribute('data-action'), operation);
    assert.equal(await button.getAttribute('data-icon'), icon);
    assert.ok((await button.getAttribute('class')).includes(`text-${color}`));
    assert.ok((await button.getAttribute('title')).includes(label));
    assert.ok((await button.getAttribute('aria-label')).includes(queue.jobs[i].url));
    assert.equal(await button.isDisabled(), !operation);
    assert.equal(await button.innerText(), '', 'status/action has no visible text badge');
    assert.equal(await button.locator(icon === 'running' ? '.status-dot-animated.bg-blue' : 'svg.icon').count(), 1);
  }
  const qaRetry = page.locator(`[data-job-secondary-action="${queue.jobs[5].id}"]`);
  assert.equal(await qaRetry.getAttribute('data-action'), 'retry');
  assert.ok((await qaRetry.getAttribute('title')).includes('Повторить захват'));
  assert.ok((await qaRetry.getAttribute('aria-label')).includes(queue.jobs[5].url));
  await page.locator(`[data-job-id="${queue.jobs[2].id}"]`).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[2].url, 'Enter on a queue row selects its result');
  await page.locator(`[data-job-id="${queue.jobs[4].id}"]`).focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url, 'Space on a queue row selects its result');
  await select(2);
  const initialDuration = await page.locator('#attempt-duration').innerText();
  await page.waitForFunction(value => document.querySelector('#attempt-duration').textContent !== value, initialDuration);
  assert.match(await page.locator('#attempt-duration').innerText(), /^\d{2}:\d{2}:\d{2}$/);
  await select(4); assert.equal(await page.locator('#attempt-duration').innerText(), '00:00:05');
  await page.waitForResponse(response => response.url() === `${base}/api/state`);
  assert.equal(await page.locator('#attempt-duration').innerText(), '00:00:05');
  await action(5).click();
  await page.waitForFunction(id => document.querySelector(`[data-job-action="${id}"]`)?.dataset.action === 'retry', queue.jobs[5].id);
  assert.ok(requests.includes(`/api/jobs/${queue.jobs[5].id}/continue-qa`));
  assert.equal(queue.jobs[5].attempts.length, 1, 'continue QA keeps the current capture attempt');
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url, 'continue QA does not select its row');
  const output = testOutput(); fs.mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'ui-queue-actions-1440.png'), fullPage: true });
  await action(0).click(); await waitStatus(0, 'queued');
  assert.equal(queue.jobs[0].attempts.length, 1);
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url, 'resume does not select its row');
  await action(1).click(); await waitStatus(1, 'paused');
  const order = queue.jobs[1].attempts[0].queueOrder;
  await action(1).focus(); await page.keyboard.press('Enter'); await waitStatus(1, 'queued');
  assert.ok(queue.jobs[1].attempts[0].queueOrder > order);
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url, 'keyboard action does not select its row');
  for (const i of [3, 10]) { const count = requests.length; await action(i).evaluate(button => button.click()); assert.equal(requests.length, count); }
  await action(13).click(); await waitStatus(13, 'cancelled');
  assert.ok(requests.includes(`/api/jobs/${queue.jobs[13].id}/stop`));
  assert.equal(queue.jobs[13].attempts.length, 1, 'cancelling queued QA keeps the current capture attempt');
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url, 'cancelling queued QA does not select its row');
  for (const [i, child] of [[2, children[0]], [11, children[1]]]) {
    await action(i).click(); await waitStatus(i, 'stopping'); assert.equal(await action(i).isDisabled(), true);
    child.finish(); await waitStatus(i, 'cancelled');
  }
  for (const i of [4, 5, 6, 7, 8, 9]) {
    await action(i).click(); await waitStatus(i, 'queued');
    assert.equal(queue.jobs[i].attempts.length, 2);
    assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url);
  }
  assert.equal(await page.locator('#attempt-select').inputValue(), '2', 'retry updates the selected job to its new attempt');
  await page.selectOption('#attempt-select', '1');
  assert.equal(await page.locator('#detail-status').innerText(), 'Готово');
  assert.equal(await page.locator('#attempt-duration').innerText(), '00:00:05');
  await page.route(`**/api/jobs/${queue.jobs[12].id}/pause`, async route => { queue.launch(queue.jobs[12]); await route.continue(); });
  await action(12).click();
  await page.waitForFunction(() => document.querySelector('#global-alert').textContent.includes('Пауза доступна только'));
  assert.equal(queue.jobs[12].attempts[0].status, 'running');
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[4].url);
  assert.equal(await page.locator('#results-column [data-job-action], #refresh-logs, #detail-actions').count(), 0);
  queue.jobs[0].url = null;
  queue.save();
  await page.waitForFunction(id => document.querySelector(`[data-job-id="${id}"] td:first-child`)?.textContent.trim() === '—', queue.jobs[0].id);
  await select(0);
  assert.equal(await page.locator('#detail-url').innerText(), '—', 'missing URL renders a safe placeholder');
  for (const attribute of ['href', 'target', 'rel']) assert.equal(await page.locator('#detail-url').getAttribute(attribute), null, `missing URL omits ${attribute}`);
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
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
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
  async function closePng() {
    const hidden = page.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Modal hide timeout: ${document.querySelector('#png-modal').className}, focus=${document.activeElement.id}`)), 5000);
      document.querySelector('#png-modal').addEventListener('hidden.bs.modal', () => { clearTimeout(timer); resolve(); }, { once: true });
    }));
    await page.keyboard.press('Escape');
    await hidden;
  }
  await page.goto(origin);
  await page.locator(`[data-job-id="${job.id}"]`).evaluate(row => row.click());
  await page.waitForFunction(() => document.querySelectorAll('#png-gallery img').length === 1);
  assert.equal(await page.locator('#png-gallery .image-status').innerText(), 'Не проверено', 'an early PNG is visible before capture finishes');
  assert.equal(await page.locator('#qa-progress').isHidden(), true, 'QA indicator waits for the immutable manifest projection');
  assert.equal(await page.locator('#qa-progress-count').innerText(), '0/0');
  assert.equal(await page.locator('#qa-progress-count').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('#files-list button').count(), 1);
  assert.equal(reportRequests, 0, 'gallery never reads the QA report in the background');
  fixture = artifacts(attempt, names, { qaStatuses: ['passed', 'issues', 'unreviewed'] });
  attempt.workflow = 1;
  queue.save();
  await page.waitForFunction(() => document.querySelectorAll('#png-gallery .image-status').length === 3);
  assert.equal(await page.locator('#png-gallery img').count(), 3);
  assert.deepEqual(await page.locator('#png-gallery .image-status').allInnerTexts(), ['Проверено', 'Есть замечания', 'Не проверено']);
  assert.equal(await page.locator('#png-gallery .badge').count(), 3, 'each PNG has exactly one common status');
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
  const leftOrder = await page.locator('#batch-form, #queue-progress, #jobs-body').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
  assert.ok(leftOrder[0] < leftOrder[1] && leftOrder[1] < leftOrder[2]);
  const queueDivider = page.locator('#queue-progress + .job-table-wrap');
  assert.equal(await queueDivider.getAttribute('class').then(value => value.split(/\s+/).includes('border-top')), true);
  assert.equal(await queueDivider.evaluate(node => getComputedStyle(node).borderTopWidth), '1px');
  assert.equal(await page.locator('#settings-error').evaluate(node => node.parentElement.id), 'queue-progress', 'settings errors stay above the queue divider');
  async function assertGalleryFirst() {
    assert.equal(await page.locator('#job-detail.card').count(), 0);
    assert.equal(await page.locator('#job-detail > div > .card').count(), 4);
    assert.equal(await page.locator('#results-card').evaluate(node => node.firstElementChild.nextElementSibling.id), 'gallery-body');
    for (const id of ['attempt-select', 'detail-status', 'attempt-duration']) assert.equal(await page.locator(`#results-header #${id}`).count(), 1);
    assert.equal(await page.locator('#metadata-panel select').count(), 0);
    assert.equal(await page.locator('#detail-actions, #refresh-logs').count(), 0);
    assert.doesNotMatch(await page.locator('#results-column').innerText(), /Галерея PNG|Сведения о попытке/);
    assert.match(await page.locator('#metadata-panel').innerText(), /Детали запуска/);
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
  await page.waitForFunction(() => document.querySelector('#json-output').textContent.startsWith('{'));
  assert.equal(await page.locator('#json-output').textContent(), JSON.stringify(fixture.report, null, 2));
  assert.equal(reportRequests, 1, 'capture report is fetched only after the explicit preview action');
  assert.ok((await page.locator('#json-original').getAttribute('href')).startsWith(`${origin}/api/files/${job.id}/2/`));
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
  await page.waitForFunction(() => document.querySelector('#gallery-message').textContent === '3 PNG');
  await page.screenshot({ path: path.join(output, 'ui-two-columns-1440.png'), fullPage: true });

  const originalTrigger = await page.locator('#png-gallery button').first().elementHandle();
  await openFirstPng(true);
  await page.waitForFunction(() => document.querySelector('#png-full').naturalWidth > 0);
  assert.equal(await page.locator('#png-counter').innerText(), '1 / 3');
  assert.equal(await page.locator('#png-prev').isDisabled(), true);
  assert.equal(await page.locator('#png-full').evaluate(img => img.width === img.naturalWidth && img.height === img.naturalHeight), true);
  await page.locator('#png-next').click();
  assert.equal(await page.locator('#png-counter').innerText(), '2 / 3');
  assert.equal(await page.locator('#png-status .image-status').innerText(), 'Есть замечания');
  assert.equal(await page.locator('#png-status .badge').count(), 1);
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
  await page.waitForFunction(() => document.querySelector('#png-status .image-status')?.textContent === 'Проверено');
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
  assert.ok((await page.locator('#png-original').getAttribute('href')).startsWith(`${origin}/api/files/${job.id}/2/`));
  await closePng();
  assert.equal(await originalTrigger.evaluate(node => node.isConnected), false, 'polling replaced the original gallery trigger');
  assert.equal(await page.locator('#png-gallery button').first().evaluate(node => document.activeElement === node), true, 'Escape restores focus to the current button with the original file identity');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#png-gallery button').nth(1).evaluate(node => document.activeElement === node), true, 'next Tab continues through the gallery, not the URL form');
  await page.selectOption('#attempt-select', '1');
  await page.waitForFunction(() => document.querySelectorAll('#png-gallery img').length === 1);
  await openFirstPng();
  assert.equal(await page.locator('#png-counter').innerText(), '1 / 1');
  assert.ok((await page.locator('#png-original').getAttribute('href')).includes(`/1/`));
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
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[1].url, 'clicking URL text selects its row');
  const externalLink = page.locator('#detail-url');
  assert.equal(await externalLink.getAttribute('href'), queue.jobs[1].url);
  assert.equal(await externalLink.getAttribute('target'), '_blank');
  assert.equal(await externalLink.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await externalLink.getAttribute('class'), 'text-break', 'detail URL has no custom link styling classes');
  const externalLinkStyle = await externalLink.evaluate(node => ({
    color: (() => { const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); context.fillStyle = getComputedStyle(node).color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; })(),
    bodyColor: (() => { const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); context.fillStyle = getComputedStyle(document.body).color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; })(),
    decoration: getComputedStyle(node).textDecorationLine,
  }));
  assert.notDeepEqual(externalLinkStyle.color, externalLinkStyle.bodyColor, 'detail URL uses the standard Tabler link color');
  assert.equal(externalLinkStyle.decoration, 'none', 'Tabler link is undecorated until hover');
  await externalLink.hover();
  assert.equal(await externalLink.evaluate(node => getComputedStyle(node).textDecorationLine), 'underline', 'Tabler hover decoration remains enabled');
  await page.context().route('https://new.reestr35.ru/', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>External fixture</title>' }));
  const popupPromise = page.waitForEvent('popup');
  await externalLink.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(await page.locator('#detail-url').innerText(), queue.jobs[1].url, 'detail URL click preserves the selected result');
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
