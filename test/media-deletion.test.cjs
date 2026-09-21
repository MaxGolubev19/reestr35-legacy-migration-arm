'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Queue, createServer } = require('../src/server.cjs');
const { seedMoriPage } = require('./page-builder-fixture.cjs');
const { testTempRoot } = require('./support.cjs');
const { chromium } = require('playwright');
const { filename } = require('../src/infrastructure/media.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R5sGAAAAAElFTkSuQmCC', 'base64');
const pdf = Buffer.from('%PDF-1.7\nshared object\n%%EOF\n');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const html = Buffer.from('<img src="https://example.org/one.png"><img src="https://example.org/two.png"><a href="https://example.org/one.pdf">One</a><a href="https://example.org/two.pdf">Two</a><iframe src="https://rutube.ru/play/embed/delete-test/"></iframe><iframe src="https://rutube.ru/play/embed/delete-test/"></iframe>');

async function fixture(t, { builder = true, server = true, source = html } = {}) {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'media-deletion-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0];
  if (builder) seedMoriPage(queue, job);
  const attempt = job.attempts[0], manifest = queue.stage.media.create(job, attempt, source, 'test'), dir = queue.stage.media.directory(job, attempt);
  for (const item of manifest.resources) if (item.kind === 'asset') {
    const bytes = item.resolvedUrl.endsWith('.png') ? png : pdf, sha256 = digest(bytes);
    fs.writeFileSync(path.join(dir, 'objects', sha256), bytes);
    Object.assign(item, { status: 'downloaded', mime: bytes === png ? 'image/png' : 'application/pdf', bytes: bytes.length, sha256, object: `objects/${sha256}` });
  }
  manifest.status = 'complete'; queue.stage.media.publish(job, attempt, manifest);
  Object.assign(attempt, { status: 'complete', captureStatus: 'complete' }); queue.save();
  const result = { root, queue, job, attempt, dir, manifest, source: fs.readFileSync(path.join(dir, 'source.html')) };
  if (server) {
    result.server = createServer(queue); await new Promise(resolve => result.server.listen(0, '127.0.0.1', resolve));
    result.base = `http://127.0.0.1:${result.server.address().port}`;
    const state = await (await fetch(result.base + '/api/state')).json();
    result.headers = { 'content-type': 'application/json', 'x-csrf-token': state.csrfToken, origin: result.base, 'sec-fetch-site': 'same-origin' };
  }
  t.after(async () => {
    if (result.server) await new Promise(resolve => { result.server.closeAllConnections(); result.server.close(resolve); });
    await queue.shutdown(); fs.rmSync(root, { recursive: true, force: true });
  });
  return result;
}
function context({ queue, job, attempt }) {
  return { attempt: attempt.number, htmlRevision: attempt.htmlMedia.revision, checkpoint: attempt.htmlMedia.checkpoint,
    revision: queue.pageBuilder.read(job.id, { attempt: attempt.number, create: false })?.revision || 0 };
}
function resources(ctx) {
  const items = ctx.queue.stage.media.read(ctx.job, ctx.attempt, true).resources;
  return { images: items.filter(item => item.status === 'downloaded' && item.mime === 'image/png'),
    documents: items.filter(item => item.status === 'downloaded' && item.mime === 'application/pdf'),
    frames: items.filter(item => item.status === 'external' && item.occurrence?.tag === 'iframe') };
}
function attach(ctx) {
  const { queue, job, attempt } = ctx, { images, documents, frames } = resources(ctx), stored = queue.pageBuilder.read(job.id), document = structuredClone(stored.document);
  const request = { revision: stored.revision, attempt: attempt.number, htmlRevision: attempt.htmlMedia.revision };
  const one = queue.mediaPicker.choose(job.id, request, filename(images[0])), two = queue.mediaPicker.choose(job.id, request, filename(images[1]));
  Object.assign(document.common.blocks[0].media[0], { originalUrl: one.url, originalMedia: one.media, bigUrl: two.url, bigMedia: two.media });
  Object.assign(document.tabs[0].blocks[0].media[0], { originalUrl: one.url, originalMedia: one.media });
  const chosenDocs = documents.map(item => queue.documentPicker.choose(job.id, request, item.id));
  const links = { id: 'deletion-links', type: 'links', view: 'documents', title: 'Документы', text: '', content: '', settings: '', media: [], review: { status: 'unreviewed', reason: '' }, items: chosenDocs.map((chosen, index) => ({ id: `deletion-document-${index}`, title: chosen.name, text: '', link: chosen.link, link_text: chosen.name, meta: { kind: 'document', file_type: chosen.fileType, size: String(chosen.bytes), download: true }, sourceDocument: chosen.sourceDocument })), meta: {} };
  document.common.blocks.push(links);
  const frame = queue.framePicker.choose(job.id, request, frames[0].id);
  document.common.blocks.push({ id: 'deletion-frame', type: 'embed', view: 'default', title: 'Фрейм', text: '', content: '', settings: '', media: [], review: { status: 'unreviewed', reason: '' }, source_url: frame.source_url, sourceFrame: frame.sourceFrame, link: '', provider: 'iframe', ratio: '16:9' });
  queue.pageBuilder.write(job.id, stored.revision, document, attempt.number);
  return { images, documents, frames };
}
const endpoint = (ctx, suffix) => `${ctx.base}/api/html-media/${ctx.job.id}/${ctx.attempt.number}/${ctx.attempt.htmlMedia.revision}/${suffix}`;
const postDelete = (ctx, request) => fetch(endpoint(ctx, 'delete'), { method: 'POST', headers: ctx.headers, body: JSON.stringify({ checkpoint: request.checkpoint, resourceId: request.resourceId, revision: request.revision }) });

test('deletion removes referenced image, document and iframe from the owning page while shared objects and siblings survive', async t => {
  const ctx = await fixture(t), { queue, job, attempt, dir } = ctx, { images, documents, frames } = attach(ctx);
  const originalSource = digest(ctx.source), originalObjects = fs.readdirSync(path.join(dir, 'objects')).sort();
  const originalAlt = queue.pageBuilder.read(job.id).document.common.blocks[0].media[0].alt;
  const first = { ...context(ctx), resourceId: images[0].id };
  const impact = await (await fetch(endpoint(ctx, `delete-impact?${new URLSearchParams({ checkpoint: first.checkpoint, resourceId: first.resourceId, revision: first.revision })}`))).json();
  assert.deepEqual(impact, { used: true, kind: 'image' });
  assert.equal((await postDelete(ctx, { ...first, revision: 999 })).status, 409);
  assert.equal((await postDelete(ctx, { ...first, checkpoint: first.checkpoint - 1 })).status, 409);
  assert.equal((await fetch(endpoint(ctx, 'delete'), { method: 'POST', headers: { ...ctx.headers, 'x-csrf-token': '' }, body: JSON.stringify({ checkpoint: first.checkpoint, resourceId: first.resourceId, revision: first.revision }) })).status, 403);
  const removedImage = await postDelete(ctx, first); assert.equal(removedImage.status, 200, await removedImage.clone().text());
  const imageResult = await removedImage.json(); assert.equal(imageResult.used, true); assert.equal(imageResult.builderRevision, first.revision + 1);
  let stored = queue.pageBuilder.read(job.id), hero = stored.document.common.blocks[0], tabImage = stored.document.tabs[0].blocks[0].media[0];
  assert.equal(hero.media[0].originalUrl, ''); assert.equal(hero.media[0].originalMedia, undefined);
  assert.equal(hero.media[0].bigUrl, images[1].resolvedUrl); assert.equal(hero.media[0].bigMedia.resourceId, images[1].id);
  assert.equal(tabImage.originalUrl, ''); assert.equal(tabImage.originalMedia, undefined);
  assert.equal(hero.media[0].alt, originalAlt); assert.equal(hero.media[0].id.length > 0, true);
  assert.equal(queue.stage.media.read(job, attempt).resources.find(item => item.id === images[0].id).status, 'deleted');
  assert.equal((await fetch(endpoint(ctx, `objects/${images[0].sha256}?resourceId=${images[0].id}`))).status, 404);
  assert.equal((await fetch(endpoint(ctx, `objects/${images[1].sha256}?resourceId=${images[1].id}`))).status, 200);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'objects')).sort(), originalObjects);
  assert.equal((await postDelete(ctx, first)).status, 409, 'retry with an old checkpoint cannot delete twice');
  const removedDocument = await postDelete(ctx, { ...context(ctx), resourceId: documents[0].id });
  assert.equal(removedDocument.status, 200, await removedDocument.clone().text());
  stored = queue.pageBuilder.read(job.id); assert.deepEqual(stored.document.common.blocks.find(block => block.id === 'deletion-links').items.map(item => item.sourceDocument.resourceId), [documents[1].id]);
  assert.equal((await fetch(endpoint(ctx, `objects/${documents[1].sha256}?resourceId=${documents[1].id}`))).status, 200);
  const removedFrame = await postDelete(ctx, { ...context(ctx), resourceId: frames[0].id });
  assert.equal(removedFrame.status, 200, await removedFrame.clone().text());
  stored = queue.pageBuilder.read(job.id); assert.equal(Boolean(stored.document.common.blocks.find(block => block.id === 'deletion-frame').source_url), false);
  assert.equal(stored.document.common.blocks.find(block => block.id === 'deletion-frame').sourceFrame, undefined);
  const frameCatalog = queue.framePicker.catalog(job.id, { revision: stored.revision, attempt: 1, htmlRevision: 1 });
  assert.deepEqual(frameCatalog.frames.map(item => item.resourceId), [frames[1].id]);
  assert.equal(digest(fs.readFileSync(path.join(dir, 'source.html'))), originalSource);
  const restarted = new Queue({ root: queue.root, autoStart: false });
  assert.equal(restarted.stage.media.read(restarted.get(job.id), restarted.get(job.id).attempts[0], true).resources.filter(item => item.status === 'deleted').length, 3);
  assert.equal(restarted.pageBuilder.read(job.id).document.common.blocks.find(block => block.id === 'deletion-links').items.length, 1);
  await restarted.shutdown();
});

test('unreferenced deletion does not create a page and a newer attempt cannot delete an older attempt resource', async t => {
  const ctx = await fixture(t, { builder: false }), { queue, job, attempt } = ctx, { images } = resources(ctx);
  const file = queue.pageBuilder.file(job.id, 1); assert.equal(fs.existsSync(file), false);
  const request = { ...context(ctx), resourceId: images[0].id }; assert.equal(request.revision, 0);
  assert.deepEqual(await (await fetch(endpoint(ctx, `delete-impact?${new URLSearchParams({ checkpoint: request.checkpoint, resourceId: request.resourceId, revision: 0 })}`))).json(), { used: false, kind: 'image' });
  assert.equal((await postDelete(ctx, request)).status, 200); assert.equal(fs.existsSync(file), false);
  attempt.status = 'paused'; queue.retry(job.id);
  assert.equal((await postDelete(ctx, { ...context(ctx), resourceId: images[1].id })).status, 409);
  assert.equal(queue.stage.media.read(job, attempt).resources.find(item => item.id === images[1].id).status, 'downloaded');
});

test('a failed manifest write leaves a journal and restart rolls the builder-first transaction forward', async t => {
  const ctx = await fixture(t), { queue, job, attempt, dir } = ctx, { images } = attach(ctx);
  const request = { ...context(ctx), resourceId: images[0].id }, manifestFile = path.join(dir, 'manifest.json'), originalRename = fs.renameSync;
  let fail = true; fs.renameSync = (...args) => { if (fail && args[1] === manifestFile) { fail = false; throw new Error('injected manifest rename failure'); } return originalRename(...args); };
  try { assert.throws(() => queue.stage.media.deletion.commit(job.id, request), /injected manifest/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(queue.stage.media.deletion.failed, true); assert.equal(fs.existsSync(path.join(dir, 'delete-transaction.json')), true);
  const frozen = queue.pageBuilder.read(job.id), attempts = job.attempts.length;
  assert.throws(() => queue.pageBuilder.write(job.id, frozen.revision, frozen.document), /требуется восстановление/);
  assert.throws(() => queue.retry(job.id), /требуется восстановление/); assert.equal(job.attempts.length, attempts);
  assert.equal((await fetch(ctx.base + '/api/state')).status, 503);
  const health = await fetch(ctx.base + '/api/health'); assert.equal(health.status, 200); assert.equal((await health.json()).version, require('../package.json').version);
  const restarted = new Queue({ root: queue.root, autoStart: false });
  assert.equal(fs.existsSync(path.join(dir, 'delete-transaction.json')), false);
  assert.equal(restarted.stage.media.read(restarted.get(job.id), restarted.get(job.id).attempts[0]).resources.find(item => item.id === images[0].id).status, 'deleted');
  assert.equal(restarted.pageBuilder.read(job.id).document.common.blocks[0].media[0].originalUrl, '');
  await restarted.shutdown();
});

test('a failed state projection leaves committed files journaled for idempotent restart recovery', async t => {
  const ctx = await fixture(t, { server: false }), { queue, job, attempt, dir } = ctx, { images } = attach(ctx);
  const request = { ...context(ctx), resourceId: images[0].id }, originalRename = fs.renameSync;
  let fail = true; fs.renameSync = (...args) => { if (fail && args[1] === queue.stateFile) { fail = false; throw new Error('injected state rename failure'); } return originalRename(...args); };
  try { assert.throws(() => queue.stage.media.deletion.commit(job.id, request), /injected state/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(queue.stage.media.deletion.failed, true);
  assert.equal(fs.existsSync(path.join(dir, 'delete-transaction.json')), true);
  assert.equal(queue.stage.media.read(job, attempt).resources.find(item => item.id === images[0].id).status, 'deleted');
  const restarted = new Queue({ root: queue.root, autoStart: false });
  assert.equal(fs.existsSync(path.join(dir, 'delete-transaction.json')), false);
  assert.equal(restarted.get(job.id).attempts[0].htmlMedia.checkpoint, request.checkpoint + 1);
  assert.equal(restarted.pageBuilder.read(job.id).document.common.blocks[0].media[0].originalUrl, '');
  await restarted.shutdown();
});

test('active work, uploads and corrupt objects refuse deletion without touching state', async t => {
  const ctx = await fixture(t), { queue, job, attempt, dir } = ctx, { images } = resources(ctx);
  const request = { ...context(ctx), resourceId: images[0].id }, manifestFile = path.join(dir, 'manifest.json');
  const manifestHash = digest(fs.readFileSync(manifestFile));
  queue.active.set(job.id, { exitCode: null });
  assert.equal((await postDelete(ctx, request)).status, 409); queue.active.delete(job.id);
  queue.stage.media.uploads.add(job.id);
  assert.equal((await postDelete(ctx, request)).status, 409); queue.stage.media.uploads.delete(job.id);
  queue.closing = true;
  assert.equal((await postDelete(ctx, request)).status, 409); queue.closing = false;
  assert.equal(digest(fs.readFileSync(manifestFile)), manifestHash);
  fs.writeFileSync(path.join(dir, images[0].object), Buffer.from('tampered'));
  assert.notEqual((await postDelete(ctx, request)).status, 200);
  assert.equal(digest(fs.readFileSync(manifestFile)), manifestHash);
  assert.equal(fs.existsSync(path.join(dir, 'delete-transaction.json')), false);
  assert.equal(attempt.htmlMedia.checkpoint, request.checkpoint);
});

test('legacy image and duplicate iframe references clear only after their last active equivalent is deleted', async t => {
  const ctx = await fixture(t), { queue, job } = ctx, { images, frames } = attach(ctx);
  const file = queue.pageBuilder.file(job.id, 1), legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.document.common.blocks[0].media[0].originalMedia.resourceId;
  delete legacy.document.tabs[0].blocks[0].media[0].originalMedia.resourceId;
  delete legacy.document.common.blocks.find(block => block.id === 'deletion-frame').sourceFrame;
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
  let stored;
  assert.equal((await postDelete(ctx, { ...context(ctx), resourceId: images[0].id })).status, 200);
  stored = queue.pageBuilder.read(job.id);
  assert.equal(stored.document.common.blocks[0].media[0].originalUrl, '');
  assert.equal(stored.document.tabs[0].blocks[0].media[0].originalUrl, '');
  assert.equal((await postDelete(ctx, { ...context(ctx), resourceId: frames[0].id })).status, 200);
  stored = queue.pageBuilder.read(job.id);
  assert.equal(stored.document.common.blocks.find(block => block.id === 'deletion-frame').source_url, frames[0].resolvedUrl, 'the second iframe has the same URL');
  assert.equal((await postDelete(ctx, { ...context(ctx), resourceId: frames[1].id })).status, 200);
  stored = queue.pageBuilder.read(job.id);
  assert.equal(Boolean(stored.document.common.blocks.find(block => block.id === 'deletion-frame').source_url), false);
});

test('Chromium chooses the second identical image occurrence by ID and deletion keeps that choice', { timeout: 45000 }, async t => {
  const source = Buffer.from('<img src="https://example.org/same.png"><img src="https://example.org/same.png">');
  const ctx = await fixture(t, { source }), { queue, job } = ctx, { images } = resources(ctx);
  assert.equal(images.length, 2);
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ctx.base); await page.locator(`[data-job-id="${job.id}"]`).click();
  await page.locator('#stage-step-3').click(); await page.locator('[data-builder-id="common-hero"]').click();
  await page.getByRole('button', { name: 'Выбрать основную картинку' }).click();
  const tiles = page.locator('.builder-catalog-tile'); await tiles.nth(1).click();
  await page.locator('#page-builder-save').click(); await page.locator('#page-builder-modal').waitFor({ state: 'hidden' });
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].media[0].originalMedia.resourceId, images[1].id);
  assert.equal((await postDelete(ctx, { ...context(ctx), resourceId: images[0].id })).status, 200);
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].media[0].originalMedia.resourceId, images[1].id, 'deleting the first occurrence leaves the chosen second one');
  assert.equal((await postDelete(ctx, { ...context(ctx), resourceId: images[1].id })).status, 200);
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].media[0].originalUrl, '');
  assert.deepEqual(errors, []);
});

test('step 2 deletion controls confirm, cancel, and fit image, document and iframe cards in Chromium', { timeout: 60000 }, async t => {
  const ctx = await fixture(t), { queue, job } = ctx; attach(ctx);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(ctx.base); await page.locator(`[data-job-id="${job.id}"]`).click();
  await page.locator('#stage-step-2').click();
  const section = title => page.locator('#html-media-accordion .html-media-section').filter({ has: page.locator('summary', { hasText: title }) });
  const images = section('Изображения'), documents = section('Документы и медиа'), frames = section('Внешние встраивания');
  await images.locator('summary').click();
  await images.locator('[aria-label^="Открыть изображение"]').first().click();
  await page.locator('#media-delete').click();
  const dialog = page.locator('.media-delete-confirm'); await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /используется в блоках/);
  const imageTitle = await page.locator('#media-modal-title').innerText();
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => { document.getElementById('media-next').click(); window.tabler.Modal.getOrCreateInstance(document.getElementById('media-modal')).hide(); });
  assert.equal(await page.locator('#media-modal-title').innerText(), imageTitle, 'confirmation freezes the image target');
  assert.equal(await page.locator('#media-modal').isVisible(), true, 'background modal cannot close under confirmation');
  await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'native confirmation keeps keyboard focus');
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(queue.stage.media.read(job, job.attempts[0]).resources.filter(item => item.status === 'deleted').length, 0, 'cancel leaves every resource intact');
  await page.locator('#media-delete').click(); await dialog.getByRole('button', { name: 'Удалить' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#html-media-accordion [aria-label^="Открыть изображение"]').length === 1);
  await page.locator('#media-modal').waitFor({ state: 'hidden' });
  await documents.locator('summary').click();
  const docTrash = documents.locator('.media-document-delete').first();
  const trashStyle = () => docTrash.evaluate(node => { const style = getComputedStyle(node); return { color: style.color, background: style.backgroundColor, border: style.borderTopWidth, outline: style.outlineStyle, focusVisible: node.matches(':focus-visible') }; });
  const dangerStyle = await page.evaluate(() => { const probe = document.createElement('span'); probe.style.color = 'var(--tblr-danger)'; probe.style.background = 'var(--tblr-red-lt)'; document.body.append(probe); const style = getComputedStyle(probe), result = { color: style.color, background: style.backgroundColor }; probe.remove(); return result; });
  const neutralStyle = await page.evaluate(() => { const probe = document.createElement('span'); probe.style.color = 'var(--tblr-secondary)'; probe.style.background = 'transparent'; document.body.append(probe); const style = getComputedStyle(probe), result = { color: style.color, background: style.backgroundColor }; probe.remove(); return result; });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await documents.locator('.media-document-column').first().evaluate(column => {
      const card = column.querySelector('.media-document-card').getBoundingClientRect();
      const trash = column.querySelector('.media-document-delete').getBoundingClientRect();
      return { card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom }, trash: { left: trash.left, right: trash.right, top: trash.top, bottom: trash.bottom }, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(geometry.overflow, false, `${width}px: no horizontal overflow`);
    assert.ok(geometry.trash.left >= geometry.card.left && geometry.trash.right <= geometry.card.right && geometry.trash.top >= geometry.card.top && geometry.trash.bottom <= geometry.card.bottom, `${width}px: trash stays inside the document card`);
    await page.mouse.move(0, 0); await page.locator('.html-source-card').focus();
    await page.waitForFunction(() => !document.querySelector('.media-document-delete').matches(':hover, :focus'));
    await page.waitForFunction(expected => { const style = getComputedStyle(document.querySelector('.media-document-delete')); return style.color === expected.color && style.backgroundColor === expected.background; }, neutralStyle);
    const idle = await trashStyle();
    assert.equal(idle.border, '0px', `${width}px: idle trash has no border`);
    assert.equal(idle.outline, 'none', `${width}px: idle trash has no outline`);
    await docTrash.hover();
    await page.waitForFunction(expected => { const style = getComputedStyle(document.querySelector('.media-document-delete')); return style.color === expected.color && style.backgroundColor === expected.background; }, dangerStyle);
    const hover = await trashStyle();
    assert.equal(hover.color, dangerStyle.color, `${width}px: hover icon is danger red`);
    assert.equal(hover.background, dangerStyle.background, `${width}px: hover background is light red`);
    assert.equal(hover.border, '0px', `${width}px: hover keeps the button borderless`);
    assert.notEqual(hover.background, idle.background, `${width}px: red hover background appears`);
    await page.mouse.move(0, 0); await docTrash.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await page.waitForFunction(() => document.querySelector('.media-document-delete')?.matches(':focus-visible'));
    await page.waitForFunction(expected => { const style = getComputedStyle(document.querySelector('.media-document-delete')); return style.color === expected.color && style.backgroundColor === expected.background; }, dangerStyle);
    const focused = await trashStyle();
    assert.equal(focused.focusVisible, true, `${width}px: keyboard focus remains visible`);
    assert.notEqual(focused.color, idle.color, `${width}px: keyboard focus uses a colored icon`);
    assert.notEqual(focused.outline, 'none', `${width}px: keyboard focus has an outline`);
  }
  await docTrash.click(); await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /используется в блоках/);
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#html-media-accordion .media-document-delete').length === 1);
  await frames.locator('summary').click(); await frames.locator('[aria-label^="Открыть iframe"]').first().click();
  await page.locator('#media-delete').click(); await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /используется в блоках/);
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#html-media-accordion [aria-label^="Открыть iframe"]').length === 1);
  await frames.locator('[aria-label^="Открыть iframe"]').first().click();
  assert.equal(await page.locator('#media-copy').isDisabled(), false, 'duplicate iframe still has its source snippet after tombstoning the first');
  await page.locator('#media-delete').click(); await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /Ресурс будет удалён из списка ресурсов страницы\./, 'unused resource describes the page resource list');
  await dialog.getByRole('button', { name: 'Отмена' }).click(); await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(pageErrors, []);
});
