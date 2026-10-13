'use strict';
const nodeTest = require('node:test'), assert = require('node:assert/strict');
const caseProfile = process.env.ARM_TEST_HTML_MEDIA_CASES || 'all';
if (!['all', 'backend', 'browser'].includes(caseProfile)) throw new Error(`Unknown HTML media case profile: ${caseProfile}`);
let browserCaseCount = 0;
const test = (...args) => { if (caseProfile !== 'browser') nodeTest(...args); };
const browserTest = (...args) => { browserCaseCount++; if (caseProfile !== 'backend') nodeTest(...args); };
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { Readable, PassThrough } = require('node:stream');
const { chromium } = require('playwright');
const { Queue, createServer } = require('../src/server.cjs');
const { INLINE_IMAGES } = require('../src/http/server.cjs');
const { layout } = require('../src/lib.cjs');
const { paths, atomicJson, QA_POLICY } = require('../src/qa.cjs');
const { inventory } = require('../src/stages/html-media/inventory.cjs');
const { download, resolvePublic, publicAddress, LIMITS } = require('../src/stages/html-media/download.cjs');
const { testTempRoot, testOutput } = require('./support.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=', 'base64');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function temp(t) { const root = fs.mkdtempSync(path.join(testTempRoot(), 'html-media-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function completed(t, options = {}, hostname = 'fixture.reestr35.ru') {
  const { beforeTransition, ...queueOptions } = options;
  const root = temp(t), queue = new Queue({ root, autoStart: false, ...queueOptions });
  t.after(() => queue.shutdown()); queue.add(`https://${hostname}/`); const job = queue.jobs[0], attempt = job.attempts[0], p = layout(root, job, attempt);
  fs.mkdirSync(p.hostDir, { recursive: true }); fs.writeFileSync(path.join(p.hostDir, '00_страница.png'), PNG);
  atomicJson(p.report, { url: job.url, finalUrl: job.url, model: { layout: 'plain', root: null, groups: [] }, status: 'complete', errors: [], finished: '2026-09-12T00:00:00Z', segments: [{ file: '00_страница.png', spec: { kind: 'page' }, chain: [], box: { x: 0, y: 0, width: 1, height: 1 }, png: { width: 1, height: 1, strips: 1 }, status: 'ok' }] });
  queue.refreshArtifacts(job, attempt); const qa = queue.qaState(job, attempt), file = qa.manifest.files[0];
  Object.assign(qa.progress, { generation: 1, policy: QA_POLICY, checkpoints: [{ generation: 1, policy: QA_POLICY, manifestHash: qa.manifest.hash, threadId: 'fixture', turnId: 'fixture', review: { name: file.name, sha256: file.sha256, status: 'passed', issues: [] } }] });
  atomicJson(paths(root, job, attempt).progress, qa.progress); attempt.phase = 'qa'; attempt.status = 'complete'; queue.save();
  const proof = [paths(root, job, attempt).manifest, paths(root, job, attempt).progress].map(file => [file, hash(fs.readFileSync(file))]);
  beforeTransition?.({ queue, job, attempt });
  queue.stage.afterQa(job, attempt); queue.save(); return { root, queue, job, attempt, proof };
}
async function fixtureServer(t, content = {}) {
  const hits = []; let release, slowStarted;
  const started = new Promise(resolve => { slowStarted = resolve; });
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (content[req.url]) { res.writeHead(200, { 'Content-Type': content[req.url].mime }); res.end(content[req.url].bytes); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok.png' }); res.end(); }
    else if (req.url === '/private') { res.writeHead(302, { Location: 'http://127.0.0.1/private' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
    else if (req.url === '/bad') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('<script>alert(1)</script>'); }
    else if (req.url === '/missing') { res.writeHead(404); res.end(); }
    else if (req.url === '/large') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.concat([PNG, Buffer.alloc(400)])); }
    else if (req.url === '/slow') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.write(PNG.subarray(0, 20)); release = () => res.end(PNG.subarray(20)); slowStarted(); }
    else { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const request = (url, options, callback) => http.request({ ...options, hostname: '127.0.0.1', port: server.address().port, path: url.pathname + url.search, lookup: undefined }, callback);
  const fetchAsset = (url, dir, options = {}) => download(url, dir, { ...options, resolver, request });
  return { hits, started, release: () => release(), fetchAsset };
}
test('bundled sources: 92 exact hashes, 33 missing and 3 unmatched; legacy complete joins queue without changing capture evidence', async t => {
  const resources = path.resolve(__dirname, '../src/resources'), report = JSON.parse(fs.readFileSync(path.join(resources, 'import-report.json')));
  assert.equal(report.copied.length, 92); assert.equal(report.missing.length, 33); assert.equal(report.unmatched.length, 3);
  for (const item of report.copied) {
    const bytes = fs.readFileSync(path.join(resources, 'html', item.hostname + '.html'));
    assert.equal(hash(bytes), item.sha256); assert.doesNotThrow(() => inventory(bytes.toString('utf8'), `https://${item.hostname}/`, LIMITS.maxResources), item.hostname);
  }
  const ctx = completed(t, {}, report.copied[0].hostname); assert.equal(ctx.attempt.status, 'queued'); assert.equal(ctx.attempt.phase, 'html-media');
  assert.equal(hash(fs.readFileSync(path.join(ctx.queue.stage.media.directory(ctx.job, ctx.attempt), 'source.html'))), report.copied[0].sha256);
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.root, 'state.json'))); Object.assign(saved.jobs[0].attempts[0], { phase: 'qa', status: 'complete' }); delete saved.jobs[0].attempts[0].htmlMedia;
  atomicJson(path.join(ctx.root, 'state.json'), saved);
  const restored = new Queue({ root: ctx.root, autoStart: false }); t.after(() => restored.shutdown());
  assert.equal(restored.jobs[0].attempts[0].phase, 'html-media'); assert.equal(restored.snapshot('').jobs[0].canResume, false); assert.equal(restored.jobs[0].attempts[0].status, 'queued'); assert.equal(restored.active.size, 0);
  for (const [file, expected] of ctx.proof) assert.equal(hash(fs.readFileSync(file)), expected);
});

test('capture-complete automatically queues HTML after existing FIFO work and runs without paused or resume', async t => {
  const resources = temp(t), fixture = await fixtureServer(t);
  fs.mkdirSync(path.join(resources, 'html')); fs.writeFileSync(path.join(resources, 'html/fixture.reestr35.ru.html'), '<img src="/slow">');
  const observed = [], ctx = completed(t, { htmlResources: resources, mediaDownload: fixture.fetchAsset, beforeTransition({queue, attempt}) {
    queue.add('https://waiting.reestr35.ru/');
    const save = queue.save.bind(queue); queue.save = () => { observed.push(attempt.status); save(); };
  } });
  assert.equal(ctx.attempt.status, 'queued'); assert.ok(ctx.attempt.queueOrder > ctx.queue.jobs[1].attempts[0].queueOrder);
  assert.equal(ctx.attempt.finishedAt, undefined);
  const starts = [], launch = ctx.queue.launch.bind(ctx.queue);
  ctx.queue.launch = job => { starts.push(job.id); if (job !== ctx.job) { job.attempts.at(-1).status = 'complete'; return; } return launch(job); };
  ctx.queue.pump(); await fixture.started;
  assert.deepEqual(starts, [ctx.queue.jobs[1].id, ctx.job.id]); assert.equal(ctx.attempt.status, 'running');
  const completion = ctx.queue.active.get(ctx.job.id).completion; fixture.release(); await completion;
  assert.equal(ctx.attempt.status, 'complete'); assert.equal(ctx.attempt.htmlMedia.downloaded, 1); assert.ok(!observed.includes('paused'));
  for (const [file, expected] of ctx.proof) assert.equal(hash(fs.readFileSync(file)), expected);
});

test('bundled HTML absence waits for upload; read, inventory and publication failures interrupt without blocking FIFO', async t => {
  const cases = [
    {name:'absent',missing:true},
    {name:'too large',html:'<p>Existing HTML</p>',limits:{maxHtmlBytes:1},error:'Файл превышает допустимый размер'},
    {name:'inventory limit',html:'<img src="/first.png"><img src="/second.png">',limits:{maxResources:1},error:'Лимит ресурсов: 1'},
    {name:'publication ENOENT after source read',html:'<p>Existing HTML</p>',error:'injected publication ENOENT',publication:true},
  ];
  for (const value of cases) await t.test(value.name, async t => {
    const resources = temp(t), filename = path.join(resources,'html','fixture.reestr35.ru.html'); fs.mkdirSync(path.dirname(filename));
    if (value.html) fs.writeFileSync(filename,value.html);
    let publicationReached = false;
    const ctx = completed(t,{htmlResources:resources,mediaLimits:value.limits,beforeTransition({queue}) {
      queue.add('https://next.reestr35.ru/');
      if (value.publication) queue.stage.media.project = () => {
        publicationReached = true;
        // Even an ENOENT carrying the source path is not absence when raised
        // during publication, after that source was successfully read.
        throw Object.assign(new Error(value.error),{code:'ENOENT',path:filename});
      };
    }});
    assert.equal(ctx.attempt.status,value.missing ? 'paused' : 'interrupted');
    assert.equal(ctx.attempt.htmlMedia.status,value.missing ? 'missing' : 'error');
    assert.equal(ctx.queue.snapshot('').jobs[0].canResume,false);
    if (!value.missing) {
      assert.equal(ctx.attempt.error,value.error); assert.equal(ctx.attempt.htmlMedia.error,value.error);
      assert.ok(!ctx.attempt.error.includes('HTML не найден'));
    }
    if (value.publication) {
      assert.equal(publicationReached,true);
      const revision = path.join(layout(ctx.root,ctx.job,ctx.attempt).dir,'html-media','revision-001');
      assert.equal(fs.readFileSync(path.join(revision,'source.html'),'utf8'),value.html,'published evidence remains intact after projection error');
    }
    const starts = []; ctx.queue.launch = job => {starts.push(job.id);job.attempts.at(-1).status='complete';};
    ctx.queue.pump(); assert.deepEqual(starts,[ctx.queue.jobs[1].id],'failure does not block the next FIFO job');
    for (const [file, expected] of ctx.proof) assert.equal(hash(fs.readFileSync(file)),expected);
  });
});

test('HTML recovery preserves queued FIFO and explicit pause; completed QA enters the queue tail after restoration', async t => {
  const resources = temp(t); fs.mkdirSync(path.join(resources, 'html')); fs.writeFileSync(path.join(resources, 'html/fixture.reestr35.ru.html'), '<img src="/pending.png">');
  const ctx = completed(t, { htmlResources: resources }); ctx.queue.add('https://waiting.reestr35.ru/');
  const saved = JSON.parse(fs.readFileSync(ctx.queue.stateFile)), originalOrder = ctx.attempt.queueOrder;
  const manifestFile = path.join(ctx.queue.stage.media.directory(ctx.job,ctx.attempt),'manifest.json'), pendingManifest = fs.readFileSync(manifestFile);
  for (const status of ['queued', 'running', 'paused', 'pausing', 'stopping']) {
    fs.writeFileSync(manifestFile,pendingManifest);
    const state = structuredClone(saved); state.jobs[0].attempts[0].status = status; atomicJson(ctx.queue.stateFile, state);
    const restored = new Queue({root:ctx.root,autoStart:false,htmlResources:resources,mediaDownload:async()=>({status:'failed',error:'fixture resource unavailable'})});
    const attempt = restored.jobs[0].attempts[0];
    assert.equal(attempt.status, ['queued','running'].includes(status) ? 'queued' : 'paused', status);
    assert.equal(attempt.queueOrder, originalOrder); assert.equal(restored.active.size, 0);
    if (['queued','running'].includes(status)) {
      restored.jobs[1].attempts[0].status = 'paused'; restored.concurrency = 1; restored.pump();
      await restored.active.get(restored.jobs[0].id).completion; assert.equal(attempt.status,'complete','recovered work runs without resume');
    }
    await restored.shutdown();
  }
  const state = structuredClone(saved); Object.assign(state.jobs[0].attempts[0], {phase:'qa',status:'complete'}); delete state.jobs[0].attempts[0].htmlMedia; atomicJson(ctx.queue.stateFile, state);
  const restored = new Queue({root:ctx.root,autoStart:false,htmlResources:resources}); t.after(()=>restored.shutdown());
  assert.equal(restored.jobs[0].attempts[0].status,'queued'); assert.ok(restored.jobs[0].attempts[0].queueOrder > restored.jobs[1].attempts[0].queueOrder);
  assert.ok(Number.isFinite(restored.nextQueueOrder));
  for (const [file, expected] of ctx.proof) assert.equal(hash(fs.readFileSync(file)), expected);
});

browserTest('Mori iframe previews render origin-dependent players without ambient credentials, parent access or top navigation', { timeout: 90000 }, async t => {
  const live = process.env.ARM_LIVE_EMBEDS === '1';
  const source = fs.readFileSync(path.resolve(__dirname, '../src/resources/html/mori-cinema.reestr35.ru.html'), 'utf8');
  const mori = inventory(source, 'https://mori-cinema.reestr35.ru/').filter(item => item.occurrence.tag === 'iframe');
  assert.equal(mori.length, 18);
  const selected = [mori[1], mori[2], mori[13]], ctx = completed(t);
  const html = selected.map(item => `<iframe src="${item.originalUrl}"></iframe>`).join('');
  await ctx.queue.stage.media.upload(ctx.job, ctx.attempt, 0, Readable.from([Buffer.from(html)]));
  ctx.queue.pump(); assert.equal(ctx.attempt.status, 'complete');
  const server = createServer(ctx.queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({channel:'chrome',headless:true}); t.after(()=>browser.close());
  const context = await browser.newContext({viewport:{width:1440,height:1000}}), page = await context.newPage(), requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith('https://rutube.ru/')) requests.push({url:request.url(),headers:request.headers()}); });
  if (!live) {
    await context.addCookies([{name:'ambient_session',value:'must-not-leak',domain:'rutube.ru',path:'/',secure:true,sameSite:'None'}]);
    await page.route('https://rutube.ru/fixture/player.json', route => route.fulfill({contentType:'application/json',body:'{"title":"Mori player rendered"}'}));
    await page.route('https://rutube.ru/play/embed/**', route => route.fulfill({contentType:'text/html',body:`<body style="background:#13253d;color:white;font:24px sans-serif"><script>
      localStorage.setItem('player', 'ready');
      fetch('/fixture/player.json', {credentials:'include'}).then(response=>response.json()).then(value=>{
        document.body.innerHTML='<h1>'+value.title+'</h1><p>Origin storage and API ready</p>'; document.body.dataset.cookie=document.cookie;
        try {parent.FRAME_ESCAPED=true;} catch {}
        try {top.location.href='https://example.com/escaped';} catch {}
      });
    </script></body>`}));
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.locator('#stage-step-2').click();
  await page.locator('#html-media-accordion summary').filter({hasText:'Внешние встраивания'}).click();
  const tiles = page.locator('.media-frame-tile');
  for (let index = 0; index < selected.length; index++) {
    await tiles.nth(index).scrollIntoViewIfNeeded();
    const frame = await (await tiles.nth(index).locator('iframe').elementHandle()).contentFrame();
    if (live && index === 2) await frame.getByText('Автор удалил это видео').waitFor({timeout:45000});
    else if (live) await frame.waitForFunction(()=>[...document.images].some(image=>image.complete && image.naturalWidth > 0), {timeout:45000});
    else { await frame.getByRole('heading',{name:'Mori player rendered'}).waitFor(); assert.equal(await frame.locator('body').getAttribute('data-cookie'), ''); }
  }
  assert.equal(page.url(),origin+'/'); assert.equal(await page.evaluate(()=>window.FRAME_ESCAPED),undefined);
  assert.deepEqual(errors,[]);
  const attrs = await tiles.first().locator('iframe').evaluate(frame=>({sandbox:frame.sandbox.value,credentialless:frame.credentialless,loading:frame.loading,referrer:frame.referrerPolicy}));
  assert.deepEqual(attrs,{sandbox:'allow-scripts allow-presentation allow-same-origin',credentialless:true,loading:'lazy',referrer:'strict-origin-when-cross-origin'});
  if (!live) {
    assert.ok(requests.some(request=>request.url.endsWith('/fixture/player.json')),'provider same-origin API completed');
    // CDP Fetch interception exposes context cookies before Chromium applies
    // its credentialless partition. Prove delivery on a real HTTP socket too.
    const received = [], probe = http.createServer((req,res)=>{
      received.push({url:req.url,cookie:req.headers.cookie,authorization:req.headers.authorization});
      res.setHeader('Content-Type','text/html');
      res.end(req.url === '/parent' ? '<iframe credentialless sandbox="allow-scripts allow-presentation allow-same-origin" referrerpolicy="strict-origin-when-cross-origin" src="/probe"></iframe>' : '<h1>Probe</h1>');
    });
    await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
    try {
      const probePage = await context.newPage(), probeOrigin = `http://127.0.0.1:${probe.address().port}`;
      await context.addCookies([{name:'ambient_local',value:'must-not-leak',url:probeOrigin}]);
      await probePage.goto(probeOrigin+'/parent'); await probePage.frameLocator('iframe').getByRole('heading',{name:'Probe'}).waitFor();
      assert.match(received.find(item=>item.url==='/parent').cookie,/ambient_local/);
      assert.equal(received.find(item=>item.url==='/probe').cookie,undefined);
      assert.equal(received.find(item=>item.url==='/probe').authorization,undefined);
      await probePage.close();
    } finally { probe.closeAllConnections(); probe.close(); }
    assert.ok(requests.filter(request=>request.url.includes('/play/embed/')).every(request=>request.headers.referer === origin+'/'),'provider gets only the ARM origin referrer');
  }
  for (const width of [1440,375]) {
    await page.setViewportSize({width,height:1000}); await tiles.first().scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path:path.join(testOutput(),`mori-${live?'live':'fixture'}-preview-${width}.png`)});
  }
  await tiles.first().click();
  const modal = page.frameLocator('#media-modal-body iframe');
  if (live) { const frame = await (await page.locator('#media-modal-body iframe').elementHandle()).contentFrame(); await frame.waitForFunction(()=>[...document.images].some(image=>image.complete && image.naturalWidth > 0), {timeout:45000}); }
  else await modal.getByRole('heading',{name:'Mori player rendered'}).waitFor();
  assert.equal(await page.locator('#media-navigation').isHidden(),true); assert.equal(await page.locator('#media-download').isHidden(),true);
  await page.screenshot({path:path.join(testOutput(),`mori-${live?'live':'fixture'}-modal-375.png`)});
});

browserTest('embed policy rejects unsafe URLs and CSP blocks private, self and off-policy iframe redirects', async t => {
  const policy = require('../public/embed-policy.js');
  for (const url of ['file:///secret','javascript:alert(1)','http://127.1/','http://localhost/','http://a.localhost/','http://10.1.2.3/','http://169.254.169.254/','http://[::1]/','http://[::ffff:127.0.0.1]/','https://u:p@rutube.ru/play/embed/a/','https://rutube.ru.evil.example/','https://rutube.ru:8443/']) assert.equal(policy.inspect(url,'http://127.0.0.1:4318').allowed,false,url);
  assert.equal(policy.inspect('http://www.youtube.com/embed/a').url,'https://www.youtube.com/embed/a');
  const ctx = completed(t), server = createServer(ctx.queue), hits = [];
  server.on('request', req=>hits.push(req.url)); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const browser = await chromium.launch({channel:'chrome',headless:true}); t.after(()=>browser.close());
  const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`;
  const redirects = [origin+'/api/state?iframe-escape', 'http://169.254.169.254/latest/meta-data/', 'https://example.com/off-policy'];
  await page.route('https://rutube.ru/play/embed/redirect-*', route=>route.fulfill({status:302,headers:{location:redirects[Number(route.request().url().split('-').at(-1))]}}));
  const response = await page.goto(origin); const csp = response.headers()['content-security-policy'];
  assert.ok(!csp.includes('frame-src http:')); assert.ok(csp.includes('frame-src '+policy.origins.join(' ')));
  await ctx.queue.stage.media.upload(ctx.job,ctx.attempt,0,Readable.from([Buffer.from(`<iframe src="https://unknown.example/embed"></iframe><iframe src="${origin}/api/state"></iframe>`)])); ctx.queue.pump();
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.locator('#stage-step-2').click();
  await page.locator('#html-media-accordion summary').filter({hasText:'Внешние встраивания'}).click();
  assert.equal(await page.locator('.media-frame-tile iframe').count(),0);
  assert.equal(await page.locator('.media-frame-tile [role=status]').count(),2,'blocked cards remain visible with explicit status');
  assert.equal(await page.locator('.media-frame-tile').first().innerText(),'Провайдер вне списка безопасных встраиваний');
  await page.evaluate(()=>{window.frameViolations=[];document.addEventListener('securitypolicyviolation',event=>{if(event.effectiveDirective==='frame-src') window.frameViolations.push(event.blockedURI);});});
  await page.evaluate(origin=>{
    for(const src of [origin+'/api/state?direct-frame', ...[0,1,2].map(index=>'https://rutube.ru/play/embed/redirect-'+index)]) {
      const frame=document.createElement('iframe');frame.credentialless=true;frame.sandbox='allow-scripts allow-same-origin';frame.src=src;document.body.append(frame);
    }
  },origin);
  await page.waitForFunction(()=>window.frameViolations.length >= 4);
  assert.equal(hits.some(url=>/iframe-escape|direct-frame/.test(url)),false,'private/self redirect never reaches ARM');
});
test('static inventory preserves occurrences, relative assumption, srcsets, CSS, documents, media, embeds and unsupported dynamic URLs', () => {
  const items = inventory(`<img src="a.png" srcset="b.png 1x, c.png 2x"><a href="/manual.pdf">PDF</a><a href="/page">page</a><style>.x{background:url('d.png')}</style><div style="background:url(e.png)"></div><video src="v.mp4" poster="poster.jpg"><source src="s.webm"></video><audio src="a.mp3"></audio><iframe src="https://youtube.com/embed/1"></iframe><embed src="x.pdf"><object data="x.swf"></object><script src="s.js"></script><img src="file:///a" data-src="lazy.png" onload="evil()"><img src="a.png">`, 'https://a.reestr35.ru/base/');
  for (const name of ['a.png','b.png','c.png','d.png','e.png','/manual.pdf','v.mp4','poster.jpg','s.webm','a.mp3','x.pdf']) assert.ok(items.find(i => i.originalUrl === name && i.status === 'pending'), name);
  assert.equal(items.filter(i => i.originalUrl === 'a.png').length, 2); assert.equal(items[0].resolvedUrl, 'https://a.reestr35.ru/base/a.png'); assert.equal(items[0].occurrence.line, 1);
  assert.equal(items.find(i => i.originalUrl.includes('youtube')).status, 'external'); assert.equal(items.find(i => i.originalUrl === 'x.swf').status, 'unsupported'); assert.equal(items.find(i => i.originalUrl === 'file:///a').status, 'unsupported'); assert.ok(!items.find(i => i.originalUrl === '/page'));
  assert.throws(() => inventory('<img src="a"><img src="b">', 'https://a.com', 1), /Лимит/);
  const dataCandidates = inventory('<img srcset="data:image/png;base64,AAA 1x, /two.png 2x">', 'https://a.reestr35.ru/');
  assert.deepEqual(dataCandidates.map(i => i.originalUrl), ['data:image/png;base64,AAA', '/two.png']);
  assert.equal(dataCandidates[0].status, 'unsupported');
  const fallback = inventory('<noscript><img src="fallback.png"></noscript><object><param name="movie" value="legacy.swf"></object>', 'https://a.reestr35.ru/');
  assert.equal(fallback.find(i => i.originalUrl === 'fallback.png').status, 'pending'); assert.equal(fallback.find(i => i.originalUrl === 'legacy.swf').status, 'unsupported');
  const named = inventory('<a href="/download?id=4" download="manual.pdf">PDF</a><a href="/download?id=5" download="photo.png">Image</a><a href="/page" download="page.html">Page</a>', 'https://a.reestr35.ru/');
  assert.equal(named.length, 2); assert.equal(named[0].status, 'pending'); assert.equal(named[0].resolvedUrl, 'https://a.reestr35.ru/download?id=4');
  assert.equal(named[0].occurrence.downloadFilename, 'manual.pdf'); assert.equal(named[1].occurrence.downloadFilename, 'photo.png');
});
test('production download validates every inline raster MIME and refuses Flash, unknown binary types and mismatched signatures', async t => {
  const bmp = Buffer.alloc(30); bmp.write('BM'); bmp.writeUInt32LE(30, 2); bmp.writeUInt32LE(26, 10); bmp.writeUInt32LE(12, 14); bmp.writeUInt16LE(1, 18); bmp.writeUInt16LE(1, 20); bmp.writeUInt16LE(1, 22); bmp.writeUInt16LE(24, 24);
  const avif = Buffer.alloc(24); avif.writeUInt32BE(24); avif.write('ftyp', 4); avif.write('avif', 8); avif.write('mif1', 16); avif.write('avif', 20);
  const signatures = { 'image/png': PNG, 'image/jpeg': Buffer.from('ffd8ffdb', 'hex'), 'image/gif': Buffer.from('GIF89a'), 'image/webp': Buffer.from('524946460400000057454250', 'hex'), 'image/bmp': bmp, 'image/avif': avif };
  const inline = [...INLINE_IMAGES];
  assert.deepEqual(inline.sort(), Object.keys(signatures).sort(), 'every server inline MIME has a real download regression');
  const content = {};
  for (const [mime, bytes] of Object.entries(signatures)) { content['/good-' + mime.split('/')[1]] = { mime, bytes }; content['/bad-' + mime.split('/')[1]] = { mime, bytes: Buffer.from('arbitrary payload') }; }
  const nonAvif = Buffer.from(avif); nonAvif.write('isom', 8); nonAvif.write('mp42', 20);
  const truncatedAvif = Buffer.from(avif); truncatedAvif.writeUInt32BE(128);
  Object.assign(content, { '/wrong-brand': { mime: 'image/avif', bytes: nonAvif }, '/truncated-ftyp': { mime: 'image/avif', bytes: truncatedAvif }, '/short-bmp': { mime: 'image/bmp', bytes: Buffer.from('BM') },
    '/flash': { mime: 'application/x-shockwave-flash', bytes: Buffer.from('4657530908000000', 'hex') }, '/flash-mime': { mime: 'application/vnd.adobe.flash.movie', bytes: PNG }, '/unknown': { mime: 'application/x-unknown', bytes: PNG },
    '/binary': { mime: 'application/octet-stream', bytes: Buffer.from('arbitrary payload') }, '/binary-png': { mime: 'application/octet-stream', bytes: PNG }, '/zip': { mime: 'application/x-zip-compressed', bytes: Buffer.from('504b0506000000000000000000000000000000000000', 'hex') } });
  const fixture = await fixtureServer(t, content), directory = temp(t);
  for (const [url, item] of Object.entries(content)) {
    if (url.startsWith('/good-') || ['/binary-png','/zip'].includes(url)) {
      const result = await fixture.fetchAsset('https://public.example' + url, directory); assert.equal(result.status, 'downloaded', url); assert.equal(result.mime, item.mime); assert.equal(result.sha256, hash(item.bytes));
      assert.equal(result.detectedMime, url === '/binary-png' ? 'image/png' : signatures[item.mime] ? item.mime : undefined);
    } else await assert.rejects(fixture.fetchAsset('https://public.example' + url, directory), /MIME|signature|Flash/, url);
  }
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});
browserTest('octet-stream PNG keeps declared MIME and passes download, image UI, picker and persisted editor preview', { timeout: 30000 }, async t => {
  const fixture = await fixtureServer(t, { '/binary.png': { mime: 'application/octet-stream', bytes: PNG } });
  const { queue, job, attempt } = completed(t, { mediaDownload: fixture.fetchAsset });
  await queue.stage.media.upload(job, attempt, 0, Readable.from([Buffer.from('<img src="/binary.png"><a href="/binary.png">Duplicate</a>')]));
  queue.pump(); await queue.active.get(job.id).completion;
  const manifest = queue.stage.media.read(job, attempt, true), item = manifest.resources[0];
  assert.equal(item.mime, 'application/octet-stream'); assert.equal(item.detectedMime, 'image/png');
  assert.equal(manifest.resources.length, 2);
  assert.ok(manifest.resources.every(resource => resource.detectedMime === 'image/png'), 'deduplicated resources retain detected MIME');
  assert.equal(fixture.hits.length, 1);
  const directory = queue.stage.media.directory(job, attempt);
  assert.equal(fs.existsSync(path.join(directory, 'images')), false);
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, endpoint = `${base}/api/page-builder/${job.id}`;
  const response = await fetch(`${base}/api/html-media/${job.id}/1/1/${item.object}`);
  assert.equal(response.headers.get('content-type'), 'image/png'); assert.match(response.headers.get('content-disposition'), /^inline/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.goto(base); await page.locator('#jobs-body tr').first().click(); await page.locator('#stage-step-2').click();
  await page.locator('#html-media-accordion summary').first().click();
  await page.getByRole('button', { name: /^Открыть изображение/ }).first().click();
  await page.waitForFunction(() => document.querySelector('.media-full-image')?.naturalWidth > 0);
  const stored = queue.pageBuilder.read(job.id), state = await (await fetch(base + '/api/state')).json();
  const headers = { origin: base, 'sec-fetch-site': 'same-origin', 'x-csrf-token': state.csrfToken, 'content-type': 'application/json' };
  const request = { revision: stored.revision, attempt: 1, htmlRevision: 1 };
  const catalog = await (await fetch(endpoint + '/media-catalog?' + new URLSearchParams(request))).json();
  assert.equal(catalog.images.length, 2, 'catalog preserves both occurrences of shared image bytes');
  assert.deepEqual(catalog.images.map(image => image.resourceId), manifest.resources.map(resource => resource.id));
  const picked = await fetch(endpoint + '/choose-media', { method: 'POST', headers, body: JSON.stringify({ ...request, name: catalog.images[0].name }) }); assert.equal(picked.status, 200);
  const selected = await picked.json(), preview = await fetch(base + selected.preview);
  assert.equal(preview.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG);
  stored.document.common.blocks.push({ id: 'binary-block', type: 'big-media', title: '', review: { status: 'unreviewed', reason: '' }, media: [{ id: 'binary-image', originalUrl: selected.url, originalMedia: selected.media }] });
  queue.pageBuilder.write(job.id, stored.revision, stored.document, 1);
  const saved = await fetch(endpoint + '/media/binary-image'); assert.equal(saved.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), PNG);
  assert.equal(queue.stage.media.read(job, attempt).resources[0].mime, 'application/octet-stream', 'display and selection never rewrite declared MIME');
});

test('SSRF rejects private/mapped/metadata/mixed DNS, credentials and protocols; redirects revalidate; size/type/timeout/redirect limits', async t => {
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1']) assert.equal(publicAddress(address), false, address);
  for (const value of ['http://localhost/x','file:///x','http://a:b@public.com/x','http://127.1','http://[::1]/']) await assert.rejects(resolvePublic(new URL(value)));
  await assert.rejects(resolvePublic(new URL('https://example.com'), async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]), /непубличный/);
  const server = await fixtureServer(t), dir = temp(t);
  const result = await server.fetchAsset('https://public.example/redirect', dir); assert.equal(result.sha256, hash(PNG)); assert.equal(result.redirects.length, 1); assert.equal(result.finalUrl, 'https://public.example/ok.png');
  for (const [url, options, pattern] of [['private', {}, /непубличный|Непубличный/], ['loop', {}, /redirect/], ['bad', {}, /HTML|MIME/], ['large', { limits: { ...LIMITS, maxFileBytes: 100 } }, /Лимит/], ['ok.png', { remaining: 1 }, /Лимит/], ['slow', { limits: { ...LIMITS, timeoutMs: 50 } }, /abort|Таймаут/i]]) await assert.rejects(server.fetchAsset(`http://public.example/${url}`, dir, options), pattern);
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
});
test('pause at download boundary, restart and checkpoint resume preserve downloaded objects; partial failures finish with issues; shutdown aborts safely', async t => {
  const server = await fixtureServer(t), ctx = completed(t, { mediaDownload: server.fetchAsset });
  assert.equal(ctx.attempt.htmlMedia.status, 'missing');
  await ctx.queue.stage.media.upload(ctx.job, ctx.attempt, 0, Readable.from([Buffer.from('<img src="/ok.png"><img src="/slow"><img src="/missing"><iframe src="https://example.com/embed"></iframe>')]));
  assert.equal(ctx.attempt.status, 'queued', 'supplying missing HTML automatically joins the queue');
  ctx.queue.pump(); await server.started; ctx.queue.pause(ctx.job.id);
  assert.equal(ctx.attempt.status, 'pausing'); assert.equal(ctx.queue.active.size, 1); server.release(); await ctx.queue.active.get(ctx.job.id).completion;
  assert.equal(ctx.attempt.status, 'paused'); assert.equal(ctx.attempt.htmlMedia.downloaded, 2); assert.equal(ctx.attempt.htmlMedia.pending, 1);
  const manifest = ctx.queue.stage.media.read(ctx.job, ctx.attempt, true), object = manifest.resources[0].object, mtime = fs.statSync(path.join(ctx.queue.stage.media.directory(ctx.job, ctx.attempt), object)).mtimeMs;
  assert.equal(fs.existsSync(path.join(ctx.queue.stage.media.directory(ctx.job, ctx.attempt), 'images')), false, 'stage 2 keeps only verified objects');
  await ctx.queue.shutdown();
  const queue = new Queue({ root: ctx.root, autoStart: false, mediaDownload: server.fetchAsset }); t.after(() => queue.shutdown());
  const job = queue.jobs[0], attempt = job.attempts[0]; assert.equal(queue.snapshot('').jobs[0].canResume, true); queue.resume(job.id); queue.pump(); await queue.active.get(job.id).completion;
  assert.equal(attempt.status, 'complete'); assert.equal(attempt.htmlMedia.status, 'ready_with_issues'); assert.deepEqual(server.hits, ['/ok.png','/slow','/missing']); assert.equal(fs.statSync(path.join(queue.stage.media.directory(job, attempt), object)).mtimeMs, mtime);
  assert.equal(Object.hasOwn(queue.snapshot('').jobs[0].attempts[0].htmlMedia, 'resources'), false);
  for (const [file, expected] of ctx.proof) assert.equal(hash(fs.readFileSync(file)), expected);
  await queue.stage.media.upload(job, attempt, attempt.htmlMedia.revision, Readable.from([Buffer.from('<img src="/slow">')]));
  assert.equal(fs.existsSync(path.join(queue.stage.media.directory(job, attempt), 'images')), false, 'new revision has no image copies');
  queue.resume(job.id); queue.pump(); await new Promise(resolve => setTimeout(resolve, 50)); await queue.shutdown();
  assert.equal(queue.active.size, 0); assert.equal(attempt.status, 'paused'); assert.equal(queue.stage.media.read(job, attempt).resources[0].status, 'pending');
});
test('completed legacy octet-stream PNG stays selectable from its object without rewriting evidence', async t => {
  const { queue, job, attempt } = completed(t);
  const manifest = queue.stage.media.create(job, attempt, Buffer.from('<img src="/legacy.png">'), 'test');
  const sha256 = hash(PNG), dir = queue.stage.media.directory(job, attempt), object = path.join(dir, 'objects', sha256);
  fs.writeFileSync(object, PNG);
  Object.assign(manifest.resources[0], { status: 'downloaded', mime: 'application/octet-stream', bytes: PNG.length, sha256, object: `objects/${sha256}` });
  manifest.status = 'complete'; queue.stage.media.publish(job, attempt, manifest); attempt.status = 'complete'; queue.save();
  const evidence = ['manifest.json', 'source.html', `objects/${sha256}`].map(name => { const file = path.join(dir, name); return { file, bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }; });
  const assertEvidence = () => { for (const item of evidence) { assert.deepEqual(fs.readFileSync(item.file), item.bytes); assert.equal(fs.statSync(item.file).mtimeMs, item.mtime); } };
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, route = `${base}/api/html-media/${job.id}/1/1`;
  const projected = await (await fetch(route + '/manifest')).json();
  assert.equal(projected.resources[0].mime, 'application/octet-stream'); assert.equal(projected.resources[0].detectedMime, 'image/png');
  assertEvidence(); assert.equal(fs.existsSync(path.join(dir, 'images')), false);
  const response = await fetch(`${route}/objects/${sha256}`);
  assert.equal(response.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  const stored = queue.pageBuilder.read(job.id), request = { revision: stored.revision, attempt: 1, htmlRevision: 1 };
  const catalog = queue.mediaPicker.catalog(job.id, request);
  assert.equal(catalog.images.length, 1); assert.match(catalog.images[0].name, /\.png$/);
  const selected = queue.mediaPicker.choose(job.id, request, catalog.images[0].name);
  assertEvidence();
  stored.document.common.blocks.push({ id: 'legacy-block', type: 'big-media', title: '', review: { status: 'unreviewed', reason: '' }, media: [{ id: 'legacy-image', originalUrl: selected.url, originalMedia: selected.media }] });
  queue.pageBuilder.write(job.id, stored.revision, stored.document, 1);
  const preview = await fetch(`${base}/api/page-builder/${job.id}/media/legacy-image`);
  assert.equal(preview.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), PNG); assertEvidence();
  const altered = Buffer.from(PNG); altered[altered.length - 1] ^= 1; fs.writeFileSync(object, altered);
  assert.throws(() => queue.mediaPicker.resolve(job.id, selected.media), /checksum|изменено/);
});

test('unfinished HTML revision resumes from objects without creating image copies', async t => {
  const ctx = completed(t), { queue, job, attempt } = ctx;
  const manifest = queue.stage.media.create(job, attempt, Buffer.from('<img src="/photo.png">'), 'test');
  const sha256 = hash(PNG), dir = queue.stage.media.directory(job, attempt);
  fs.writeFileSync(path.join(dir, 'objects', sha256), PNG);
  Object.assign(manifest.resources[0], { status: 'downloaded', mime: 'image/png', bytes: PNG.length, sha256, object: `objects/${sha256}` });
  manifest.status = 'running'; queue.stage.media.publish(job, attempt, manifest); attempt.status = 'running'; queue.save();
  const restored = new Queue({ root: ctx.root, autoStart: false }); t.after(() => restored.shutdown());
  const recovered = restored.jobs[0].attempts[0];
  assert.equal(recovered.status, 'queued'); assert.equal(fs.existsSync(path.join(dir, 'images')), false);
  restored.pump(); await restored.active.get(job.id)?.completion;
  assert.equal(recovered.status, 'complete');
  assert.equal(restored.stage.media.read(restored.jobs[0], recovered, true).status, 'complete');
  assert.equal(fs.existsSync(path.join(dir, 'images')), false);
});

test('local non-raster downloads preserve safe filenames and reject header/path injection without bypassing object checks', async t => {
  const { queue, job, attempt } = completed(t), bytes = Buffer.from('%PDF-1.7\nfixture'), sha256 = hash(bytes);
  const manifest = queue.stage.media.create(job, attempt, Buffer.from('<a href="/manual.pdf" download>Manual</a>'), 'test');
  const item = manifest.resources[0], dir = queue.stage.media.directory(job, attempt), object = path.join(dir, 'objects', sha256);
  fs.writeFileSync(object, bytes);
  Object.assign(item, { status: 'downloaded', mime: 'application/pdf', bytes: bytes.length, sha256, object: `objects/${sha256}` });
  manifest.status = 'complete'; queue.stage.media.publish(job, attempt, manifest); attempt.status = 'complete'; queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/html-media/${job.id}/1`, route = `${base}/1/objects/${sha256}`;
  const cases = [
    { label: 'Russian download attribute takes priority', declared: 'Прайс-лист 2026.pdf', expected: 'Прайс-лист 2026.pdf', ascii: 'file.pdf' },
    { label: 'safe ASCII name', declared: 'manual (2026).pdf', expected: 'manual (2026).pdf', ascii: 'manual (2026).pdf' },
    { label: 'RFC 5987 reserved characters', declared: "O'Brien(2026).pdf", expected: "O'Brien(2026).pdf", ascii: 'file.pdf' },
    { label: 'decoded resolved URL path ignores query and fragment', resolved: 'https://fixture.reestr35.ru/docs/%D0%9F%D1%80%D0%B0%D0%B9%D1%81%20(2).pdf?name=wrong.exe#other', expected: 'Прайс (2).pdf', ascii: 'file.pdf' },
    { label: 'original URL after unusable resolved basename', resolved: 'https://fixture.reestr35.ru/', original: 'https://fixture.reestr35.ru/original.pdf', expected: 'original.pdf', ascii: 'original.pdf' },
    { label: 'MIME fallback', resolved: 'https://fixture.reestr35.ru/', original: 'invalid URL', expected: 'Файл.pdf', ascii: 'file.pdf' },
    { label: 'unknown MIME fallback', resolved: 'https://fixture.reestr35.ru/', original: '', mime: 'application/octet-stream', expected: 'Файл', ascii: 'file' },
    ...['bad\r\nX-Injected: yes.pdf', '../secret.pdf', '..\\secret.pdf', 'C:\\secret.pdf', 'nul.pdf', 'COM1.pdf', 'file\u0000.pdf', 'file\u202e.pdf', 'file\ud800.pdf', 'file.pdf.', '.', '..', 'a'.repeat(241) + '.pdf'].map(declared => ({ label: `unsafe attribute ${JSON.stringify(declared)}`, declared, expected: 'manual.pdf', ascii: 'manual.pdf' })),
    ...['..%2Fsecret.pdf', '..%5Csecret.pdf', 'bad%0D%0AX-Injected%3Ayes.pdf', '%FF.pdf'].map(basename => ({ label: `unsafe encoded URL ${basename}`, resolved: `https://fixture.reestr35.ru/${basename}`, original: '', expected: 'Файл.pdf', ascii: 'file.pdf' })),
  ];
  for (const entry of cases) await t.test(entry.label, async () => {
    Object.assign(item, { mime: entry.mime || 'application/pdf', resolvedUrl: entry.resolved ?? 'https://fixture.reestr35.ru/manual.pdf', originalUrl: entry.original ?? 'https://fixture.reestr35.ru/original.pdf', occurrence: { ...item.occurrence, downloadFilename: entry.declared || '' } });
    queue.stage.media.publish(job, attempt, manifest);
    const response = await fetch(route), disposition = response.headers.get('content-disposition');
    assert.equal(response.status, 200);
    const encoded = encodeURIComponent(entry.expected).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
    assert.equal(disposition, `attachment; filename="${entry.ascii}"; filename*=UTF-8''${encoded}`);
    assert.equal(response.headers.get('x-injected'), null);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.match(response.headers.get('content-security-policy'), /sandbox/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  });
  assert.equal((await fetch(`${base}/2/objects/${sha256}`)).status, 404, 'stale revision remains rejected');
  assert.equal((await fetch(`${base}/1/objects/${'0'.repeat(64)}`)).status, 404, 'unlisted objects remain inaccessible');
  fs.writeFileSync(object, Buffer.from('%PDF-1.7\nchanged'));
  const changed = await fetch(route); assert.equal(changed.status, 400); assert.match((await changed.json()).error, /checksum/);
});

test('local download resourceId selects an exact occurrence of shared bytes and rejects invalid selectors', async t => {
  const { queue, job, attempt } = completed(t), bytes = Buffer.from('%PDF-1.7\nshared'), sha256 = hash(bytes);
  const otherBytes = Buffer.from('%PDF-1.7\nother'), otherHash = hash(otherBytes);
  const manifest = queue.stage.media.create(job, attempt, Buffer.from('<a href="/shared.pdf" download="Первое.pdf">First</a><a href="/shared.pdf" download="Второе.pdf">Second</a><a href="/other.pdf" download>Other</a><a href="/failed.pdf" download>Failed</a>'), 'test');
  const dir = queue.stage.media.directory(job, attempt), object = path.join(dir, 'objects', sha256);
  fs.writeFileSync(object, bytes); fs.writeFileSync(path.join(dir, 'objects', otherHash), otherBytes);
  for (const item of manifest.resources) Object.assign(item, { status: item.id === 4 ? 'failed' : 'downloaded', mime: 'application/pdf', bytes: item.id === 3 ? otherBytes.length : bytes.length, sha256: item.id === 3 ? otherHash : sha256, object: `objects/${item.id === 3 ? otherHash : sha256}` });
  manifest.status = 'ready_with_issues'; queue.stage.media.publish(job, attempt, manifest); attempt.status = 'complete'; queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/html-media/${job.id}/1`, route = `${base}/1/objects/${sha256}`;
  for (const [query, name] of [['', 'Первое.pdf'], ['?resourceId=1', 'Первое.pdf'], ['?resourceId=2', 'Второе.pdf']]) {
    const response = await fetch(route + query);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="file.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  for (const selector of ['', '0', '01', '-1', '1.1', '1e0', '9007199254740992', '1&resourceId=2', '1%0D%0A']) {
    assert.equal((await fetch(`${route}?resourceId=${selector}`)).status, 400, `malformed selector ${selector}`);
  }
  for (const selector of ['3', '4', '999']) assert.equal((await fetch(`${route}?resourceId=${selector}`)).status, 404, `unavailable occurrence ${selector}`);
  assert.equal((await fetch(`${base}/2/objects/${sha256}?resourceId=2`)).status, 404, 'selected occurrence cannot bypass revision');
  fs.writeFileSync(object, Buffer.from('%PDF-1.7\nspoof!'));
  const changed = await fetch(`${route}?resourceId=2`); assert.equal(changed.status, 400); assert.match((await changed.json()).error, /checksum/);
});

test('upload API authenticates Origin/CSRF and stale attempt/revision; source remains exact bytes and cannot execute same-origin', async t => {
  const ctx = completed(t), server = createServer(ctx.queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, state = await (await fetch(base + '/api/state')).json(), route = `/api/html-media/${ctx.job.id}/1`;
  const source = Buffer.from('<html>\r\n<script>window.SOURCE_EXECUTED=true</script><p>Текст</p></html>');
  const post = (overrides = {}, body = source) => fetch(base + route + '/upload', { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream', Origin: base, 'x-csrf-token': state.csrfToken, 'x-html-revision': '0', ...overrides } });
  assert.equal((await post({ Origin: 'https://evil.example' })).status, 403); assert.equal((await post({ 'x-csrf-token': 'bad' })).status, 403); assert.equal((await post()).status, 200); assert.equal((await post()).status, 409);
  const original = await fetch(base + route + '/1/source'); assert.match(original.headers.get('content-disposition'), /attachment/); assert.equal(original.headers.get('content-type'), 'application/octet-stream'); assert.match(original.headers.get('content-security-policy'), /sandbox/); assert.deepEqual(Buffer.from(await original.arrayBuffer()), source);
  const code = await (await fetch(base + route + '/1/code')).json(); assert.equal(code.text, source.toString('utf8')); assert.equal(ctx.attempt.status, 'queued'); assert.equal(ctx.queue.snapshot('').jobs[0].canResume, false);
  ctx.queue.pause(ctx.job.id); ctx.queue.retry(ctx.job.id); assert.equal((await post({ 'x-html-revision': '1' })).status, 409);
});
test('in-flight upload fences Continue/retry, size rejection preserves old revision; failed bytes consume aggregate budget', async t => {
  const fixture = await fixtureServer(t), ctx = completed(t, { mediaDownload: fixture.fetchAsset, mediaLimits: { maxHtmlBytes: 100, maxTotalBytes: 100 } });
  const input = new PassThrough(), pending = ctx.queue.stage.media.upload(ctx.job, ctx.attempt, 0, input);
  assert.throws(() => ctx.queue.resume(ctx.job.id), { statusCode: 409 }); assert.throws(() => ctx.queue.retry(ctx.job.id), { statusCode: 409 });
  input.end('<img src="/large"><img src="/ok.png">'); await pending;
  const original = ctx.queue.stage.media.directory(ctx.job, ctx.attempt);
  ctx.queue.pause(ctx.job.id);
  await assert.rejects(ctx.queue.stage.media.upload(ctx.job, ctx.attempt, 1, Readable.from([Buffer.alloc(101)])), /лимит/);
  assert.equal(ctx.attempt.htmlMedia.revision, 1); assert.ok(fs.existsSync(path.join(original, 'source.html')));
  ctx.queue.resume(ctx.job.id); ctx.queue.pump(); await ctx.queue.active.get(ctx.job.id).completion;
  assert.equal(ctx.attempt.htmlMedia.status, 'ready_with_issues'); assert.deepEqual(fixture.hits, ['/large']); assert.equal(ctx.attempt.htmlMedia.issues, 2);
});
test('durable object checkpoint survives failed state projection and is not fetched again', async t => {
  const fixture = await fixtureServer(t), ctx = completed(t, { mediaDownload: fixture.fetchAsset });
  await ctx.queue.stage.media.upload(ctx.job, ctx.attempt, 0, Readable.from([Buffer.from('<img src="/first.png"><img src="/second.png">')]));
  const save = ctx.queue.save.bind(ctx.queue); let injected = false;
  ctx.queue.save = () => { if (ctx.attempt.htmlMedia.downloaded === 1 && !injected) { injected = true; throw new Error('injected state failure'); } return save(); };
  ctx.queue.pump(); await ctx.queue.active.get(ctx.job.id).completion;
  assert.equal(ctx.attempt.status, 'interrupted'); assert.equal(ctx.queue.stage.media.read(ctx.job, ctx.attempt, true).resources[0].status, 'downloaded');
  ctx.queue.resume(ctx.job.id); ctx.queue.pump(); await ctx.queue.active.get(ctx.job.id).completion;
  assert.equal(ctx.attempt.status, 'complete'); assert.deepEqual(fixture.hits, ['/first.png','/second.png']);
});
browserTest('shared modal restores exact HTML/image trigger after checkpoint polling, with revision, disabled and hidden guards', { timeout: 30000 }, async t => {
  const fixture = await fixtureServer(t), ctx = completed(t, { mediaDownload: fixture.fetchAsset }), server = createServer(ctx.queue);
  const source = Buffer.from('<img src="/first.png"><img src="/second.png">');
  await ctx.queue.stage.media.upload(ctx.job, ctx.attempt, 0, Readable.from([source]));
  ctx.queue.pump(); await ctx.queue.active.get(ctx.job.id).completion;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close()); const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.locator('#stage-step-2').click(); await page.locator('#html-media-accordion summary').first().click();
  const html = page.locator('.html-source-card'), images = page.locator('#html-media-content button[aria-label^="Открыть изображение"]');
  async function open(trigger) { await trigger.click(); await page.waitForFunction(() => document.querySelector('#media-modal').classList.contains('show') && document.activeElement.closest('#media-modal')); }
  async function close() {
    const hidden = page.evaluate(() => new Promise(resolve => document.querySelector('#media-modal').addEventListener('hidden.bs.modal', () => resolve(), { once: true })));
    await page.keyboard.press('Escape'); await hidden;
  }
  for (const [trigger, next, crossesAccordion] of [[html, images.first(), true], [images.first(), images.nth(1), false]]) {
    const original = await trigger.elementHandle(), identity = await trigger.getAttribute('data-media-trigger'); await open(trigger);
    const manifest = ctx.queue.stage.media.read(ctx.job, ctx.attempt); ctx.queue.stage.media.publish(ctx.job, ctx.attempt, manifest);
    await page.waitForFunction(element => !element.isConnected, original); await page.waitForFunction(identity => [...document.querySelectorAll('[data-media-trigger]')].some(node => node.dataset.mediaTrigger === identity), identity);
    await close(); assert.equal(await trigger.evaluate(node => document.activeElement === node), true, 'hidden transition restores the replacement, not BODY');
    await page.keyboard.press('Tab');
    if (crossesAccordion) { assert.equal(await page.locator('#html-media-accordion summary').first().evaluate(node => document.activeElement === node), true, 'the accordion heading joins the keyboard sequence'); await page.keyboard.press('Tab'); }
    assert.equal(await next.evaluate(node => document.activeElement === node), true, 'next Tab stays in the HTML/media cards');
  }
  // Connected originals still restore normally; disabled or hidden cards do not.
  await open(html); await close(); assert.equal(await html.evaluate(node => document.activeElement === node), true);
  await open(html); await html.evaluate(node => { node.disabled = true; }); await close(); assert.equal(await html.evaluate(node => document.activeElement === node), false); await html.evaluate(node => { node.disabled = false; });
  await open(html); await page.locator('#stage-step-1').evaluate(node => node.click()); await close(); assert.equal(await html.evaluate(node => document.activeElement === node), false); await page.locator('#stage-step-2').click();
  const old = await html.elementHandle(); await open(html); await ctx.queue.stage.media.upload(ctx.job, ctx.attempt, ctx.attempt.htmlMedia.revision, Readable.from([source]));
  await page.waitForFunction(element => !element.isConnected, old); await close(); assert.equal(await html.evaluate(node => document.activeElement === node), false, 'another source revision must not receive old modal focus');
  const previousAttempt = await html.elementHandle(); await open(html); ctx.queue.newAttempt(ctx.job); ctx.queue.save();
  await page.waitForFunction(() => document.querySelector('#attempt-select option[value="2"]'));
  await page.locator('#attempt-select').evaluate(node => { node.value = '2'; node.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(JSON.parse(await html.getAttribute('data-media-trigger'))[1], 2);
  await page.waitForFunction(element => !element.isConnected, previousAttempt); await close(); assert.equal(await html.evaluate(node => document.activeElement === node), false, 'another attempt must not receive old modal focus');
  assert.deepEqual(errors, []);
});
browserTest('missing HTML warning retains focus and tooltip across another running job duration heartbeat', { timeout: 15000 }, async t => {
  const ctx = completed(t); ctx.queue.add('https://running.reestr35.ru/');
  const running = ctx.queue.jobs[1], attempt = running.attempts[0];
  Object.assign(attempt, { status: 'running', startedAt: new Date().toISOString() }); ctx.queue.save();
  const server = createServer(ctx.queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator(`[data-job-select="${running.id}"]`).click();
  const initialDuration = await page.locator('#attempt-duration').innerText(), initialElapsed = attempt.activeDurationMs;
  const warning = page.locator(`[data-job-id="${ctx.job.id}"] .queue-status-control`);
  await warning.focus(); await page.waitForSelector('.tooltip.show');
  const original = await warning.elementHandle();
  // Duration checkpoints must update the clock without replacing status nodes
  // or interrupting keyboard focus and tooltip visibility.
  while (attempt.activeDurationMs < initialElapsed + 1500) await page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  await page.waitForFunction(initial => document.querySelector('#attempt-duration').textContent !== initial, initialDuration);
  assert.equal(await original.evaluate(element => element.isConnected && document.activeElement === element), true, 'duration-only snapshots preserve the original warning node and focus');
  assert.ok(attempt.activeDurationMs >= initialElapsed + 1500, 'the real duration heartbeat advanced');
  assert.equal(await warning.evaluate(node => document.activeElement === node), true);
  assert.equal(await warning.getAttribute('aria-label'), 'HTML не найден.');
  assert.equal(await page.locator('.tooltip.show').innerText(), 'HTML не найден.');
  assert.notEqual(await page.locator('#attempt-duration').innerText(), initialDuration, 'restoring warning focus does not freeze the selected task timer');
  assert.equal(await page.locator('#detail-url').innerText(), running.url.replace(/^https?:\/\//i, '').replace(/\/+$/, ''), 'focus restoration does not change selection');
  assert.deepEqual(errors, []);
});

browserTest('missing HTML warning is keyboard accessible and upload resumes automatically; iframe gallery previews, modal copy and cleanup', { timeout: 30000 }, async t => {
  const fixture = await fixtureServer(t), ctx = completed(t, { mediaDownload: fixture.fetchAsset }), server = createServer(ctx.queue);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
  page.setDefaultTimeout(5000);
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } } }));
  await page.route('https://player.vimeo.com/video/fixture**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Frame preview</h1><script>try { parent.FRAME_ESCAPED = true; } catch {}</script>' }));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click();
  const warning = page.locator('#jobs-body .queue-status-control');
  assert.equal(await warning.locator('button').getAttribute('data-icon'), 'alert');
  assert.match(await warning.locator('button').getAttribute('class'), /text-yellow/);
  assert.equal(await warning.getAttribute('aria-label'), 'HTML не найден.');
  await warning.focus(); await page.waitForSelector('.tooltip.show'); assert.equal(await page.locator('.tooltip.show').innerText(), 'HTML не найден.');
  await page.locator('#stage-step-2').click();
  const iframe1 = '<iframe src="https://player.vimeo.com/video/fixture" width="560" title="First"></iframe>';
  const iframe2 = '<iframe src="https://player.vimeo.com/video/fixture?second=1" width="900" title="Second" allowfullscreen=""></iframe>';
  const templateFrame = '<iframe src="https://player.vimeo.com/video/fixture" title="Nested template"></iframe>';
  const source = Buffer.from(`<img src="/first.png"><template><template>${templateFrame}</template></template>${iframe1}${iframe2}`);
  ctx.queue.autoStart = true;
  await page.locator('#html-media-content input[type=file]').setInputFiles({ name: 'source.html', mimeType: 'text/html', buffer: source });
  await page.waitForFunction(() => document.querySelector('#jobs-body button[data-job-action]').dataset.status === 'complete');
  assert.equal(ctx.attempt.status, 'complete'); assert.equal(ctx.attempt.htmlMedia.downloaded, 1);
  assert.deepEqual(posts, [`/api/html-media/${ctx.job.id}/1/upload`], 'upload resumes on the server without a second browser action');
  for (const [file, expected] of ctx.proof) assert.equal(hash(fs.readFileSync(file)), expected);
  const sections = page.locator('#html-media-accordion details');
  await sections.filter({ hasText: 'Изображения' }).locator('summary').click();
  await sections.filter({ hasText: 'Внешние встраивания' }).locator('summary').click();
  const frames = page.getByRole('button', { name: /^Открыть iframe/ });
  assert.equal(await frames.count(), 3);
  assert.equal(await page.locator('#html-media-content a').filter({hasText:'Открыть у источника'}).count(),0);
  assert.equal(await frames.evaluateAll(nodes=>nodes.every(node=>node.closest('.image-card').children.length === 1)),true,'iframe cards contain only the clickable preview');
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    const sizes = await page.locator('#html-media-content .gallery-thumb').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    assert.equal(sizes.length, 4); for (const size of sizes.slice(1)) { assert.ok(Math.abs(size.width - sizes[0].width) < 1); assert.equal(size.height, sizes[0].height); }
    for (let index = 0; index < await frames.count(); index++) await frames.nth(index).frameLocator('iframe').getByRole('heading', { name: 'Frame preview' }).waitFor();
    if (width === 375) await sections.filter({ hasText: 'Внешние встраивания' }).scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(testOutput(), `ui-iframe-gallery-${width}.png`), fullPage: width !== 375 });
  }
  assert.equal(await frames.first().locator('iframe').getAttribute('tabindex'), '-1');
  await frames.nth(2).focus(); await page.keyboard.press('Enter'); await page.waitForSelector('#media-modal.show');
  await page.frameLocator('#media-modal-body iframe').getByRole('heading', { name: 'Frame preview' }).waitFor();
  assert.equal(await page.evaluate(() => window.FRAME_ESCAPED), undefined);
  assert.equal(await page.locator('#media-modal-body iframe').getAttribute('sandbox'), 'allow-scripts allow-presentation allow-same-origin');
  assert.equal(await page.locator('#media-modal-body iframe').evaluate(frame => frame.credentialless), true);
  assert.equal(await page.locator('#media-navigation').isHidden(), true); assert.equal(await page.locator('#media-download').isHidden(), true);
  await page.locator('#media-copy').click(); assert.equal(await page.evaluate(() => window.copied), iframe2);
  const external = page.locator('#media-external');
  assert.equal(await external.getAttribute('href'),'https://player.vimeo.com/video/fixture?second=1');
  assert.equal(await external.getAttribute('target'),'_blank'); assert.equal(await external.getAttribute('rel'),'noopener noreferrer');
  assert.equal(await external.getAttribute('aria-label'),'Открыть у источника'); assert.equal(await external.innerText(),''); assert.equal(await external.locator('svg').count(),1);
  await external.focus(); await page.getByRole('tooltip',{name:'Открыть у источника',exact:true}).waitFor();
  await page.locator('#media-modal-title').click();
  for (const width of [1440,320,375]) {
    await page.setViewportSize({width,height:1000});
    const geometry = await page.locator('#media-modal .modal-header').evaluate(header=>{
      const box=header.getBoundingClientRect(),title=header.querySelector('.modal-title').getBoundingClientRect(),copy=header.querySelector('#media-copy').getBoundingClientRect(),external=header.querySelector('#media-external').getBoundingClientRect(),close=header.querySelector('.btn-close').getBoundingClientRect();
      return {fits:title.right<=copy.left && copy.right<=external.left && external.right<=close.left && close.right<=box.right, sameSize:copy.width===external.width && copy.height===external.height, overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.deepEqual(geometry,{fits:true,sameSize:true,overflow:false},`iframe modal compact actions at ${width}px`);
    await page.screenshot({path:path.join(testOutput(),`ui-iframe-modal-${width}.png`)});
  }
  ctx.attempt.htmlMedia.checkpoint++; ctx.queue.save();
  await page.waitForFunction(()=>!document.querySelector('#media-external').hasAttribute('href'));
  assert.equal(await external.isHidden(),true,'checkpoint rerender clears the old source URL');
  await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#media-modal-title').innerText(), 'https://player.vimeo.com/video/fixture?second=1');
  const hidden = page.evaluate(() => new Promise(resolve => document.querySelector('#media-modal').addEventListener('hidden.bs.modal', resolve, { once: true })));
  await page.keyboard.press('Escape'); await hidden;
  assert.equal(await page.locator('#media-modal-body iframe').count(), 0, 'closing unloads the player');
  assert.equal(await external.isHidden(),true); assert.equal(await external.getAttribute('href'),null);
  assert.equal(await frames.nth(2).evaluate(node => node === document.activeElement), true);
  for (const [index, expected] of [[0, templateFrame], [1, iframe1]]) {
    await frames.nth(index).click(); await page.locator('#media-copy').click(); assert.equal(await page.evaluate(() => window.copied), expected);
    assert.equal(await external.getAttribute('href'),'https://player.vimeo.com/video/fixture','opening a different occurrence replaces the source URL');
    const closed = page.evaluate(() => new Promise(resolve => document.querySelector('#media-modal').addEventListener('hidden.bs.modal', resolve, { once: true })));
    await page.keyboard.press('Escape'); await closed;
  }
  await page.getByRole('button', { name: /^Открыть изображение/ }).click(); await page.waitForSelector('#media-modal.show');
  assert.equal(await page.locator('#media-download').isVisible(), true); assert.equal(await page.locator('#media-navigation').isVisible(), true);
  assert.equal(await external.isHidden(),true); assert.equal(await external.getAttribute('href'),null);
  await page.locator('#media-modal .btn-close').click(); await page.waitForSelector('#media-modal',{state:'hidden'}); await page.waitForSelector('.modal-backdrop',{state:'hidden'});
  await page.locator('.html-source-card').click(); await page.waitForSelector('#media-modal-body .cm-content');
  assert.equal(await external.isHidden(),true); assert.equal(await external.getAttribute('href'),null);
  assert.deepEqual(errors, []);
});

test('missing HTML upload queues behind existing work and leaves rejected uploads paused', async t => {
  const ctx = completed(t);
  await assert.rejects(ctx.queue.stage.media.upload(ctx.job, ctx.attempt, 0, Readable.from([])), /пуст/);
  assert.equal(ctx.attempt.status, 'paused'); assert.equal(ctx.attempt.htmlMedia.status, 'missing');
  ctx.queue.add('https://later.reestr35.ru/'); const waiting = ctx.queue.jobs[1].attempts[0];
  await ctx.queue.stage.media.upload(ctx.job, ctx.attempt, 0, Readable.from([Buffer.from('<p>Ready</p>')]));
  assert.equal(ctx.attempt.status, 'queued'); assert.ok(ctx.attempt.queueOrder > waiting.queueOrder);
  assert.equal(ctx.queue.stage.media.uploads.size, 0); assert.equal(ctx.queue.active.size, 0);
});

browserTest('real offline editors, simplified read-only trees/folding, neutral actions, gallery parity and responsive modal navigation', { timeout: 90000 }, async t => {
  const fixture = await fixtureServer(t), ctx = completed(t, { mediaDownload: fixture.fetchAsset }), server = createServer(ctx.queue);
  const source = Buffer.from('<section><h2>Heading</h2><div><img src="/first.png"><img src="/second.png"><iframe src="https://example.com/embed"></iframe><object data="legacy.swf"></object></div></section>');
  await ctx.queue.stage.media.upload(ctx.job, ctx.attempt, 0, Readable.from([source])); ctx.queue.pump(); await ctx.queue.active.get(ctx.job.id).completion;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close()); const page = await browser.newPage(), errors = [], network = [], geometry = [], modalNavigation = new Map(); page.setDefaultTimeout(5000);
  const origin = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => network.push(request.url()));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; }, write: async items => { window.copied = (await items[0].getType('image/png')).type; } } }));
  await page.goto(origin); await page.locator('#jobs-body tr').first().click();
  async function close(id) { await page.locator(`#${id} .btn-close`).click(); await page.waitForSelector(`#${id}`, { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); }
  async function shot(name, width, modal) {
    await page.mouse.move(0,0);
    if (modal) {
      await page.waitForFunction(id => { const node = document.getElementById(id); return getComputedStyle(node).opacity === '1' && getComputedStyle(node.querySelector('.modal-dialog')).transform === 'none'; }, modal);
      const value = await page.locator(`#${modal} .modal-header`).evaluate(node => { const r = node.getBoundingClientRect(), heading = node.querySelector('.detail-heading, .modal-title').getBoundingClientRect(), actions = node.querySelector('.modal-actions').getBoundingClientRect(), close = node.querySelector('.btn-close').getBoundingClientRect(), title = node.querySelector('.modal-title').getBoundingClientRect(), counter = node.querySelector('.image-counter'); return { width: innerWidth, scroll: document.documentElement.scrollWidth, overlap: heading.right > actions.left || actions.right > close.left || close.right > r.right, counterDelta: counter?.textContent ? Math.abs(counter.getBoundingClientRect().top + counter.getBoundingClientRect().height / 2 - title.top - title.height / 2) : 0 }; });
      geometry.push({ name, ...value }); assert.equal(value.overlap, false, `${name} ${width}`); assert.ok(value.counterDelta <= 2); assert.ok(value.scroll <= width);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(testOutput(), `${name}-${width}.png`), fullPage: !modal });
  }
  for (const width of [1440,390,375,360,320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 }); await page.locator('#stage-step-1').click();
    const qaProgressStyle = await page.locator('#qa-progress').evaluate(node => { const style = getComputedStyle(node); return { maxWidth: style.maxWidth, minWidth: style.minWidth, flexBasis: style.flexBasis, transform: style.transform }; });
    assert.equal(await page.locator('#png-gallery .card-body, #png-gallery .card-title').count(), 0);
    const pngGeometry = await page.locator('#png-gallery .image-card').first().evaluate(node => { const r = node.getBoundingClientRect(), img = node.querySelector('img'), style = getComputedStyle(img), button = getComputedStyle(node.querySelector('button')); return { width: r.width, rowWidth: node.parentElement.parentElement.getBoundingClientRect().width, columnWidth: node.parentElement.getBoundingClientRect().width, height: r.height, imageHeight: img.getBoundingClientRect().height, fit: style.objectFit, padding: button.padding, buttonBorderY: parseFloat(button.borderTopWidth) + parseFloat(button.borderBottomWidth) }; });
    await shot('editors-step1', width); await page.locator('#png-gallery button').first().click(); await page.waitForSelector('#png-modal.show');
    modalNavigation.set(width, await page.locator('#png-modal .modal-footer .btn-list').evaluate(node => node.getBoundingClientRect().left));
    assert.equal(await page.locator('#png-modal .image-status, #png-status').count(), 0); await shot('editors-png', width, 'png-modal'); await close('png-modal');
    await page.getByRole('button', { name: 'Открыть capture-report.json', exact: true }).click(); await page.waitForSelector('#json-output .jse-main');
    assert.equal(await page.locator('#json-output .cm-editor').count(), 0, 'JSON opens real tree mode');
    assert.equal(await page.locator('#json-output .jse-menu, #json-output .jse-navigation-bar, #json-output .jse-status-bar').count(), 0, 'JSON tree has no toolbar or auxiliary bars');
    assert.equal(await page.locator('#json-output button[title*="Search"], #json-output button[title="Collapse all"], #json-output button[title="Expand all"]').count(), 0, 'JSON tree has no search or global menu actions');
    assert.equal(await page.locator('#json-output').getByText('text', { exact: true }).count(), 0, 'JSON tree has no mode switch');
    if (width === 1440) {
      const treeToggle = page.locator('#json-output button.jse-expand').first(), expandedNodes = await page.locator('#json-output .jse-json-node').count(); assert.ok(expandedNodes > 1, 'JSON tree starts expanded');
      await treeToggle.click(); assert.ok(await page.locator('#json-output .jse-json-node').count() < expandedNodes, 'JSON tree nodes remain individually collapsible'); await treeToggle.click();
      const jsonValue = page.locator('#json-output').getByText('complete', { exact: true }).first(); await jsonValue.dblclick(); await page.keyboard.type('MUTATION'); assert.doesNotMatch(await page.locator('#json-output').innerText(), /MUTATION/);
      for (const shortcut of ['Control+f', 'Control+h', 'Meta+f', 'Meta+h']) { await jsonValue.click(); await page.keyboard.press(shortcut); assert.equal(await page.locator('#json-output input[placeholder="Find"], #json-output input[placeholder="Replace"]').count(), 0, `${shortcut} cannot open JSON search/replace`); }
      assert.equal(await page.evaluate(() => { const outside = document.querySelector('#detail-url'), event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); outside.dispatchEvent(event); return event.defaultPrevented; }), false, 'browser search shortcut remains unblocked outside JSON viewer');
      const formatted = await page.evaluate(() => window.ArmEditors.text('json-output')); await page.locator('#json-copy').hover(); await page.waitForTimeout(180); const neutralCopy = await page.locator('#json-copy').evaluate(node => getComputedStyle(node).color);
      await page.locator('#json-copy').click(); await page.waitForFunction(() => window.copied === window.ArmEditors.text('json-output')); assert.equal(await page.evaluate(() => window.copied), formatted); assert.equal(await page.locator('#json-copy').evaluate(node => getComputedStyle(node).color), neutralCopy);
      assert.equal(await page.locator('#json-copy').getAttribute('data-state'), '');
      await page.locator('#json-download').hover(); await page.waitForTimeout(180); const neutralDownload = await page.locator('#json-download').evaluate(node => getComputedStyle(node).color);
      const download = page.waitForEvent('download'); await page.locator('#json-download').click(); assert.deepEqual(fs.readFileSync(await (await download).path()), fs.readFileSync(layout(ctx.root,ctx.job,ctx.attempt).report)); assert.equal(await page.locator('#json-download').evaluate(node => getComputedStyle(node).color), neutralDownload);
    }
    await shot('editors-json-tree', width, 'json-modal'); await close('json-modal'); assert.equal(await page.locator('#json-output .jse-main').count(), 0);
    await page.evaluate(() => scrollTo(0, 0));
    const qaProgressRect = await page.locator('#qa-progress [role="progressbar"]').evaluate(node => { const rect = node.getBoundingClientRect(), parent = node.closest('#attempt-header').getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, offsetX: rect.x - parent.x, offsetY: rect.y - parent.y }; });
    await page.locator('#stage-step-2').click(); await page.waitForSelector('#html-media-content .image-card', { state: 'attached' });
    assert.equal(await page.locator('#media-progress').isVisible(), true);
    assert.deepEqual({ downloaded: ctx.attempt.htmlMedia.downloaded, pending: ctx.attempt.htmlMedia.pending, total: ctx.attempt.htmlMedia.total }, { downloaded: 2, pending: 0, total: 4 }, 'external and unsupported resources are processed without being downloaded');
    assert.equal(await page.locator('#media-progress-count').innerText(), '4/4');
    assert.deepEqual(await page.locator('#media-progress [role="progressbar"]').evaluate(node => ({ label: node.getAttribute('aria-label'), now: node.getAttribute('aria-valuenow'), width: node.querySelector('.progress-bar').style.width, segments: node.querySelectorAll('.qa-progress-segment').length, bars: node.querySelectorAll('.progress-bar').length, statusColors: node.querySelectorAll('.bg-green, .bg-red, .bg-secondary, .bg-yellow').length })), { label: 'Обработано 4 из 4 ресурсов', now: '100', width: '100%', segments: 0, bars: 1, statusColors: 0 });
    await page.evaluate(() => scrollTo(0, 0));
    const mediaProgressRect = await page.locator('#media-progress [role="progressbar"]').evaluate(node => { const rect = node.getBoundingClientRect(), parent = node.closest('#attempt-header').getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, offsetX: rect.x - parent.x, offsetY: rect.y - parent.y }; });
    for (const dimension of ['x','offsetX','offsetY','width','height']) assert.ok(Math.abs(mediaProgressRect[dimension] - qaProgressRect[dimension]) <= .5, `${width}px keeps ${dimension} of both progress bars aligned: ${JSON.stringify({ qaProgressRect, mediaProgressRect })}`);
    assert.ok(Math.abs(mediaProgressRect.y - qaProgressRect.y) <= 2, `${width}px keeps the actual DOMRect y within subpixel header wrapping: ${JSON.stringify({ qaProgressRect, mediaProgressRect })}`);
    const sections = page.locator('#html-media-accordion > .html-media-section');
    assert.equal(await sections.count(), 3); assert.deepEqual(await sections.locator('summary > span:first-child').allInnerTexts(), ['Изображения','Внешние встраивания','Ошибки и неподдерживаемые ресурсы']);
    assert.deepEqual(await sections.evaluateAll(nodes => nodes.map(node => node.open)), width === 1440 ? [false,false,false] : [true,false,false], 'sections start collapsed and retain a manual open state across rerenders');
    assert.doesNotMatch(await page.locator('#html-media-content').innerText(), /Готово ·|скачано|осталось|замечаний/i, 'the body has no duplicate status/progress line');
    if (width === 1440) {
      const imageSection = sections.first(), summary = imageSection.locator('summary');
      assert.equal(await imageSection.locator('.accordion-body').isVisible(), false);
      assert.equal(await summary.getAttribute('class').then(value => value.split(/\s+/).includes('collapsed')), true);
      const collapsedChevron = await summary.evaluate(node => { const style = getComputedStyle(node, '::after'); return { content: style.content, width: parseFloat(style.width), height: parseFloat(style.height), borderRight: style.borderRightWidth, transform: style.transform }; });
      assert.equal(collapsedChevron.content, '""'); assert.ok(collapsedChevron.width > 0 && collapsedChevron.height > 0); assert.equal(collapsedChevron.borderRight, '2px'); await summary.click();
      assert.equal(await imageSection.evaluate(node => node.open), true); assert.equal(await imageSection.locator('.accordion-body').isVisible(), true);
      await page.waitForFunction(({ selector, transform }) => getComputedStyle(document.querySelector(selector), '::after').transform !== transform, { selector: '#html-media-accordion > .html-media-section:first-child summary', transform: collapsedChevron.transform });
      const openChevron = await summary.evaluate(node => getComputedStyle(node, '::after').transform); assert.notEqual(openChevron, collapsedChevron.transform, 'the visible chevron rotates with the section state');
      const mediaBox = await page.locator('#media-progress').evaluate(node => { const style = getComputedStyle(node); return { maxWidth: style.maxWidth, minWidth: style.minWidth, flexBasis: style.flexBasis, transform: style.transform }; });
      assert.deepEqual(mediaBox, qaProgressStyle, 'both stages use the same raised progress geometry');
    }
    const mediaGeometry = await page.locator('#html-media-content .image-card').first().evaluate(node => { const r = node.getBoundingClientRect(), img = node.querySelector('img'), style = getComputedStyle(img), button = getComputedStyle(node.querySelector('button')); return { width: r.width, rowWidth: node.parentElement.parentElement.getBoundingClientRect().width, columnWidth: node.parentElement.getBoundingClientRect().width, height: r.height, imageHeight: img.getBoundingClientRect().height, fit: style.objectFit, padding: button.padding, buttonBorderY: parseFloat(button.borderTopWidth) + parseFloat(button.borderBottomWidth) }; });
    assert.equal(mediaGeometry.buttonBorderY, 0, 'step 2 uses the outer card border without a duplicate button border');
    assert.deepEqual({ ...mediaGeometry, width: pngGeometry.width, rowWidth: pngGeometry.rowWidth, columnWidth: pngGeometry.columnWidth, height: mediaGeometry.height + pngGeometry.buttonBorderY, buttonBorderY: pngGeometry.buttonBorderY }, pngGeometry, `gallery content parity ${width}`);
    assert.ok(Math.abs(mediaGeometry.columnWidth / mediaGeometry.rowWidth - pngGeometry.columnWidth / pngGeometry.rowWidth) < .001, `${width}px galleries use the same responsive column fraction`);
    assert.ok(Math.abs((mediaGeometry.columnWidth - mediaGeometry.width) - (pngGeometry.columnWidth - pngGeometry.width)) < 1, `${width}px gallery gutters match within their own container insets`); geometry.push({ name: 'gallery', width, ...mediaGeometry }); await shot('editors-step2', width);
    assert.doesNotMatch(await page.locator('.html-source-card').innerText(), /revision|attempt|попыт/i); await page.locator('.html-source-card').click(); await page.waitForSelector('#media-modal-body .cm-content');
    assert.equal(await page.locator('#media-modal-body .cm-content').getAttribute('contenteditable'), 'false'); assert.ok(await page.locator('#media-modal-body .cm-lineNumbers').count()); assert.ok(await page.locator('#media-modal-body .cm-foldGutter').count()); assert.ok(await page.locator('#media-modal-body .cm-line span').count()); assert.equal(await page.locator('#media-navigation').isHidden(), true);
    assert.equal(await page.locator('#media-modal-body .editor-toolbar, #media-modal-body .cm-search').count(), 0, 'HTML viewer has no search UI');
    assert.deepEqual(await page.locator('#media-modal-body').evaluate(node => ({ outerOverflow: getComputedStyle(node).overflow, outerScrollable: node.scrollHeight > node.clientHeight, innerOverflow: getComputedStyle(node.querySelector('.cm-scroller')).overflow })), { outerOverflow: 'hidden', outerScrollable: false, innerOverflow: 'auto' }, `single HTML editor scroller ${width}`);
    const shown = await page.evaluate(() => window.ArmEditors.text('media-modal-body')); assert.notEqual(shown, source.toString()); assert.match(shown, /\n/);
    if (width === 1440) {
      const cm = page.locator('#media-modal-body .cm-content'); await cm.focus(); await page.keyboard.type('MUTATION'); assert.equal(await page.evaluate(() => window.ArmEditors.text('media-modal-body')), shown); assert.doesNotMatch(await cm.innerText(), /MUTATION/);
      await page.locator('#media-modal-body .cm-foldGutter .cm-gutterElement').filter({ hasText: /⌄/ }).first().click(); assert.ok(await page.locator('.cm-foldPlaceholder').count()); await page.locator('.cm-foldPlaceholder').first().click();
      const original = page.waitForEvent('download'); await page.locator('#media-download').click(); assert.deepEqual(fs.readFileSync(await (await original).path()), source);
      await page.locator('#media-copy').click(); await page.waitForFunction(() => document.querySelector('#media-action-status').textContent === 'Скопировано'); assert.equal(await page.locator('#media-copy').getAttribute('data-state'), ''); assert.equal(await page.evaluate(() => window.copied), shown);
    }
    await shot('editors-html', width, 'media-modal'); await close('media-modal'); assert.equal(await page.locator('#media-modal-body .cm-editor').count(), 0);
    const image = page.getByRole('button', { name: /^Открыть изображение/ }).first(); await image.click(); await page.waitForSelector('#media-modal.show'); assert.equal(await page.locator('#media-counter').innerText(), '1 / 2'); assert.equal(await page.locator('#media-prev').isDisabled(), true);
    assert.ok(Math.abs(await page.locator('#media-modal .modal-footer .btn-list').evaluate(node => node.getBoundingClientRect().left) - modalNavigation.get(width)) <= 1, `step 2 modal navigation matches step 1 at ${width}px`);
    await page.locator('#media-next').click(); assert.equal(await page.locator('#media-counter').innerText(), '2 / 2'); assert.equal(await page.locator('#media-next').isDisabled(), true); await page.keyboard.press('ArrowLeft'); assert.equal(await page.locator('#media-counter').innerText(), '1 / 2'); await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#media-counter').innerText(), '2 / 2');
    await shot('editors-media-image', width, 'media-modal'); await close('media-modal'); assert.equal(await image.evaluate(node => node === document.activeElement), true, 'navigation restores original identity');
  }
  // A parser failure never overwrites source; display falls back to read-only raw.
  await ctx.queue.stage.media.upload(ctx.job, ctx.attempt, ctx.attempt.htmlMedia.revision, Readable.from([Buffer.from('<div><span></div>')])); await page.waitForFunction(() => JSON.parse(document.querySelector('.html-source-card').dataset.mediaTrigger)[2] === 2);
  await page.locator('.html-source-card').click(); await page.waitForSelector('#media-modal-body .cm-content'); assert.match(await page.locator('#media-modal-body [role=status]').innerText(), /Prettier/); assert.equal(await page.evaluate(() => window.ArmEditors.text('media-modal-body')), '<div><span></div>');
  assert.ok(network.some(url => url.endsWith('/vendor/editors/editors.js'))); assert.ok(network.every(url => url.startsWith(origin + '/'))); assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(testOutput(), 'editors-geometry.json'), JSON.stringify(geometry, null, 2));
});
browserTest('HTML card, modal actions, sequential stage guards and desktop/mobile geometry', { timeout: 60000 }, async t => {
  const fixture = await fixtureServer(t), ctx = completed(t, { mediaDownload: fixture.fetchAsset }), server = createServer(ctx.queue);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close()); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(5000);
  await page.addInitScript(() => { window.copied = null; window.clipboardFail = false; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { if (window.clipboardFail) throw new Error('Clipboard denied'); window.copied = text; }, write: async items => { const blob = await items[0].getType('image/png'); window.copied = { type: blob.type, size: blob.size }; } } }); });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click();
  assert.equal(await page.locator('#stage-two-panel').isVisible(), true);
  assert.equal(await page.locator('#stage-step-3').getAttribute('aria-disabled'), 'true'); assert.equal(await page.locator('#stage-step-4').count(), 0);
  const source = Buffer.from('<script>window.SOURCE_EXECUTED=true</script><img src="/ok.png"><a href="/file.pdf">Doc</a>');
  const picker = page.waitForEvent('filechooser'); await page.locator('.html-source-card').click(); await (await picker).setFiles({ name: 'source.html', mimeType: 'text/html', buffer: source });
  await page.getByRole('button', { name: /^HTML ·/ }).click(); await page.waitForSelector('#media-modal-body .cm-content'); assert.equal(await page.evaluate(() => window.SOURCE_EXECUTED), undefined); assert.match(await page.evaluate(() => window.ArmEditors.text('media-modal-body')), /SOURCE_EXECUTED/);
  for (const modal of ['png','json','media']) {
    const expectedActions = [['Копировать','',1],['Скачать','',1]];
    if (modal === 'media') expectedActions.push(['Удалить ресурс','',1]);
    assert.deepEqual(await page.locator(`#${modal}-modal .modal-actions button`).evaluateAll(nodes => nodes.map(node => [node.getAttribute('aria-label'), node.textContent, node.querySelectorAll('svg').length])), expectedActions);
    if (modal === 'media') assert.equal(await page.locator('#media-delete').isVisible(), false, 'source HTML cannot be deleted as a resource');
    assert.equal(await page.locator(`#${modal}-modal .modal-header`).evaluate(node => node.lastElementChild.classList.contains('btn-close') && node.lastElementChild.previousElementSibling.classList.contains('modal-actions')), true);
  }
  await page.locator('#media-copy').click(); await page.waitForFunction(() => document.querySelector('#media-action-status').textContent === 'Скопировано');
  assert.equal(await page.evaluate(() => window.copied), await page.evaluate(() => window.ArmEditors.text('media-modal-body')));
  const sourceDownload = page.waitForEvent('download'); await page.locator('#media-download').click(); const downloaded = await sourceDownload;
  assert.equal(downloaded.suggestedFilename(), 'source.html'); assert.deepEqual(fs.readFileSync(await downloaded.path()), source);
  await page.evaluate(() => { window.clipboardFail = true; }); await page.locator('#media-copy').click(); await page.waitForSelector('#media-action-error:not(.d-none)');
  assert.equal(await page.locator('#media-copy').getAttribute('data-state'), 'error'); assert.match(await page.locator('#media-action-error').innerText(), /Clipboard denied/);
  await page.evaluate(() => { window.clipboardFail = false; });
  await page.route('**/api/html-media/**/source', route => route.fulfill({ status: 503, body: 'unavailable' })); await page.locator('#media-download').click();
  await page.waitForFunction(() => document.querySelector('#media-download').dataset.state === 'error'); assert.match(await page.locator('#media-action-error').innerText(), /503/); await page.unroute('**/api/html-media/**/source');
  await page.locator('#media-copy').click(); await page.waitForFunction(() => document.querySelector('#media-action-status').textContent === 'Скопировано');
  for (const width of [1440,390,375,360,320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    assert.equal(await page.locator('#media-modal .modal-header').evaluate(node => { const header = node.getBoundingClientRect(), title = node.querySelector('.modal-title').getBoundingClientRect(), actions = [...node.querySelectorAll('button')].filter(button => getComputedStyle(button).display !== 'none').map(button => button.getBoundingClientRect()); return actions.every((rect, index) => rect.right <= header.right && rect.left >= title.right && (index === 0 || rect.left >= actions[index - 1].right)) && document.documentElement.scrollWidth <= innerWidth; }), true, `${width}: modal title and actions do not overlap`);
    await page.screenshot({ path: path.join(testOutput(), `ui-html-modal-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => document.activeElement.closest('#media-modal')); await page.keyboard.press('Escape'); await page.waitForSelector('#media-modal', { state: 'hidden' });
  assert.equal(await page.locator('#stage-two-panel button').count(), 1, 'only the HTML card is a button before media exists');
  assert.equal(await page.locator('#stage-two-panel a').count(), 0, 'no duplicate original/source actions');
  ctx.queue.autoStart = true; ctx.queue.pump();
  await page.waitForFunction(() => document.querySelector('#stage-step-3').getAttribute('aria-disabled') === 'false');
  await page.waitForFunction(() => document.querySelector('#stage-step-3').classList.contains('step-state-active'));
  assert.deepEqual(await page.locator('.result-steps .step-item').evaluateAll(nodes => nodes.map(node => [...node.classList].find(value => value.startsWith('step-state-')))), ['step-state-success','step-state-success','step-state-active']);
  await page.locator('#stage-step-2').focus(); await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#stage-three-panel').isVisible(), true); await page.keyboard.press('End'); assert.equal(await page.locator('#stage-three-panel').isVisible(), true);
  await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#gallery-body').isVisible(), true);
  await page.locator('#stage-step-2').click(); await page.locator('#html-media-accordion summary').first().click(); await page.getByRole('button', { name: /^Открыть изображение/ }).first().click();
  await page.waitForFunction(() => document.activeElement.closest('#media-modal') && document.querySelector('.media-full-image')?.complete && document.querySelector('.media-full-image').naturalWidth > 0);
  await page.locator('#media-copy').click(); await page.waitForFunction(() => document.querySelector('#media-action-status').textContent === 'Скопировано'); assert.deepEqual(await page.evaluate(() => window.copied), { type: 'image/png', size: PNG.length });
  const imageDownload = page.waitForEvent('download'); await page.locator('#media-download').click(); const imageFile = await imageDownload; assert.equal(imageFile.suggestedFilename(), 'ok.png'); assert.deepEqual(fs.readFileSync(await imageFile.path()), PNG);
  await page.keyboard.press('Escape'); await page.waitForSelector('#media-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  const geometries = [];
  for (const width of [1440,390,375,360,320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.waitForFunction(() => [...document.querySelectorAll('.result-steps .step-item')].every(node => {
      const bounds = node.getBoundingClientRect(), label = node.querySelector('.step-label').getBoundingClientRect();
      return Math.abs(bounds.left + parseFloat(getComputedStyle(node, '::before').left) - label.left - label.width / 2) <= 1;
    }));
    const geometry = await page.evaluate(() => {
      const heading = document.querySelector('#header-control-group').getBoundingClientRect(), steps = document.querySelector('#result-steps').getBoundingClientRect();
      return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, heading: { x: heading.x, width: heading.width }, steps: { x: steps.x, width: steps.width }, gap: steps.x - heading.right, verticalGap: steps.top - heading.bottom, centerDelta: steps.y + steps.height / 2 - heading.y - heading.height / 2,
        cells: [...document.querySelectorAll('.result-steps .step-item')].map(node => { const bounds = node.getBoundingClientRect(), dot = getComputedStyle(node,'::before'), range = document.createRange(); range.selectNodeContents(node); const label = node.querySelector('.step-label').getBoundingClientRect(); return { width: bounds.width, marker: bounds.left + parseFloat(dot.left), labelCenter: label.left + label.width / 2, labelGap: range.getBoundingClientRect().top - bounds.top - parseFloat(dot.top) - parseFloat(dot.height), labelsFit: [...range.getClientRects()].every(rect => rect.left >= bounds.left - .5 && rect.right <= bounds.right + .5) }; }) };
    });
    geometries.push(geometry); assert.ok(geometry.scrollWidth <= width, `${width}: no overflow`);
    if (width >= 1400) { assert.ok(geometry.gap > 0); assert.ok(Math.abs(geometry.centerDelta - 4) <= 1); }
    else assert.ok(geometry.verticalGap > 0, 'mobile steps follow the header controls');
    assert.ok(geometry.cells.every(cell => cell.labelsFit && cell.labelGap >= 4));
    const markerDistances = geometry.cells.slice(1).map((cell, index) => cell.marker - geometry.cells[index].marker);
    assert.ok(Math.abs(markerDistances[0] - markerDistances[1]) <= 1, `${width}px uses equal marker distances: ${markerDistances}`);
    assert.ok(geometry.cells.every(cell => Math.abs(cell.labelCenter - cell.marker) <= 1), `${width}px centers every caption below its marker`);
    if (width < 1200) assert.ok(Math.max(...geometry.cells.map(cell => cell.width)) - Math.min(...geometry.cells.map(cell => cell.width)) < .5);
    await page.screenshot({ path: path.join(testOutput(), `ui-step2-${width}.png`), fullPage: true });
  }
  fs.writeFileSync(path.join(testOutput(), 'html-media-layout.json'), JSON.stringify(geometries, null, 2));
  assert.equal(await page.locator('#stage-two-panel button').count(), 1 + await page.getByRole('button', { name: /^Открыть изображение/ }).count(), 'only HTML and image cards, no duplicate control buttons');
  assert.deepEqual(errors, []);
});
if (browserCaseCount !== 8) throw new Error(`Expected 8 explicitly marked HTML media browser cases, found ${browserCaseCount}`);
