'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { testTempRoot } = require('./support.cjs');
const { Queue } = require('../src/server.cjs');
const { layout } = require('../src/lib.cjs');
const { atomicJson } = require('../src/qa.cjs');
const { publishLease } = require('../src/launcher.cjs');
const { readPng } = require('../src/stages/capture-qa/capture/png.cjs');
const { captureIdentity, capturePlan, readCheckpoint, commitCheckpoint, checkpointPath } = require('../src/stages/capture-qa/capture/checkpoint.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=', 'base64');
function evidence(directory, url = 'https://resume.reestr35.ru/', attemptId) {
  fs.mkdirSync(directory, { recursive: true });
  const report = { url, finalUrl: url, status: 'incomplete', errors: [], viewport: { width: 1440, height: 1000, dpr: 1, zoom: 1 }, model: { layout: 'plain', root: null, groups: [] }, segments: [] };
  const identity = captureIdentity(directory, url, attemptId), plan = capturePlan(report, { timeout: 20000, stripHeight: 6000, only: null });
  return { report, identity, plan };
}
function addPng(directory, report) {
  const file = '00_страница.png'; fs.writeFileSync(path.join(directory, file), PNG);
  report.segments.push({ file, spec: { kind: 'page' }, chain: [], status: 'ok', box: { x: 0, y: 0, width: 1, height: 1 }, png: { strips: 1, ...readPng(path.join(directory, file)).png } });
}
function browserPageFixture(label = 'Second') {
  return `<style>body{margin:0}td.center_td{width:1100px}#main_block{width:95%}ul.tabs{height:24px;margin:0;padding:0;list-style:none}ul.tabs li{display:inline-block}.pane{display:none}.pane.open{display:block}</style><table><tr><td class="center_td"><h1 id="firm_title">Title</h1><div style="height:70px">Banner</div><table id="main_block"><tr><td><ul class="tabs"><li><a class="current">First</a></li><li><a>${label}</a></li></ul><div class="pane open">First content</div><div class="pane">Second content</div></td></tr></table><table style="table-layout:fixed"><tr><td class="head_block_m">Contacts</td></tr></table></td></tr></table><script>document.querySelectorAll('ul.tabs a').forEach((a,i)=>a.onclick=()=>{document.querySelectorAll('ul.tabs a').forEach(x=>x.classList.remove('current'));a.classList.add('current');document.querySelectorAll('.pane').forEach((p,j)=>p.classList.toggle('open',i===j));});</script>`;
}
test('capture checkpoint rejects corrupt identity, plan, prefix, missing, extra, replaced and resized PNG', t => {
  const directory = fs.mkdtempSync(path.join(testTempRoot(), 'capture-checkpoint-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { report, identity, plan } = evidence(directory);
  commitCheckpoint(directory, identity, plan, report);
  assert.equal(readCheckpoint(directory, identity).completed, 0);
  addPng(directory, report); commitCheckpoint(directory, identity, plan, report);
  const original = fs.readFileSync(checkpointPath(directory)), pngFile = path.join(directory, report.segments[0].file);
  assert.equal(readCheckpoint(directory, identity, plan).completed, 1);
  assert.throws(() => readCheckpoint(directory, { ...identity, attemptId: 'other' }), /другой попытке/);
  assert.throws(() => readCheckpoint(directory, identity, { ...plan, finalUrl: 'https://changed.reestr35.ru/' }), /план изменились/);
  for (const mutate of [data => data.planHash = '0'.repeat(64), data => data.completed = 2, data => data.report.segments[0].png.sha256 = '0'.repeat(64)]) {
    const data = JSON.parse(original); mutate(data); atomicJson(checkpointPath(directory), data);
    assert.throws(() => readCheckpoint(directory, identity), /повреждён/); fs.writeFileSync(checkpointPath(directory), original);
  }
  const changed = Buffer.from(PNG); changed[changed.length - 1] ^= 1;
  fs.writeFileSync(pngFile, changed); assert.throws(() => readCheckpoint(directory, identity), /PNG подменён/);
  const resized = Buffer.from(PNG); resized.writeUInt32BE(2, 16);
  fs.writeFileSync(pngFile, resized); assert.throws(() => readCheckpoint(directory, identity), /изменил размеры/);
  fs.unlinkSync(pngFile); assert.throws(() => readCheckpoint(directory, identity), /ENOENT/);
  fs.writeFileSync(pngFile, PNG); fs.writeFileSync(path.join(directory, 'foreign.png'), PNG);
  assert.throws(() => readCheckpoint(directory, identity), /неучтённые/);
});

test('running capture pauses only after checkpoint and close; restart resumes same attempt and retry preserves history', async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-resume-queue-')), children = [], calls = []; let stops = 0;
  const config = { root, autoStart: false, setTimer: () => 1, clearTimer() {}, spawnFn(command, args, options) {
    const child = new EventEmitter(); child.pid = 990000 + children.length; child.exitCode = null;
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
    child.finish = code => { publishLease(options.armLaunch.dir, options.armLaunch, { status: 'finished', exitCode: code }); child.exitCode = code; child.emit('close', code, null); };
    children.push(child); calls.push(args); return child;
  }, stopFn: async child => { stops++; child.finish(1); } };
  const queue = new Queue(config); let restored;
  t.after(async () => { await queue.shutdown(); if (restored) await restored.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  queue.add('https://resume.reestr35.ru/'); queue.pump();
  const job = queue.jobs[0], attempt = job.attempts[0], p = layout(root, job, attempt), data = evidence(p.hostDir, job.url, `${job.id}:1`);
  commitCheckpoint(p.hostDir, data.identity, data.plan, data.report);
  queue.pause(job.id); assert.equal(attempt.status, 'pausing'); assert.equal(stops, 0); assert.equal(queue.active.size, 1);
  assert.ok(fs.existsSync(path.join(p.dir, 'pause-request.json')));
  assert.throws(() => queue.resume(job.id), { statusCode: 409 }); assert.throws(() => queue.retry(job.id), { statusCode: 409 });
  addPng(p.hostDir, data.report); commitCheckpoint(p.hostDir, data.identity, data.plan, data.report);
  atomicJson(p.report, { ...data.report, status: 'paused' }); children[0].finish(2);
  assert.equal(attempt.status, 'paused'); assert.equal(attempt.captureSealed, undefined); assert.equal(queue.active.size, 0);
  queue.closing = true;
  restored = new Queue(config); const recoveredJob = restored.jobs[0];
  assert.equal(recoveredJob.attempts[0].status, 'paused'); assert.equal(restored.snapshot('').jobs[0].canResume, true);
  restored.resume(job.id); assert.equal(recoveredJob.attempts.length, 1); restored.pump();
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], 'true'); assert.equal(fs.existsSync(path.join(p.dir, 'pause-request.json')), false);
  assert.equal(readCheckpoint(p.hostDir, data.identity).completed, 1); children[1].finish(1);
  recoveredJob.attempts[0].status = 'interrupted';
  assert.equal(restored.snapshot('').jobs[0].canResume, true);
  fs.appendFileSync(path.join(p.hostDir, '00_страница.png'), 'changed');
  assert.equal(restored.snapshot('').jobs[0].canResume, false); assert.throws(() => restored.resume(job.id), /PNG подменён/);
  restored.retry(job.id); assert.equal(recoveredJob.attempts.length, 2); assert.ok(fs.existsSync(checkpointPath(p.hostDir)));
});

test('real browser capture resumes only remaining segments and refuses changed live structure without rewriting evidence', { timeout: 60000 }, async t => {
  const { chromium } = require('playwright'), { run } = require('../src/capture.cjs');
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'capture-live-resume-')), pauseFile = path.join(root, 'pause.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let label = 'Second';
  const fixture = () => browserPageFixture(label);
  const dependencies = { chromium: { async launch(options) {
    const browser = await chromium.launch(options), newContext = browser.newContext.bind(browser);
    browser.newContext = async config => { const context = await newContext(config); await context.route('https://resume.reestr35.ru/**', route => route.fulfill({ contentType: 'text/html', body: fixture() })); return context; };
    return browser;
  } } };
  const options = { url: 'https://resume.reestr35.ru/', out: root, channel: 'chrome', timeout: 1500, stripHeight: 6000, pauseFile, attemptId: 'fixture:1' };
  const first = await run(options, { ...dependencies, onCheckpoint: () => atomicJson(pauseFile, {}) });
  assert.equal(first.status, 'paused'); assert.equal(first.finished, undefined); assert.equal(first.segments.length, 1);
  const dir = path.join(root, 'resume.reestr35.ru'), checkpoint = fs.readFileSync(checkpointPath(dir)), report = fs.readFileSync(path.join(dir, 'capture-report.json'));
  const pngFile = path.join(dir, first.segments[0].file), before = fs.statSync(pngFile).mtimeMs, originalPng = fs.readFileSync(pngFile);
  fs.unlinkSync(pauseFile); label = 'Changed';
  const rejected = await run({ ...options, resume: true }, dependencies);
  assert.equal(rejected.resumeRejected, true);
  assert.match(rejected.errors.join(' '), /структура страницы или план изменились/);
  assert.deepEqual(fs.readFileSync(checkpointPath(dir)), checkpoint); assert.deepEqual(fs.readFileSync(path.join(dir, 'capture-report.json')), report);
  label = 'Second'; const newlyCaptured = [];
  const final = await run({ ...options, resume: true }, { ...dependencies, onCheckpoint: entry => newlyCaptured.push(entry.file || entry.spec.kind) });
  assert.equal(final.status, 'complete'); assert.ok(final.finished); assert.equal(final.segments.length, 4);
  assert.deepEqual(newlyCaptured, ['01_first.png', '02_second.png', 'footer']);
  assert.equal(fs.statSync(pngFile).mtimeMs, before); assert.deepEqual(fs.readFileSync(pngFile), originalPng);
  assert.equal(readCheckpoint(dir, captureIdentity(dir, options.url, options.attemptId)).completed, 4);
});

test('Queue resumes second-PNG failures; exactly one published but uncheckpointed next PNG is recaptured', { timeout: 60000 }, async t => {
  const { chromium } = require('playwright'), { run, parseArgs } = require('../src/capture.cjs');
  for (const fault of ['screenshot', 'checkpoint']) {
    const root = fs.mkdtempSync(path.join(testTempRoot(), `capture-${fault}-fault-`)), children = [], calls = [], queues = [];
    let qaStarts = 0, failScreenshot = fault === 'screenshot', screenshots = 0;
    const configuration = { root, autoStart: false, setTimer: () => 1, clearTimer() {},
      spawnFn(command, args, options) {
        const child = new EventEmitter(); child.pid = 995000 + children.length; child.exitCode = null;
        child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
        child.finish = code => { publishLease(options.armLaunch.dir, options.armLaunch, { status: 'finished', exitCode: code }); child.exitCode = code; child.emit('close', code, null); };
        children.push(child); calls.push(args); return child;
      }, stopFn: async child => child.finish(1), appServerFactory: () => ({ async shutdown() {}, review() {
        qaStarts++; const child = new EventEmitter(); child.exitCode = null; child.isQa = true;
        child.interrupt = async () => { child.exitCode = 1; child.completionProof = 'app-server-closed'; child.emit('close', 1); };
        return child;
      } }) };
    t.after(async () => { for (const queue of queues) await queue.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
    const queue = new Queue(configuration); queues.push(queue);
    queue.add('https://resume.reestr35.ru/'); queue.pump();
    const job = queue.jobs[0], attempt = job.attempts[0], p = layout(root, job, attempt);
    const dependencies = { chromium: { async launch(options) {
      const browser = await chromium.launch(options), newContext = browser.newContext.bind(browser);
      browser.newContext = async config => {
        const context = await newContext(config), newCDPSession = context.newCDPSession.bind(context);
        await context.route('https://resume.reestr35.ru/**', route => route.fulfill({ contentType: 'text/html', body: browserPageFixture() }));
        context.newCDPSession = async page => {
          const session = await newCDPSession(page), send = session.send.bind(session);
          session.send = async (method, params) => {
            if (method === 'Page.captureScreenshot' && ++screenshots === 2 && failScreenshot) throw new Error('Injected failure inside second PNG');
            return send(method, params);
          };
          return session;
        };
        return context;
      };
      return browser;
    } } };
    const rename = fs.renameSync; let commits = 0, report;
    if (fault === 'checkpoint') fs.renameSync = function(source, target) {
      if (target === checkpointPath(p.hostDir) && ++commits === 3) throw new Error('Injected failure after second PNG publication');
      return rename.call(this, source, target);
    };
    try { report = await run(parseArgs(calls[0].slice(1)), dependencies); }
    finally { fs.renameSync = rename; }
    assert.equal(report.status, 'interrupted'); assert.equal(report.finished, undefined);
    assert.match(report.errors.join(' '), /Injected failure/);
    assert.equal(fs.existsSync(path.join(p.dir, 'pause-request.json')), false, 'failure occurs without a pause request');
    const stored = JSON.parse(fs.readFileSync(checkpointPath(p.hostDir)));
    assert.equal(stored.completed, 1); assert.equal(stored.plan.segments.length, 4);
    assert.equal(fs.readdirSync(p.hostDir).some(name => name.endsWith('.tmp')), false);
    // Defense in depth: even a stale/incorrect finished projection must not seal
    // a capture whose durable checkpoint has not covered the complete plan.
    atomicJson(p.report, { ...report, status: 'incomplete', finished: new Date().toISOString() });
    assert.equal(queue.snapshot('').jobs[0].attempts[0].captureSealed, undefined);
    assert.equal(fs.existsSync(path.join(p.dir, 'capture-manifest.json')), false);
    children[0].finish(2);
    assert.equal(qaStarts, 0); assert.equal(attempt.phase, 'capture'); assert.equal(attempt.captureSealed, undefined);
    const before = fs.readFileSync(path.join(p.hostDir, '00_header.png'));
    if (fault === 'checkpoint') {
      assert.ok(fs.existsSync(path.join(p.hostDir, '01_first.png')), 'next-plan PNG was published before checkpoint failure');
      fs.writeFileSync(path.join(p.hostDir, 'foreign.png'), PNG);
      assert.equal(queue.snapshot('').jobs[0].canResume, false, 'a second or differently named orphan remains blocked');
      assert.throws(() => queue.resume(job.id), /неучтённые/);
      fs.unlinkSync(path.join(p.hostDir, 'foreign.png'));
    }
    assert.equal(attempt.status, 'interrupted'); assert.equal(queue.snapshot('').jobs[0].canResume, true);
    queue.closing = true;
    const recovered = new Queue(configuration); queues.push(recovered);
    const resumed = recovered.jobs[0].attempts[0];
    assert.equal(resumed.phase, 'capture'); assert.equal(resumed.status, 'interrupted');
    recovered.resume(job.id); assert.equal(resumed.phase, 'capture'); assert.equal(resumed.status, 'queued');
    recovered.pump(); assert.equal(calls[1][calls[1].indexOf('--resume') + 1], 'true');
    failScreenshot = false; const captured = [];
    const final = await run(parseArgs(calls[1].slice(1)), { ...dependencies, onCheckpoint: entry => captured.push(entry.file || entry.spec.kind) });
    assert.equal(final.status, 'complete'); assert.ok(final.finished);
    assert.deepEqual(captured, ['01_first.png', '02_second.png', 'footer']);
    assert.equal(captured.filter(name => name === '01_first.png').length, 1, 'the orphan segment is captured again exactly once on resume');
    assert.deepEqual(fs.readFileSync(path.join(p.hostDir, '00_header.png')), before);
    assert.equal(recovered.jobs[0].attempts.length, 1); assert.equal(qaStarts, 0);
    children[1].finish(0);
    assert.equal(resumed.captureSealed, true); assert.equal(resumed.phase, 'qa'); assert.equal(qaStarts, 1);
  }
});
