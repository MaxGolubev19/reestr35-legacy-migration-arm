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
const { filename } = require('../src/infrastructure/media.cjs');

function installLocalPreview(queue, job, asset) {
  const attempt = job.attempts.at(-1), manifest = queue.stage.media.create(job, attempt, Buffer.from(`<img src="${asset.originalUrl}">`), 'test');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R5sGAAAAAElFTkSuQmCC', 'base64'), sha256 = crypto.createHash('sha256').update(png).digest('hex');
  fs.writeFileSync(path.join(queue.stage.media.directory(job, attempt), 'objects', sha256), png);
  Object.assign(manifest.resources[0], { status: 'downloaded', finalUrl: asset.originalUrl, redirects: [], mime: 'image/png', bytes: png.length, sha256, object: `objects/${sha256}` });
  queue.stage.media.publish(job, attempt, manifest); return png;
}

async function disclosurePattern(row) {
  return row.evaluate(node => {
    const details = node.querySelector(':scope > details'), controls = node.querySelector(':scope > .builder-image-tools');
    const summary = details.querySelector(':scope > summary'), body = details.children[1], style = element => getComputedStyle(element);
    const pick = (element, names) => Object.fromEntries(names.map(name => [name, style(element)[name]]));
    return {
      children: [...node.children].map(child => child.tagName),
      controlOrder: [...controls.children].map(control => control.classList.contains('builder-delete') ? 'delete' : control.classList.contains('builder-media-drag') ? 'drag' : 'other'),
      shell: pick(node, ['position', 'display']),
      controls: pick(controls, ['position', 'top', 'right', 'zIndex', 'display', 'flexDirection', 'gap', 'padding']),
      summary: pick(summary, ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'cursor', 'fontWeight', 'overflowWrap']),
      body: pick(body, ['display', 'gap', 'padding', 'borderTopStyle', 'borderTopWidth', 'borderTopColor'])
    };
  });
}

const disclosureWidths = [1440, 390, 375, 360, 320];
async function tableCellDisclosurePatterns(page) {
  await page.locator('#builder-type').selectOption('table'); await page.locator('#builder-add-table-row').click();
  const row = page.locator('.builder-table-row').first(); await row.locator(':scope > details > summary').click();
  assert.deepEqual(await row.locator(':scope > .builder-image-tools > button').evaluateAll(nodes => nodes.map(node => node.classList.contains('builder-media-drag') ? 'drag' : node.classList.contains('builder-delete') ? 'delete' : 'other')), ['drag', 'delete'], 'table row keeps its original drag/delete order');
  const cell = row.locator('.builder-table-cell').first(), patterns = {};
  for (const width of disclosureWidths) { await page.setViewportSize({ width, height: 1000 }); patterns[width] = await disclosurePattern(cell); }
  await page.setViewportSize({ width: 1440, height: 1000 }); return patterns;
}

test('data-table editor edits, reorders and validates nested data without media at every viewport', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-data-table-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], external = [], posts = [], origin = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); if (request.method() === 'POST' && request.url().includes('/api/page-builder/')) posts.push(request.postDataJSON()); });
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const opener = page.locator('[data-builder-id="common-hero"]'), open = async () => { await opener.click(); await page.waitForSelector('#page-builder-modal.show'); }, close = async () => { await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); };
  await open(); await page.locator('#builder-type').selectOption('data-table');
  assert.equal(await page.locator('.builder-editor-placeholder,.builder-image-row').count(), 0); assert.equal(await page.locator('.builder-data-column,.builder-data-row,.builder-data-group').count(), 0);
  assert.equal(await page.locator('#builder-add-data-group').count(), 0); assert.equal(await page.locator('label[for="builder-caption"]').innerText(), 'Подпись'); assert.doesNotMatch(await page.locator('.builder-data-table-editor').innerText(), /Ячейки соответствуют/);
  assert.equal(await page.locator('#builder-data-striped').isChecked(), true); assert.equal(await page.locator('#builder-data-bordered').isChecked(), true); assert.equal(await page.locator('#builder-data-sticky_header').isChecked(), false); assert.equal(await page.locator('#builder-data-min_width').inputValue(), '');
  await page.locator('#builder-title').fill('Таблица'); await page.locator('#builder-content').fill('Общий текст'); await page.locator('#builder-caption').fill('Подпись');
  const shell = id => page.locator(`[data-data-id="${id}"]`), summary = id => shell(id).locator(':scope > details > summary'), control = (id, key) => page.locator(`#builder-data-${id}-${key}`);
  await page.locator('#builder-add-data-column').click(); const columnA = await page.locator('.builder-data-column').first().getAttribute('data-data-id');
  assert.equal(await shell(columnA).locator(':scope > details').evaluate(node => node.open), false); assert.equal(await summary(columnA).innerText(), 'Колонка'); assert.equal(await summary(columnA).evaluate(node => node === document.activeElement), true);
  await summary(columnA).press('Enter'); await control(columnA, 'title').fill('<b>Название</b>'); await control(columnA, 'key').fill('name'); await control(columnA, 'align').selectOption('center'); await control(columnA, 'width').fill('4'); await control(columnA, 'nowrap').check();
  assert.deepEqual(await shell(columnA).locator('.form-label').allInnerTexts(), ['Заголовок', 'Ключ', 'Выравнивание', 'Ширина, %', 'Не переносить текст']);
  assert.equal(await summary(columnA).textContent(), '<b>Название</b>'); assert.equal(await summary(columnA).locator('b').count(), 0); await summary(columnA).click();
  await page.locator('#page-builder-save').click(); assert.equal(posts.length, 0); assert.match(await page.locator('#page-builder-form-error').innerText(), /Ширина, %[\s\S]+5 до 80/); assert.equal(await control(columnA, 'width').evaluate(node => document.activeElement === node), true); assert.equal(await shell(columnA).locator(':scope > details').evaluate(node => node.open), true); await control(columnA, 'width').fill('40');
  await page.locator('#builder-add-data-column').click(); const columnB = await page.locator('.builder-data-column').last().getAttribute('data-data-id'); assert.equal(await shell(columnA).locator(':scope > details').evaluate(node => node.open), true, 'adding preserves existing open cards'); await summary(columnB).click(); await control(columnB, 'title').fill('Цена'); await control(columnB, 'key').fill('price');
  const reorder = async (selector, firstId, secondId) => {
    const ids = () => page.locator(selector).evaluateAll(nodes => nodes.map(node => node.dataset.dataId));
    await control(secondId, 'drag').focus(); await page.keyboard.press('ArrowUp'); assert.deepEqual(await ids(), [secondId, firstId]); assert.equal(await control(secondId, 'drag').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('ArrowDown'); assert.deepEqual(await ids(), [firstId, secondId]);
    await shell(firstId).locator(':scope > details').evaluate(node => node.open = false); await shell(secondId).locator(':scope > details').evaluate(node => node.open = false);
    await control(secondId, 'drag').dragTo(shell(firstId), { targetPosition: { x: 15, y: 2 } }); assert.deepEqual(await ids(), [secondId, firstId]);
  };
  await reorder('.builder-data-column', columnA, columnB);
  await page.locator('#builder-add-data-column').click(); const spareColumn = page.locator('.builder-data-column').last(); await spareColumn.locator(':scope > .builder-image-tools > .builder-delete').click(); assert.equal(await page.locator('.builder-data-column').count(), 2);
  await page.locator('#builder-add-data-row').click(); const rowId = await page.locator('.builder-data-row').getAttribute('data-data-id'); assert.equal(await shell(rowId).locator(':scope > details').evaluate(node => node.open), false); await summary(rowId).click();
  assert.equal(await shell(rowId).locator(':scope > details > .builder-table-cell-body > :first-child label').innerText(), 'Тип'); assert.equal(await control(rowId, 'type').inputValue(), 'row'); assert.deepEqual(await control(rowId, 'type').locator('option').allTextContents(), ['Строка', 'Группа']);
  const cellA = await shell(rowId).locator('.builder-data-cell').getAttribute('data-data-id'); assert.equal(await shell(cellA).locator(':scope > details').evaluate(node => node.open), false); await summary(cellA).click();
  const literal = ' <b>HTML</b>\n<img src="https://example.invalid/tracker"><script>throw 1</script> ';
  assert.equal(await control(cellA, 'text').evaluate(node => node.open), false); assert.equal(await control(cellA, 'text').locator(':scope > summary').innerText(), 'Текст'); await control(cellA, 'text').locator(':scope > summary').click();
  await control(cellA, 'value').fill('Markdown'); await control(cellA, 'value').evaluate(node => node.setSelectionRange(0, node.value.length)); await shell(cellA).getByRole('button', { name: 'Жирный', exact: true }).click(); assert.equal(await control(cellA, 'value').inputValue(), '**Markdown**'); assert.equal(await shell(cellA).locator('.builder-markdown-preview strong').innerText(), 'Markdown'); assert.equal(await summary(cellA).textContent(), 'Markdown');
  await control(cellA, 'value').fill(literal); assert.equal(await summary(cellA).textContent(), 'HTML'); assert.equal(await control(cellA, 'value').evaluate(node => node.tagName), 'TEXTAREA'); assert.equal(await shell(cellA).locator('.builder-item-markdown').count(), 1); assert.equal(await shell(cellA).locator('script,img,.builder-markdown-preview b').count(), 0); assert.match(await shell(cellA).locator('.builder-markdown-preview').innerText(), /<b>HTML<\/b>/);
  await control(cellA, 'settings').locator('summary').click(); await control(cellA, 'key').fill('unrelated-key'); assert.equal(await control(cellA, 'align').inputValue(), ''); await control(cellA, 'align').selectOption('right'); await control(cellA, 'colspan').fill('2'); await control(cellA, 'rowspan').fill('3'); await control(cellA, 'is_header').check(); await control(cellA, 'nowrap').check();
  await control(rowId, 'add-cell').click(); const cellB = await shell(rowId).locator('.builder-data-cell').last().getAttribute('data-data-id'); assert.equal(await control(cellA, 'settings').evaluate(node => node.open), true, 'nested settings stay open'); assert.equal(await control(cellA, 'text').evaluate(node => node.open), true, 'Markdown section stays open'); assert.equal(await shell(cellB).locator(':scope > details').evaluate(node => node.open), false); await summary(cellB).click(); assert.equal(await control(cellB, 'text').evaluate(node => node.open), false); await control(cellB, 'text').locator(':scope > summary').click(); await control(cellB, 'value').fill('Вторая');
  await reorder('.builder-data-cell', cellA, cellB); assert.equal(await control(cellA, 'settings').evaluate(node => node.open), true);
  await control(columnA, 'drag').focus(); await page.keyboard.press('ArrowUp'); assert.deepEqual(await page.locator('.builder-data-cell').evaluateAll(nodes => nodes.map(node => node.dataset.dataId)), [cellB, cellA], 'moving columns never maps or reorders cells by key'); await page.keyboard.press('ArrowDown');
  await control(rowId, 'type').selectOption('group'); assert.equal(await control(rowId, 'type').evaluate(node => node === document.activeElement), true); assert.equal(await shell(rowId).locator('.builder-data-cell').count(), 0); assert.equal(await summary(rowId).innerText(), 'Группа'); await control(rowId, 'group').fill('Черновик группы');
  await control(rowId, 'type').selectOption('row'); assert.equal(await summary(rowId).innerText(), 'Строка'); assert.equal(await control(cellA, 'value').inputValue(), literal); assert.equal(await control(cellA, 'colspan').inputValue(), '2'); assert.deepEqual(await page.locator('.builder-data-cell').evaluateAll(nodes => nodes.map(node => node.dataset.dataId)), [cellB, cellA]);
  await control(rowId, 'type').selectOption('group'); assert.equal(await control(rowId, 'group').inputValue(), 'Черновик группы'); await control(rowId, 'type').selectOption('row');
  await page.locator('#builder-add-data-row').click(); const groupId = await page.locator('.builder-data-row').last().getAttribute('data-data-id'); assert.equal(await shell(groupId).locator(':scope > details').evaluate(node => node.open), false); await summary(groupId).click(); await control(groupId, 'type').selectOption('group');
  assert.deepEqual(await shell(groupId).locator('.form-label').allInnerTexts(), ['Тип', 'Заголовок']); await summary(groupId).click();
  await page.locator('#page-builder-save').click(); assert.equal(posts.length, 0); assert.match(await page.locator('#page-builder-form-error').innerText(), /Заголовок/); assert.equal(await control(groupId, 'group').evaluate(node => node === document.activeElement), true); await control(groupId, 'group').fill('Раздел'); assert.equal(await summary(groupId).innerText(), 'Раздел');
  await reorder('.builder-data-rows > [data-data-id]', rowId, groupId);
  await summary(rowId).click();
  await page.locator('#builder-add-data-row').click(); const spareRow = page.locator('.builder-data-row').last(); await spareRow.locator(':scope > details > summary').click(); await spareRow.locator('.builder-data-cell > .builder-image-tools > .builder-delete').click(); assert.equal(await page.locator('.builder-data-row').count(), 1, 'deleting the last cell removes its row');
  await control(rowId, 'add-cell').click(); const spareCell = shell(rowId).locator('.builder-data-cell').last(); await spareCell.locator(':scope > .builder-image-tools > .builder-delete').click(); assert.equal(await shell(rowId).locator('.builder-data-cell').count(), 2);
  await page.locator('#builder-add-data-row').click(); const spareGroupId = await page.locator('.builder-data-row').last().getAttribute('data-data-id'); await summary(spareGroupId).click(); await control(spareGroupId, 'type').selectOption('group'); await shell(spareGroupId).locator(':scope > .builder-image-tools > .builder-delete').click(); assert.equal(await page.locator('.builder-data-group').count(), 1);
  await page.locator('.builder-data-advanced > summary').click(); await page.locator('#builder-data-striped').uncheck(); await page.locator('#builder-data-bordered').uncheck(); await page.locator('#builder-data-sticky_header').check(); await page.locator('#builder-data-min_width').fill('479'); await page.locator('.builder-data-advanced > summary').click();
  await page.locator('#page-builder-save').click(); assert.equal(posts.length, 0); assert.equal(await page.locator('#builder-data-min_width').evaluate(node => node === document.activeElement), true); await page.locator('#builder-data-min_width').fill('640');
  await page.locator('#builder-data-min_width').fill(''); await page.locator('#builder-view').selectOption('default'); assert.equal(await page.locator('#builder-data-min_width').inputValue(), '', 'automatic width stays unset after rerender'); await page.locator('.builder-data-advanced > summary').click(); await page.locator('#builder-data-min_width').fill('640');
  await page.locator('#builder-view').selectOption('compact'); await page.locator('#builder-view').selectOption('default'); await page.locator('#builder-view').selectOption('compact');
  await page.locator('#builder-type').selectOption('content'); assert.equal(await page.locator('.builder-data-table-editor').count(), 0); await page.locator('#builder-type').selectOption('data-table'); assert.equal(await page.locator('#builder-view').inputValue(), 'compact'); assert.equal(await page.locator('#builder-caption').inputValue(), 'Подпись'); assert.equal(await control(cellA, 'value').inputValue(), literal); assert.equal(await page.locator('#builder-data-min_width').inputValue(), '640'); assert.equal(await page.locator('.builder-image-row').count(), 0);
  assert.deepEqual(await page.locator('.builder-data-column').evaluateAll(nodes => nodes.map(node => node.dataset.dataId)), [columnB, columnA]); assert.deepEqual(await page.locator('.builder-data-cell').evaluateAll(nodes => nodes.map(node => node.dataset.dataId)), [cellB, cellA]);
  await summary(rowId).click(); await control(rowId, 'type').selectOption('group'); assert.equal(await control(rowId, 'group').inputValue(), 'Черновик группы', 'inactive row drafts survive view and block-type switches'); await control(rowId, 'type').selectOption('row');
  // All nested sections are opened deliberately to measure actual rendered controls.
  await page.locator('.builder-data-table-editor details,.builder-data-advanced').evaluateAll(nodes => nodes.forEach(node => node.open = true));
  await control(cellB, 'value').fill(''); assert.equal(await summary(cellB).innerText(), 'Ячейка');
  for (const width of disclosureWidths) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator('.builder-data-table-editor').evaluate(editor => [...editor.querySelectorAll('[data-data-id]')].map(shell => {
      const summary = shell.querySelector(':scope > details > summary'), tools = shell.querySelector(':scope > .builder-image-tools'), body = shell.querySelector(':scope > details > .builder-table-cell-body'); const a = shell.getBoundingClientRect(), b = tools.getBoundingClientRect(), c = summary.getBoundingClientRect();
      return { client: shell.clientWidth, scroll: shell.scrollWidth, left: a.left, right: a.right, toolsRight: b.right, toolsWidth: b.width, reserved: parseFloat(getComputedStyle(summary).paddingRight), bodyClient: body.clientWidth, bodyScroll: body.scrollWidth, summaryWidth: c.width };
    }));
    for (const item of geometry) { assert.ok(item.scroll <= item.client + 1 && item.bodyScroll <= item.bodyClient + 1, `${width}px no card overflow ${JSON.stringify(item)}`); assert.ok(item.left >= 0 && item.right <= width && item.toolsRight <= item.right + 1 && item.reserved >= item.toolsWidth, `${width}px controls stay within card ${JSON.stringify(item)}`); assert.ok(item.summaryWidth > item.reserved); }
    const overflow = await page.locator('#page-builder-modal .modal-body').evaluate(node => node.scrollWidth - node.clientWidth); assert.ok(overflow <= 1, `${width}px modal overflow ${overflow}`);
    const zones = await page.locator('.builder-data-table-editor .builder-add').evaluateAll(buttons => buttons.map(button => { const parent = button.parentElement, css = getComputedStyle(parent); return { text: button.innerText, aria: button.getAttribute('aria-label'), title: button.title, border: getComputedStyle(button).borderTopStyle, width: button.getBoundingClientRect().width, available: parent.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) }; }));
    assert.equal(zones.length, 3); for (const zone of zones) { assert.equal(zone.text, '+'); assert.equal(zone.aria, zone.title); assert.ok(zone.aria.startsWith('Добавить')); assert.equal(zone.border, 'dashed'); assert.ok(Math.abs(zone.width - zone.available) < 2, `${width}px full-width add zone ${JSON.stringify(zone)}`); }
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('#page-builder-save').click(); await close(); assert.equal(posts.length, 1);
  const saved = queue.pageBuilder.read(job.id), block = saved.document.common.blocks[0]; assert.equal(block.type, 'data-table'); assert.equal(block.view, 'compact'); assert.equal(block.caption, 'Подпись'); assert.deepEqual(block.media, []); assert.deepEqual(block.meta, { striped: false, bordered: false, sticky_header: true, min_width: 640 });
  assert.deepEqual(block.columns, [{ id: columnB, key: 'price', title: 'Цена' }, { id: columnA, key: 'name', title: '<b>Название</b>', align: 'center', width: 40, nowrap: true }]);
  assert.deepEqual(block.rows, [{ id: groupId, group: 'Раздел' }, { id: rowId, cells: [{ id: cellB, value: '' }, { id: cellA, value: literal, key: 'unrelated-key', align: 'right', colspan: 2, rowspan: 3, is_header: true, nowrap: true }] }]);
  await open(); assert.equal(await page.locator('.builder-data-table-editor details[open],.builder-data-advanced[open]').count(), 0); assert.equal(await control(cellA, 'value').inputValue(), literal); await page.locator('#builder-caption').fill('Отмена'); await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close(); assert.deepEqual(queue.pageBuilder.read(job.id), saved);
  await open(); await page.locator('#builder-type').selectOption('content'); await page.locator('#page-builder-save').click(); await close(); const other = queue.pageBuilder.read(job.id).document.common.blocks[0]; assert.equal(other.type, 'content'); for (const key of ['columns', 'rows', 'caption']) assert.equal(Object.hasOwn(other, key), false); assert.equal(other.meta?.striped, undefined); assert.ok(other.media.every(asset => !asset.originalUrl && !asset.bigUrl));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('queue handle reorders by keyboard and drag without selecting a different job', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'queue-reorder-ui-'));
  const queue = new Queue({ root, autoStart: false });
  queue.add('https://a.reestr35.ru\nhttps://b.reestr35.ru\nhttps://c.reestr35.ru');
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelectorAll('#jobs-body tr[data-job-id]').length === 3);
  const ids = queue.jobs.map(job => job.id);
  const visible = () => page.locator('#jobs-body tr[data-job-id]').evaluateAll(rows => rows.map(row => row.dataset.jobId));
  await page.locator(`[data-job-id="${ids[0]}"] td:nth-child(2)`).click();
  const handle = page.locator(`[data-job-drag="${ids[0]}"]`);
  const geometry = await page.evaluate(() => {
    const wrap = document.querySelector('.job-table-wrap'), button = document.querySelector('.job-drag-handle');
    const selected = document.querySelector('#jobs-body tr.table-active td');
    return { inset: button.getBoundingClientRect().left - wrap.getBoundingClientRect().left,
      radius: getComputedStyle(selected).borderTopLeftRadius };
  });
  assert.ok(geometry.inset < 10, `drag handle left inset is ${geometry.inset}px`);
  assert.equal(geometry.radius, '0px');
  await handle.focus(); await page.keyboard.press('ArrowUp');
  await page.waitForFunction(id => document.querySelectorAll('#jobs-body tr[data-job-id]')[1]?.dataset.jobId === id, ids[0]);
  assert.deepEqual(await visible(), [ids[2], ids[0], ids[1]]);
  assert.equal(await page.locator('#detail-url').getAttribute('href'), queue.jobs.find(job => job.id === ids[0]).url);
  assert.equal(await handle.evaluate(node => document.activeElement === node), true);
  assert.equal(await page.locator('#attempt-duration').getAttribute('title'), 'Активное время работы');
  const target = page.locator(`[data-job-id="${ids[1]}"]`);
  const bounds = await target.boundingBox();
  await page.locator(`[data-job-drag="${ids[2]}"]`).dragTo(target, { targetPosition: { x: 35, y: bounds.height - 2 } });
  await page.waitForFunction(id => document.querySelector('#jobs-body tr[data-job-id]')?.dataset.jobId === id, ids[0]);
  assert.deepEqual(await visible(), [ids[0], ids[1], ids[2]]);
  await page.reload();
  assert.deepEqual(await visible(), [ids[0], ids[1], ids[2]]);
});

test('queue panel stays within the viewport while the right result scrolls', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'queue-sticky-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  for (let index = 1; index < 12; index++) queue.add(`https://queue-${index}.reestr35.ru/`);
  const job = queue.jobs[0]; seedMoriPage(queue, job);
  const stored = queue.pageBuilder.read(job.id);
  for (let index = 0; index < 16; index++) {
    const block = structuredClone(stored.document.common.blocks[1]); block.id = `queue-extra-${index}`;
    block.media = (block.media || []).map((item, slot) => ({ ...item, id: `queue-extra-media-${index}-${slot}` }));
    block.items = (block.items || []).map((item, slot) => ({ ...item, id: `queue-extra-item-${index}-${slot}` }));
    stored.document.common.blocks.push(block);
  }
  queue.pageBuilder.write(job.id, stored.revision, stored.document, 1);
  const attempt = job.attempts[0], manifest = queue.stage.media.create(job, attempt, Buffer.from('<p>Queue layout</p>'), 'test');
  manifest.status = 'complete'; queue.stage.media.publish(job, attempt, manifest);
  Object.assign(attempt, { status: 'complete', captureStatus: 'complete' }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => document.querySelectorAll('#jobs-body tr').length === 12);
  await page.locator(`[data-job-id="${job.id}"]`).click(); await page.locator('#stage-step-3').click();
  await page.waitForSelector('#page-builder-content:not(.d-none)');
  const measure = () => page.evaluate(() => {
    const left = document.getElementById('left-column'), card = document.getElementById('queue-card'), list = document.querySelector('.job-table-wrap');
    const right = document.getElementById('results-column'), form = document.getElementById('batch-form'), progress = document.getElementById('queue-progress');
    const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
    return { viewport: innerHeight, scrollY, pageHeight: document.documentElement.scrollHeight, left: rect(left), card: rect(card), right: rect(right),
      form: rect(form), progress: rect(progress), list: rect(list), listScrollHeight: list.scrollHeight, listClientHeight: list.clientHeight,
      listScrollTop: list.scrollTop, position: getComputedStyle(left).position, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  for (const [width, height] of [[1440, 900], [1850, 950], [1440, 600]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(() => scrollTo(0, 0));
    const initial = await measure();
    assert.equal(initial.position, 'sticky'); assert.equal(initial.horizontalOverflow, false);
    assert.ok(initial.card.bottom <= height - 4, `${width}×${height}: entire queue panel starts within the viewport`);
    assert.ok(initial.listScrollHeight > initial.listClientHeight, `${width}×${height}: 12 rows scroll inside the panel`);
    assert.ok(initial.pageHeight > height + 250, `${width}×${height}: result is long enough to scroll`);
    await page.evaluate(() => scrollTo(0, 250));
    const stuck = await measure();
    assert.ok(stuck.scrollY > initial.card.top, `${width}×${height}: page scrolled past the queue start`);
    assert.ok(Math.abs(stuck.card.top - 12) <= 1, `${width}×${height}: queue sticks 12px below the viewport top`);
    assert.ok(stuck.card.bottom <= height - 4 && stuck.card.right <= stuck.right.left + 1, `${width}×${height}: queue stays visible beside results`);
    assert.ok(stuck.form.top >= stuck.card.top && stuck.progress.bottom <= stuck.list.top + 1, 'URL and progress stay above the scrollable list');
    await page.evaluate(() => scrollTo(0, 700));
    assert.ok(Math.abs((await measure()).card.top - 12) <= 1, `${width}×${height}: queue remains fixed deeper in the result`);
    await page.locator('.job-table-wrap').focus(); await page.keyboard.press('PageDown');
    const scrolledList = await measure(); assert.ok(scrolledList.listScrollTop > 0, 'PageDown scrolls the focused task list');
    assert.ok(Math.abs(scrolledList.card.top - 12) <= 1 && scrolledList.form.top >= scrolledList.card.top, 'keyboard list scroll keeps controls visible');
    await page.locator('#url-input').fill('https://example.reestr35.ru/'); assert.equal(await page.locator('#url-input').inputValue(), 'https://example.reestr35.ru/');
    await page.locator('#clear-url').click(); assert.equal(await page.locator('#url-input').inputValue(), '');
    assert.match(await page.locator('#progress-label').innerText(), /\d+\s*\/\s*\d+/);
    await page.screenshot({ path: path.join(testOutput(), `queue-sticky-${width}x${height}.png`) });
  }
  await page.locator(`[data-job-id="${queue.jobs[11].id}"]`).click();
  assert.match(await page.locator('#detail-url').innerText(), /queue-11\.reestr35\.ru/, 'queue row remains selectable after internal scrolling');
  await page.locator(`[data-job-id="${job.id}"]`).click(); await page.locator('#stage-step-3').click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 }); await page.evaluate(() => scrollTo(0, 0));
    const initial = await measure();
    assert.notEqual(initial.position, 'sticky'); assert.equal(initial.horizontalOverflow, false);
    assert.ok(initial.card.bottom <= 700 + 1, `${width}px: queue panel fits the initial mobile viewport`);
    assert.ok(initial.right.top >= initial.card.bottom, `${width}px: results remain below the queue`);
    await page.evaluate(() => scrollTo(0, 250));
    const moved = await measure(); assert.ok(moved.card.top < initial.card.top - 100, `${width}px: stacked queue scrolls with the page`);
    assert.ok(moved.right.top >= moved.card.bottom, `${width}px: scrolled queue does not overlap the result`);
    await page.screenshot({ path: path.join(testOutput(), `queue-stacked-${width}.png`) });
  }
});

test('catalog plus buttons add image, document and iframe to step 2 with browser file chooser', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-manual-media-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  const attempt = job.attempts[0], manifest = queue.stage.media.create(job, attempt, Buffer.from('<p>Manual media</p>'), 'test');
  manifest.status = 'complete'; queue.stage.media.publish(job, attempt, manifest); Object.assign(attempt, { status: 'complete', captureStatus: 'complete' }); queue.save();
  const projected = queue.snapshot('token').jobs[0].attempts[0];
  assert.equal(projected.captureStatus, 'complete'); assert.equal(projected.status, 'complete'); assert.equal(projected.htmlMedia.status, 'complete');
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const assertAddGeometry = async selector => {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const boxes = await page.locator(selector).evaluate(grid => ({ overflow: grid.scrollWidth > grid.clientWidth,
        tiles: [...grid.children].slice(0, 2).map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) }));
      assert.equal(boxes.overflow, false, `${width}px catalog has no horizontal overflow`);
      assert.ok(Math.abs(boxes.tiles[0].width - boxes.tiles[1].width) < 1 && Math.abs(boxes.tiles[0].height - boxes.tiles[1].height) < 1, `${width}px plus tile matches media tile`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  const assertAddColor = async selector => {
    const add = page.locator(selector), style = () => add.evaluate(node => ({ color: getComputedStyle(node).color, border: getComputedStyle(node).borderColor }));
    const idle = await style(); assert.equal(idle.color, idle.border, 'idle plus matches the gray dashed border');
    await add.hover(); const hover = await style(); assert.equal(hover.color, hover.border); assert.notEqual(hover.color, idle.color);
    await page.mouse.move(0, 0); await page.locator('.builder-catalog-header .btn-close').focus(); await page.keyboard.press('Tab');
    assert.equal(await add.evaluate(node => node === document.activeElement), true);
    const focused = await style(); assert.equal(focused.color, hover.color, 'keyboard focus uses the same primary color as hover');
  };
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click();
  await page.locator('#stage-step-3').click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show');
  await page.getByRole('button', { name: 'Выбрать основную картинку' }).click();
  const imageAdd = page.getByRole('button', { name: 'Добавить изображение из проводника' });
  assert.equal(await page.locator('.builder-catalog-grid > :first-child').getAttribute('class'), 'builder-catalog-add builder-catalog-add-image');
  await assertAddColor('.builder-catalog-add-image');
  const [imageChooser] = await Promise.all([page.waitForEvent('filechooser'), imageAdd.click()]);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R5sGAAAAAElFTkSuQmCC', 'base64');
  await imageChooser.setFiles({ name: 'Новый кадр.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.builder-catalog-tile');
  await assertAddGeometry('.builder-catalog-grid');
  assert.equal(await page.locator('.builder-catalog-grid > :first-child').getAttribute('class'), 'builder-catalog-add builder-catalog-add-image');
  await page.locator('.builder-catalog-header .btn-close').click();
  await page.locator('#builder-type').selectOption('embed');
  await page.getByRole('button', { name: 'Выбрать фрейм шага 2' }).click();
  await assertAddColor('.builder-catalog-add-frame');
  await page.getByRole('button', { name: 'Добавить фрейм', exact: true }).click();
  const frameSource = '  <iframe\n title="Видео" src="https://rutube.ru/play/embed/manual/"></iframe>\n';
  const frameEditor = page.getByRole('textbox', { name: 'Код iframe' });
  assert.equal(await frameEditor.getAttribute('contenteditable'), 'true');
  for (const width of [1440, 390, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator('.builder-frame-code-panel').evaluate(panel => {
      const editor = panel.querySelector('.builder-frame-code-editor');
      return { panelHeight: panel.getBoundingClientRect().height, editorHeight: editor.getBoundingClientRect().height, panelWidth: panel.getBoundingClientRect().width, panelScrollWidth: panel.scrollWidth };
    });
    assert.ok(geometry.panelHeight <= 220, `${width}px: iframe modal is at most 220px tall (${geometry.panelHeight}px)`);
    assert.ok(geometry.editorHeight >= 80 && geometry.editorHeight <= 96, `${width}px: iframe code remains usable (${geometry.editorHeight}px)`);
    assert.ok(geometry.panelScrollWidth <= geometry.panelWidth + 1, `${width}px: iframe modal has no horizontal overflow`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await frameEditor.fill(frameSource);
  assert.equal(await page.evaluate(() => window.ArmEditors.text('builder-frame-code-editor')), frameSource, 'editable HTML keeps exact whitespace without Prettier');
  assert.ok(await page.locator('.builder-frame-code-editor .cm-lineNumbers').count());
  assert.ok(await page.locator('.builder-frame-code-editor .cm-foldGutter').count());
  assert.ok(await page.locator('.builder-frame-code-editor .cm-line span').count());
  const frameSubmit = page.locator('.builder-frame-code-panel button[type=submit]'), frameClose = page.locator('.builder-frame-code-panel .btn-close');
  await frameSubmit.focus(); await page.keyboard.press('Tab'); assert.equal(await frameClose.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Shift+Tab'); assert.equal(await frameSubmit.evaluate(node => node === document.activeElement), true);
  await frameSubmit.click();
  await page.waitForSelector('.builder-frame-tile');
  assert.equal(await page.evaluate(() => window.ArmEditors.text('builder-frame-code-editor')), '', 'closing releases the editable CodeMirror instance');
  assert.equal(queue.stage.media.read(job, attempt, true).resources.at(-1).snippet, frameSource);
  await assertAddGeometry('.builder-frame-catalog .builder-catalog-grid');
  assert.equal(await page.locator('.builder-frame-code-layer').count(), 0);
  await page.route('**/choose-frame', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Пробная ошибка"}' }));
  await page.locator('.builder-frame-tile').click();
  await page.waitForFunction(() => document.querySelector('.builder-frame-catalog .builder-catalog-message')?.getAttribute('role') === 'alert');
  assert.equal(await page.getByRole('button', { name: 'Добавить фрейм', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('.builder-frame-tile').isEnabled(), true);
  assert.deepEqual(pageErrors, []);
  await page.unroute('**/choose-frame');
  await page.locator('.builder-frame-catalog .btn-close').click();
  await page.locator('#builder-type').selectOption('links'); await page.locator('#builder-view').selectOption('documents');
  await page.getByRole('button', { name: 'Добавить документ', exact: true }).click();
  await page.locator('.builder-link-row').first().locator(':scope > .builder-item-details > summary').click();
  await page.getByRole('button', { name: 'Выбрать документ 1' }).click();
  await assertAddColor('.builder-catalog-add-document');
  const documentAdd = page.getByRole('button', { name: 'Добавить документ из проводника' });
  const [documentChooser] = await Promise.all([page.waitForEvent('filechooser'), documentAdd.click()]);
  await documentChooser.setFiles({ name: 'Новый документ.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
  await page.waitForSelector('.builder-document-catalog-tile');
  await assertAddGeometry('.builder-document-catalog-grid');
  assert.equal(await page.locator('.builder-document-catalog-grid > :first-child').getAttribute('class'), 'builder-catalog-add builder-catalog-add-document');
  assert.deepEqual(queue.stage.media.read(job, attempt, true).resources.map(item => item.manual), [true, true, true]);
  await page.locator('.builder-document-catalog-tile').click();
  await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  const documentCard = page.locator('[data-builder-id="common-hero"]');
  assert.equal(await documentCard.locator('.builder-card-document').getAttribute('title'), 'Новый документ.pdf');
  assert.equal(await documentCard.locator('.builder-card-document.media-document-document svg').count(), 1);
  assert.match(await documentCard.getAttribute('aria-label'), /Документов: 1/);
  const stored = queue.pageBuilder.read(job.id), documentBlock = stored.document.common.blocks.find(block => block.id === 'common-hero');
  const selectedItem = documentBlock.items[0];
  documentBlock.items.push({ ...structuredClone(selectedItem), id: 'extra-document-1', link_text: 'Второй документ.pdf' },
    { ...structuredClone(selectedItem), id: 'extra-document-2', link_text: 'Третий документ.pdf' });
  queue.pageBuilder.write(job.id, stored.revision, stored.document, 1);
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.locator('#stage-step-3').click();
  await page.waitForSelector('[data-builder-id="common-hero"] .builder-document-media-preview');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await documentCard.evaluate(button => {
      const card = button.getBoundingClientRect(), gallery = button.querySelector('.builder-document-media-preview').getBoundingClientRect();
      const chip = button.querySelector('.builder-card-document'), tile = chip.getBoundingClientRect(), style = getComputedStyle(chip);
      const image = document.querySelector('[data-builder-id="common-actions"] .builder-media-preview img'), imageGallery = image.parentElement;
      const originalDisplay = imageGallery.style.display, originalShrink = image.style.flexShrink;
      imageGallery.style.display = 'flex'; image.style.flexShrink = '0';
      const imageTile = image.getBoundingClientRect(); image.style.flexShrink = originalShrink; imageGallery.style.display = originalDisplay;
      return { cardRight: card.right, galleryRight: gallery.right, visible: gallery.width > 0,
        tile: { width: tile.width, height: tile.height }, image: { width: imageTile.width, height: imageTile.height },
        background: style.backgroundColor, color: style.color, cardBackground: getComputedStyle(button).backgroundColor };
    });
    assert.equal(geometry.visible && geometry.galleryRight <= geometry.cardRight + 1, true, `${width}px document preview fits its card`);
    assert.equal(geometry.tile.height, geometry.image.height, `${width}px document tile matches the adjacent image height`);
    assert.equal(geometry.tile.width, width <= 767 ? 52 : geometry.image.width, `${width}px document tile keeps the image width without shrinking`);
    assert.notEqual(geometry.background, geometry.cardBackground, `${width}px document tile has a colored background`);
    assert.equal(await documentCard.locator('.builder-card-document svg:visible').count(), width <= 575 ? 1 : 2);
    assert.equal(await documentCard.locator('.builder-document-more-mobile:visible, .builder-document-more-desktop:visible').innerText(), width <= 575 ? '+2' : '+1');
    await page.screenshot({ path: path.join(testOutput(), `document-card-${width}.png`) });
  }
  assert.match(await documentCard.getAttribute('aria-label'), /Документов: 3/);
  assert.equal(await documentCard.locator('.builder-document-media-preview a, .builder-document-media-preview iframe, .builder-document-media-preview img').count(), 0);
  await page.locator('#stage-step-2').click(); await page.locator('#html-media-accordion summary').first().click();
  await page.getByRole('button', { name: /^Открыть изображение/ }).click(); await page.waitForSelector('#media-modal.show');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#media-download').click()]);
  assert.equal(download.suggestedFilename(), 'Новый кадр.png');
  assert.deepEqual(pageErrors, []);
  await page.locator('#media-modal .btn-close').click();
});

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
  await page.waitForFunction(id => document.querySelector(`[data-job-id="${id}"] td:nth-child(2)`)?.textContent.trim() === '—', queue.jobs[0].id);
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

test('HTML media retries a failed manifest once per render and ignores stale responses', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'html-media-retry-ui-'));
  const queue = new Queue({ root, autoStart: false });
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage(), requests = [];
  const manifest = label => ({ resources: [{ id: 1, status: 'downloaded', originalUrl: label, resolvedUrl: label, mime: 'application/octet-stream', detectedMime: 'image/png', object: 'objects/test.png', bytes: 1 }] });
  let releaseRetry, retryArrived, releaseStale, staleArrived;
  const retryGate = new Promise(resolve => { releaseRetry = resolve; }), arrived = new Promise(resolve => { retryArrived = resolve; });
  const staleGate = new Promise(resolve => { releaseStale = resolve; }), staleStarted = new Promise(resolve => { staleArrived = resolve; });
  await page.route('**/api/html-media/retry-job/1/*/manifest', async route => {
    const revision = Number(new URL(route.request().url()).pathname.split('/').at(-2)); requests.push(revision);
    if (revision === 1 && requests.filter(value => value === 1).length === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Временная ошибка"}' });
    if (revision === 1) { retryArrived(); await retryGate; }
    if (revision === 2) { staleArrived(); await staleGate; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest(revision === 3 ? 'https://example.org/new.png' : 'https://example.org/old.png')) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const render = revision => page.evaluate(async revision => {
    const attempt = { number: 1, status: 'complete', htmlMedia: { revision, source: { bytes: 1024 }, total: 1, pending: 0 } };
    const job = { id: 'retry-job', attempts: [attempt] };
    await window.HtmlMedia.render(job, attempt, { csrfToken: '', refresh() {} });
  }, revision);
  await render(1);
  assert.match(await page.locator('#html-media-content .alert-danger').innerText(), /Временная ошибка/);
  const firstRetry = render(1), duplicate = render(1); await arrived;
  assert.deepEqual(requests, [1, 1], 'duplicate render during an in-flight retry starts no extra request');
  releaseRetry(); await Promise.all([firstRetry, duplicate]);
  assert.equal(await page.locator('#html-media-content [aria-label="Открыть изображение https://example.org/old.png"]').count(), 1, 'successful retry renders the same revision');
  const stale = render(2); await staleStarted;
  const newer = render(3); await newer;
  releaseStale(); await stale;
  assert.deepEqual(requests, [1, 1, 2, 3]);
  assert.equal(await page.locator('#html-media-content [aria-label="Открыть изображение https://example.org/new.png"]').count(), 1, 'detected raster MIME renders as an image');
  assert.equal(await page.locator('#html-media-content [aria-label="Открыть изображение https://example.org/old.png"]').count(), 0, 'old manifest cannot append after a newer revision');
});

test('step 2 downloaded non-raster resources render accessible local file cards', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'html-media-documents-ui-'));
  const queue = new Queue({ root, autoStart: false });
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const resources = [
    { id: 1, status: 'downloaded', originalUrl: 'https://example.org/other', resolvedUrl: 'https://example.org/other', occurrence: { downloadFilename: '2862.doc' }, mime: 'application/octet-stream', object: 'objects/document', bytes: 152064 },
    { id: 2, status: 'downloaded', originalUrl: 'https://example.org/%D0%90'.padEnd(260, 'B') + '.svg', resolvedUrl: 'https://example.org/%D0%A1%D1%85%D0%B5%D0%BC%D0%B0.svg', occurrence: { downloadFilename: '../unsafe.svg' }, mime: 'image/svg+xml', object: 'objects/vector', bytes: 1048576 },
    { id: 3, status: 'downloaded', originalUrl: 'https://example.org/', resolvedUrl: 'https://example.org/', mime: 'application/octet-stream', object: 'objects/unknown' },
    { id: 4, status: 'downloaded', originalUrl: 'https://example.org/long', resolvedUrl: 'https://example.org/long', occurrence: { downloadFilename: `${'long-name-'.repeat(12)}.pdf` }, mime: 'application/pdf', object: 'objects/long', bytes: 900 },
    { id: 5, status: 'downloaded', originalUrl: 'https://example.org/manual.pdf', resolvedUrl: 'https://example.org/manual.pdf', mime: 'application/zip', object: 'objects/archive', bytes: 10000 },
    { id: 6, status: 'downloaded', originalUrl: 'https://example.org/photo.png', resolvedUrl: 'https://example.org/photo.png', mime: 'image/png', object: 'objects/image', bytes: 68 },
    { id: 7, status: 'external', originalUrl: 'https://example.org/embed', resolvedUrl: 'https://example.org/embed', occurrence: { tag: 'iframe', attribute: 'src' } }
  ];
  await page.route('**/api/html-media/document-cards/1/1/manifest', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resources }) }));
  await page.route('**/api/html-media/document-cards/1/1/objects/image', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+R5sGAAAAAElFTkSuQmCC', 'base64') }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const attempt = { number: 1, status: 'complete', htmlMedia: { revision: 1, source: { bytes: 1024 }, total: 7, pending: 0 } };
    await window.HtmlMedia.render({ id: 'document-cards', attempts: [attempt] }, attempt, { csrfToken: '', refresh() {} });
    const host = document.createElement('div'); host.className = 'container-fluid p-3'; host.append(document.querySelector('#html-media-content')); document.body.append(host);
  });
  const section = page.locator('#html-media-content .html-media-section').filter({ hasText: 'Документы и медиа' });
  const imageSection = page.locator('#html-media-content .html-media-section').filter({ hasText: 'Изображения' });
  const frameSection = page.locator('#html-media-content .html-media-section').filter({ hasText: 'Внешние встраивания' });
  assert.equal(await section.locator('summary .badge').innerText(), '5');
  await imageSection.locator('summary').click(); await section.locator('summary').click(); await frameSection.locator('summary').click();
  const cards = section.locator('.media-document-card'); assert.equal(await cards.count(), 5);
  assert.equal(await cards.nth(0).locator('.media-document-name').innerText(), '2862.doc');
  assert.match(await cards.nth(0).locator('.media-document-meta').innerText(), /DOC\s+0,15 МБ/);
  assert.equal(await cards.nth(1).locator('.media-document-name').innerText(), 'Схема.svg');
  assert.equal(await cards.nth(1).locator('.media-document-name').getAttribute('title'), 'Схема.svg');
  assert.equal(await cards.nth(1).locator('.media-document-icon.media-document-graphic').count(), 1);
  assert.equal(await cards.nth(2).locator('.media-document-name').innerText(), 'Файл');
  assert.equal(await cards.nth(2).locator('.media-document-meta').innerText(), 'Тип неизвестен');
  assert.equal(await cards.nth(3).locator('.media-document-name').getAttribute('title'), `${'long-name-'.repeat(12)}.pdf`);
  assert.equal(await cards.nth(3).locator('.media-document-name').evaluate(node => getComputedStyle(node).webkitLineClamp), '2');
  assert.match(await cards.nth(3).locator('.media-document-meta').innerText(), /< 0,01 МБ/);
  assert.equal(await cards.nth(4).locator('.media-document-name').innerText(), 'manual.pdf');
  assert.equal(await cards.nth(4).locator('.media-document-meta .badge').innerText(), 'ZIP');
  assert.equal(await cards.nth(4).locator('.media-document-icon.media-document-archive').count(), 1);
  for (const [index, object] of ['document', 'vector', 'unknown', 'long', 'archive'].entries()) {
    const action = cards.nth(index);
    assert.equal(await action.evaluate(node => node.tagName), 'A');
    assert.equal(await action.getAttribute('href'), `/api/html-media/document-cards/1/1/objects/${object}?resourceId=${index + 1}`);
    assert.match(await action.getAttribute('aria-label'), /Скачать файл/);
    await action.focus(); assert.equal(await action.evaluate(node => document.activeElement === node), true);
  }
  const padding = await section.locator('.accordion-body').evaluate(node => {
    const style = getComputedStyle(node); return [style.paddingLeft, style.paddingRight];
  });
  assert.deepEqual(padding, ['16px', '16px'], 'accordion content has symmetric side padding');
  const idle = await cards.first().evaluate(node => ({ border: getComputedStyle(node).borderColor, shadow: getComputedStyle(node).boxShadow }));
  await cards.first().hover();
  const hovered = await cards.first().evaluate(node => ({ border: getComputedStyle(node).borderColor, shadow: getComputedStyle(node).boxShadow }));
  assert.notDeepEqual(hovered, idle, 'whole card highlights on hover');
  await cards.nth(1).focus(); await page.keyboard.press('Shift+Tab');
  assert.equal(await section.locator('.media-document-delete').first().evaluate(node => document.activeElement === node), true, 'the first document trash is an accessible keyboard stop');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await cards.first().evaluate(node => document.activeElement === node), true);
  assert.equal(await cards.first().evaluate(node => getComputedStyle(node).outlineStyle), 'solid', 'whole card has a visible keyboard focus outline');
  await page.route('**/api/html-media/document-cards/1/1/objects/**', route => route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="test.bin"' }, body: 'fixture' }));
  const pointerDownload = page.waitForEvent('download'); await cards.first().locator('.media-document-icon').click();
  assert.match((await pointerDownload).url(), /objects\/document\?resourceId=1$/, 'icon click downloads the local object');
  const keyboardDownload = page.waitForEvent('download'); await cards.nth(1).focus(); await page.keyboard.press('Enter');
  assert.match((await keyboardDownload).url(), /objects\/vector\?resourceId=2$/, 'Enter downloads the local object');
  await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(0, 0);
  const surfaces = [
    { label: 'document', outer: cards.first(), control: cards.first(), summary: section.locator('summary') },
    { label: 'image', outer: imageSection.locator('.image-card').first(), control: imageSection.locator('.image-card > button').first(), summary: imageSection.locator('summary') },
    { label: 'iframe', outer: frameSection.locator('.image-card').first(), control: frameSection.locator('.image-card > button').first(), summary: frameSection.locator('summary') }
  ];
  const appearance = locator => locator.evaluate(node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return { borderColor: style.borderColor, boxShadow: style.boxShadow, outlineStyle: style.outlineStyle, outlineColor: style.outlineColor, outlineWidth: style.outlineWidth, size: [Math.round(rect.width), Math.round(rect.height)] };
  });
  for (const width of [1440, 920, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    if ([1440, 920, 390, 320].includes(width)) {
      const samples = [];
      for (const surface of surfaces) {
        await page.mouse.move(0, 0); await page.evaluate(() => document.activeElement?.blur());
        const normal = await appearance(surface.outer);
        await surface.control.hover(); const hover = await appearance(surface.outer);
        await page.mouse.move(0, 0);
        await surface.summary.focus(); await page.keyboard.press('Tab');
        assert.equal(await surface.control.evaluate(node => document.activeElement === node), true, `${width}px: ${surface.label} receives keyboard focus`);
        const focus = await appearance(surface.outer);
        assert.deepEqual(hover.size, normal.size, `${width}px: ${surface.label} hover keeps card geometry`);
        assert.deepEqual(focus.size, normal.size, `${width}px: ${surface.label} focus keeps card geometry`);
        samples.push({ label: surface.label, normal, hover, focus });
      }
      for (const state of ['normal', 'hover', 'focus']) {
        const presentation = value => { const { size, ...style } = value; return style; };
        assert.deepEqual(presentation(samples[1][state]), presentation(samples[0][state]), `${width}px: image and document ${state} frame match`);
        assert.deepEqual(presentation(samples[2][state]), presentation(samples[0][state]), `${width}px: iframe and document ${state} frame match`);
      }
      assert.notEqual(samples[0].hover.borderColor, samples[0].normal.borderColor, `${width}px: hover changes outer border`);
      assert.equal(samples[0].focus.outlineStyle, 'solid', `${width}px: focus shows outer outline`);
    }
    const geometry = await cards.first().evaluate(card => {
      const rect = card.getBoundingClientRect(), name = card.querySelector('.media-document-name'), nameRect = name.getBoundingClientRect();
      const icon = card.querySelector('.media-document-icon').getBoundingClientRect();
      return { card: [Math.round(rect.width), Math.round(rect.height)], icon: [Math.round(icon.width), Math.round(icon.height)], horizontal: icon.right < nameRect.left, nameFits: name.scrollWidth <= name.clientWidth + 1, nameInside: nameRect.right <= rect.right + 1, pageFits: document.documentElement.scrollWidth <= innerWidth };
    });
    assert.equal(geometry.horizontal && geometry.nameFits && geometry.nameInside && geometry.pageFits && geometry.card[1] >= 100 && geometry.card[1] <= 115, true, `${width}px: ${JSON.stringify(geometry)}`);
    const columns = await cards.evaluateAll(nodes => new Set(nodes.slice(0, 3).map(node => Math.round(node.getBoundingClientRect().left))).size);
    assert.equal(columns, ({ 320: 1, 390: 1, 768: 2, 920: 2, 1440: 3 })[width], `${width}px: document grid columns`);
    assert.equal(await cards.nth(3).evaluate(card => {
      const name = card.querySelector('.media-document-name');
      return name.scrollWidth <= name.clientWidth + 1 && name.getBoundingClientRect().right <= card.getBoundingClientRect().right + 1 && name.clientHeight <= parseFloat(getComputedStyle(name).lineHeight) * 2 + 1;
    }), true, `${width}px: long name stays within two lines`);
    await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(0, 0);
    if ([1440, 920, 390, 320].includes(width)) await page.locator('#html-media-accordion').screenshot({ path: path.join(testOutput(), `ui-step-two-media-cards-${width}.png`) });
  }
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
  assert.equal(await page.locator('#page-builder-save').innerText(), 'Сохранение…');
  assert.equal(await page.locator('#page-builder-fields input, #page-builder-fields textarea, #page-builder-fields select, #page-builder-fields button, .builder-review-footer select').evaluateAll(controls => controls.every(control => control.disabled)), true, 'all draft editors and media actions are disabled during POST');
  await cancelSave.evaluate(node => node.click()); assert.equal(await page.locator('#page-builder-modal').isVisible(), true, 'Cancel cannot interrupt an in-flight save'); await page.keyboard.press('Escape'); assert.equal(await page.locator('#page-builder-modal').isVisible(), true, 'Escape cannot interrupt an in-flight save'); await closeSave.evaluate(node => node.click()); assert.equal(await page.locator('#page-builder-modal').isVisible(), true, 'close cannot interrupt an in-flight save');
  await page.getByRole('button', { name: /^Быстрые действия\./ }).evaluate(node => node.click()); assert.equal(await page.locator('#builder-title').inputValue(), 'MORI CINEMA · атомарное сохранение', 'another block cannot replace the pending draft');
  releaseDelayedSave(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); await page.unroute(builderApiPattern, delayedSaveHandler); await page.waitForFunction(() => document.querySelector('#page-builder-content > .builder-section')?.textContent.includes('MORI CINEMA · атомарное сохранение'));
  stored = queue.pageBuilder.read(job.id); assert.equal(stored.revision, 5); assert.equal(stored.document.common.blocks[0].title, 'MORI CINEMA · атомарное сохранение'); assert.equal(await page.evaluate(() => document.activeElement?.dataset.builderId), 'common-hero', 'completed delayed save renders and restores focus to its opener');
  let releaseFailedSave, markFailedSaveArrived; const failedSaveGate = new Promise(resolve => { releaseFailedSave = resolve; }), failedSaveArrived = new Promise(resolve => { markFailedSaveArrived = resolve; });
  const failedSaveHandler = async route => { if (route.request().method() !== 'POST') return route.continue(); markFailedSaveArrived(); await failedSaveGate; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Временная ошибка"}' }); };
  await page.route(builderApiPattern, failedSaveHandler); await commonHero.click(); await page.locator('#builder-title').fill('Черновик после ошибки'); await page.locator('#page-builder-save').click(); await failedSaveArrived;
  assert.equal(await page.locator('#builder-title').isDisabled(), true);
  releaseFailedSave(); await page.waitForFunction(() => document.querySelector('#page-builder-form-error').textContent.includes('Временная ошибка'));
  assert.equal(await page.locator('#builder-title').isEnabled(), true, 'failed POST restores draft editing');
  assert.equal(await page.locator('#builder-add-image').count(), 0, 'fixed media slot has no add control after a failed POST');
  assert.equal(await page.locator('.builder-media-picker').first().isEnabled(), true, 'failed POST restores the media picker');
  assert.equal(await page.locator('#builder-review-status').isEnabled(), true, 'failed POST restores review control');
  assert.equal(await page.locator('#page-builder-save').innerText(), 'Сохранить');
  await page.locator('#builder-title').fill('Ещё правка'); assert.equal(await page.locator('#builder-title').inputValue(), 'Ещё правка');
  await page.unroute(builderApiPattern, failedSaveHandler); await cancelSave.click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  assert.equal(queue.pageBuilder.read(job.id).revision, 5, 'failed save and cancelled draft leave durable data unchanged');
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

test('step 3 links editor keeps per-view drafts and selects verified step 2 documents', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-links-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0];
  seedMoriPage(queue, job);
  const attempt = job.attempts[0];
  const documentFixtures = [
    ['manual.pdf', 'Руководство.pdf', 'application/pdf', Buffer.from('%PDF-1.7\nfirst')],
    ['second.pdf', 'Второй.pdf', 'application/pdf', Buffer.from('%PDF-1.7\nsecond')],
    ['chart.svg', 'Диаграмма.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['sound.mp3', 'Звук.mp3', 'audio/mpeg', Buffer.from('ID3sample')],
    ['movie.mp4', 'Ролик.mp4', 'video/mp4', Buffer.from('000000106674797069736f6d00000000', 'hex')],
    ['archive.zip', 'Архив.zip', 'application/zip', Buffer.from('504b030400000000', 'hex')]
  ];
  const html = documentFixtures.map(([url, name]) => `<a href="https://example.org/${url}" download="${name}">${name}</a>`).join('');
  const manifest = queue.stage.media.create(job, attempt, Buffer.from(html), 'test');
  for (const [index, [, , mime, bytes]] of documentFixtures.entries()) {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(queue.stage.media.directory(job, attempt), 'objects', sha256), bytes);
    Object.assign(manifest.resources[index], { status: 'downloaded', mime, bytes: bytes.length, sha256, object: `objects/${sha256}` });
  }
  manifest.status = 'complete'; queue.stage.media.publish(job, attempt, manifest);
  Object.assign(attempt, { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: documentFixtures.length, pending: 0 } }); queue.save();
  const original = queue.pageBuilder.read(job.id);
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const opener = page.locator('[data-builder-id="common-actions"]'), close = async () => { await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); };
  await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('#builder-type').inputValue(), 'links'); assert.equal(await page.locator('#builder-view').inputValue(), 'links');
  assert.deepEqual(await page.locator('#page-builder-fields > *').evaluateAll(nodes => nodes.slice(0, 3).map(node => node.className)), ['builder-type-view', 'mb-3', 'builder-content-fields']);
  assert.deepEqual(await page.locator('.builder-content-fields > *').evaluateAll(nodes => nodes.map(node => node.className)), ['builder-text-fields', 'builder-images-section builder-links-section', 'builder-banner-advanced builder-links-advanced']);
  assert.equal(await page.locator('.builder-link-add .builder-add-plus').innerText(), '+');
  assert.equal(await page.locator('.builder-editor-placeholder').count(), 0);
  for (let index = 0; index < 3; index++) {
    await page.getByRole('button', { name: 'Добавить ссылку' }).click();
    const row = page.locator('.builder-link-row').nth(index);
    assert.equal(await row.locator('label').count(), 0);
    assert.deepEqual(await row.locator('input').evaluateAll(nodes => nodes.map(node => [node.placeholder, node.getAttribute('aria-label')])), [['URL', 'URL'], ['Текст ссылки', 'Текст ссылки']]);
    assert.equal(await row.locator('input').evaluateAll(nodes => nodes[1].getBoundingClientRect().top > nodes[0].getBoundingClientRect().bottom), true, 'link inputs stack vertically');
    await row.getByLabel('URL').fill(`https://example.org/link-${index}`); await row.getByLabel('Текст ссылки').fill(`Ссылка ${index}`);
  }
  const ids = await page.locator('.builder-link-row').evaluateAll(nodes => nodes.map(node => node.dataset.itemId));
  await page.getByRole('button', { name: 'Перетащить ссылку 1' }).focus(); await page.keyboard.press('ArrowDown');
  assert.deepEqual(await page.locator('.builder-link-row').evaluateAll(nodes => nodes.map(node => node.dataset.itemId)), [ids[1], ids[0], ids[2]]);
  await page.locator(`.builder-link-row[data-item-id="${ids[2]}"] .builder-link-drag`).dragTo(page.locator(`.builder-link-row[data-item-id="${ids[1]}"]`), { targetPosition: { x: 15, y: 4 } });
  assert.deepEqual(await page.locator('.builder-link-row').evaluateAll(nodes => nodes.map(node => node.dataset.itemId)), [ids[2], ids[1], ids[0]]);
  await page.getByRole('button', { name: 'Удалить ссылку 3' }).click(); assert.equal(await page.locator('.builder-link-row').count(), 2);
  await page.locator('.builder-links-advanced summary').click(); assert.equal(await page.locator('#builder-links-columns').inputValue(), '2');
  await page.locator('#builder-links-columns').selectOption('3'); await page.locator('#builder-links-compact').check();
  await page.locator('#builder-view').selectOption('documents'); assert.equal(await page.locator('.builder-link-row').count(), 0);
  await page.locator('.builder-links-advanced summary').click(); assert.equal(await page.locator('#builder-links-columns').inputValue(), '1');
  await page.getByRole('button', { name: 'Добавить документ' }).click();
  const docRow = page.locator('.builder-link-row').first();
  const documentItem = docRow.locator(':scope > .builder-item-details'), documentSummary = documentItem.locator(':scope > summary');
  assert.equal(await documentItem.getAttribute('open'), null); assert.equal(await documentSummary.innerText(), 'Документ');
  assert.equal(await docRow.getByRole('button', { name: 'Перетащить документ 1' }).isEnabled(), true); assert.equal(await docRow.getByRole('button', { name: 'Удалить документ 1' }).isEnabled(), true);
  await documentSummary.focus(); await page.keyboard.press('Enter'); assert.equal(await documentItem.getAttribute('open'), '');
  assert.deepEqual(await docRow.locator('.builder-document-fields input').evaluateAll(nodes => nodes.map(node => [node.placeholder, node.getAttribute('aria-label')])), [['Заголовок', 'Заголовок'], ['Текст ссылки', 'Текст ссылки']]);
  const documentText = docRow.locator('.builder-item-markdown');
  assert.equal(await documentText.locator(':scope > summary').innerText(), 'Текст'); assert.equal(await documentText.getAttribute('open'), null);
  assert.equal(await documentText.getByLabel('Текст в Markdown').getAttribute('placeholder'), 'Текст в Markdown');
  assert.equal(await documentText.locator('.builder-markdown-tools').isVisible(), false, 'document Markdown editor is collapsed by default');
  await documentText.locator(':scope > summary').click();
  assert.equal(await documentText.getByRole('button', { name: 'Жирный', exact: true }).count(), 1);
  assert.equal(await docRow.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'document Markdown editor has no horizontal overflow');
  assert.deepEqual(await docRow.locator('.builder-document-settings label').allInnerTexts(), ['Открывать', 'Скачивать']);
  assert.equal(await docRow.locator('.builder-document-preview .builder-media-placeholder svg').count(), 1);
  assert.equal(await docRow.locator('.builder-document-preview-name').count(), 0);
  await docRow.locator('.builder-document-preview').focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await docRow.locator('.builder-document-preview .builder-image-preview-hint').evaluate(node => getComputedStyle(node).opacity), '1');
  assert.equal(await docRow.locator('[id$="file_id"]').count(), 0);
  await docRow.getByRole('button', { name: 'Выбрать документ 1' }).click(); await page.waitForSelector('.builder-document-catalog');
  assert.equal(await page.locator('.builder-document-catalog [role="alert"]').count(), 0);
  await page.locator('.builder-document-catalog-tile').first().waitFor();
  assert.equal(await page.locator('.builder-document-catalog-tile').first().locator('.media-document-icon.media-document-document').count(), 1);
  assert.equal(await page.locator('.builder-document-catalog-tile').first().locator('.media-document-name').innerText(), 'Руководство.pdf');
  assert.match(await page.locator('.builder-document-catalog-tile').first().locator('.media-document-meta').innerText(), /PDF/);
  assert.equal(await page.locator('.builder-document-catalog-tile').first().evaluate(node => {
    const icon = node.querySelector('.media-document-icon').getBoundingClientRect(), name = node.querySelector('.media-document-name').getBoundingClientRect();
    return icon.right < name.left && Math.abs(icon.top - name.top) < icon.height;
  }), true, 'desktop catalog card has step 2 document layout');
  assert.ok(await page.locator('.builder-document-catalog-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length) >= 3, 'desktop catalog has room for at least three compact cards per row');
  await page.keyboard.press('Escape'); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
  assert.equal(await docRow.getByLabel('Заголовок').inputValue(), '');
  const catalogFailure = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Временная ошибка каталога"}' });
  await page.route('**/api/page-builder/*/document-catalog?*', catalogFailure);
  await docRow.getByRole('button', { name: 'Выбрать документ 1' }).click();
  await page.waitForFunction(() => document.querySelector('.builder-document-catalog .builder-catalog-message')?.textContent.includes('Временная ошибка каталога'));
  assert.equal(await page.locator('.builder-document-catalog .builder-catalog-message').getAttribute('role'), 'alert');
  await page.keyboard.press('Escape'); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
  await page.unroute('**/api/page-builder/*/document-catalog?*', catalogFailure);
  const chooseFailure = route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"Документ изменился"}' });
  await page.route('**/api/page-builder/*/choose-document', chooseFailure);
  await docRow.getByRole('button', { name: 'Выбрать документ 1' }).click(); await page.locator('.builder-document-catalog-tile').first().click();
  await page.waitForFunction(() => document.querySelector('.builder-document-catalog .builder-catalog-message')?.textContent.includes('Документ изменился'));
  assert.equal(await page.locator('.builder-document-catalog .builder-catalog-message').getAttribute('role'), 'alert');
  assert.equal(await page.locator('.builder-document-catalog-tile').first().isEnabled(), true);
  await page.keyboard.press('Escape'); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
  await page.unroute('**/api/page-builder/*/choose-document', chooseFailure);
  let releaseSelection, selectionStarted, selectionFinished;
  const selectionGate = new Promise(resolve => { releaseSelection = resolve; });
  const started = new Promise(resolve => { selectionStarted = resolve; }), finished = new Promise(resolve => { selectionFinished = resolve; });
  const delayedChoice = async route => { selectionStarted(); await selectionGate; try { await route.continue(); } catch {} selectionFinished(); };
  await page.route('**/api/page-builder/*/choose-document', delayedChoice);
  await docRow.getByRole('button', { name: 'Выбрать документ 1' }).click(); await page.locator('.builder-document-catalog-tile').first().click(); await started;
  assert.equal(await page.locator('.builder-document-catalog .btn-close').evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Tab'); assert.equal(await page.locator('.builder-document-catalog .btn-close').evaluate(node => document.activeElement === node), true, 'pending choice traps focus');
  await page.keyboard.press('Escape'); await page.waitForSelector('.builder-document-catalog', { state: 'detached' }); releaseSelection(); await finished;
  await page.unroute('**/api/page-builder/*/choose-document', delayedChoice);
  assert.equal(await docRow.getByLabel('Заголовок').inputValue(), '', 'late choice after cancellation cannot change the draft');
  await docRow.getByRole('button', { name: 'Выбрать документ 1' }).click(); await page.locator('.builder-document-catalog-tile').first().click(); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
  assert.equal(await docRow.getByLabel('Заголовок').inputValue(), 'Руководство.pdf');
  assert.equal(await docRow.getByLabel('Текст ссылки').inputValue(), 'Руководство.pdf');
  assert.equal(await docRow.getByLabel('Формат', { exact: true }).count(), 0);
  assert.equal(await docRow.locator('input[readonly]').count(), 0);
  assert.equal(await docRow.locator('.builder-document-preview .media-document-icon.media-document-document').count(), 1);
  assert.equal(await docRow.locator('.builder-document-preview-name').innerText(), 'Руководство.pdf');
  assert.equal(await docRow.locator('.builder-document-preview').evaluate(button => {
    const outer = button.getBoundingClientRect(), icon = button.querySelector('.media-document-icon'), fill = icon.getBoundingClientRect();
    return Math.abs(outer.left - fill.left) <= 1 && Math.abs(outer.right - fill.right) <= 1 && Math.abs(outer.top - fill.top) <= 1 && Math.abs(outer.bottom - fill.bottom) <= 1 && getComputedStyle(icon).backgroundColor !== 'rgba(0, 0, 0, 0)';
  }), true, 'selected document color fills the entire preview button');
  await docRow.getByRole('button', { name: 'Выбрать документ 1' }).click(); await page.locator('.builder-document-catalog-tile').nth(1).click(); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
  assert.equal(await docRow.getByLabel('Заголовок').inputValue(), 'Второй.pdf', 'auto-filled title follows the newly selected document');
  assert.equal(await docRow.locator('.builder-document-preview').getAttribute('title'), 'Второй.pdf');
  assert.equal(await docRow.getByLabel('Текст ссылки').inputValue(), 'Второй.pdf');
  await docRow.getByLabel('Заголовок').fill('Мой заголовок'); assert.equal(await documentSummary.innerText(), 'Мой заголовок'); await docRow.locator('.builder-item-markdown > summary').click(); await docRow.getByLabel('Текст в Markdown', { exact: true }).fill('Мой текст'); await docRow.getByLabel('Текст ссылки').fill('Моя ссылка');
  await docRow.getByRole('button', { name: 'Выбрать документ 1' }).click(); await page.locator('.builder-document-catalog-tile').first().click(); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
  assert.deepEqual(await docRow.locator('.builder-document-fields input').evaluateAll(nodes => nodes.map(node => node.value)), ['Мой заголовок', 'Моя ссылка'], 'reselection keeps authored link fields');
  assert.equal(await docRow.getByLabel('Текст в Markdown', { exact: true }).inputValue(), 'Мой текст');
  await docRow.getByRole('button', { name: 'Очистить документ 1' }).click();
  assert.equal(await docRow.getByRole('button', { name: 'Выбрать документ 1' }).evaluate(node => document.activeElement === node), true);
  assert.equal(await docRow.locator('.builder-document-preview .builder-media-placeholder').count(), 1);
  assert.equal(await docRow.locator('.builder-document-preview-name').count(), 0);
  assert.equal(await docRow.locator('.builder-clear-media').count(), 0);
  assert.equal(await docRow.locator('.builder-document-fields input').evaluateAll(nodes => nodes.map(node => node.value)).then(values => values.join('|')), 'Мой заголовок|Моя ссылка');
  await docRow.getByRole('button', { name: 'Выбрать документ 1' }).click(); await page.locator('.builder-document-catalog-tile').first().click(); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
  assert.equal(await docRow.locator('.builder-document-preview .media-document-icon').count(), 1, 'document can be selected again after clearing');
  await page.getByRole('button', { name: 'Добавить документ' }).click(); assert.equal(await page.locator('.builder-link-row').count(), 2);
  const documentIds = await page.locator('.builder-link-row').evaluateAll(nodes => nodes.map(node => node.dataset.itemId));
  await page.getByRole('button', { name: 'Перетащить документ 2' }).focus(); await page.keyboard.press('ArrowUp');
  assert.deepEqual(await page.locator('.builder-link-row').evaluateAll(nodes => nodes.map(node => node.dataset.itemId)), documentIds.reverse());
  await page.getByRole('button', { name: 'Удалить документ 1' }).click(); assert.equal(await page.locator('.builder-link-row').count(), 1);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 850 }); await page.getByRole('button', { name: 'Выбрать документ 1' }).click();
    const fits = await page.locator('.builder-document-catalog-panel, .builder-document-catalog .builder-catalog-panel').first().evaluate(node => {
      const rect = node.getBoundingClientRect(); return node.scrollWidth <= node.clientWidth && rect.left >= 0 && rect.right <= innerWidth + 1;
    });
    assert.equal(fits, true, `${width}px: document chooser fits`);
    const tile = page.locator('.builder-document-catalog-tile').first();
    assert.equal(await tile.evaluate(node => {
      const icon = node.querySelector('.media-document-icon').getBoundingClientRect(), name = node.querySelector('.media-document-name').getBoundingClientRect(), outer = node.getBoundingClientRect();
      return icon.right < name.left && name.right <= outer.right && node.scrollWidth <= node.clientWidth;
    }), true, `${width}px: catalog card remains horizontal and readable`);
    const idleBorder = await tile.evaluate(node => getComputedStyle(node).borderColor);
    await tile.hover(); assert.notEqual(await tile.evaluate(node => getComputedStyle(node).borderColor), idleBorder, `${width}px: catalog card has visible hover`);
    await page.locator('.builder-document-catalog .btn-close').focus(); await page.keyboard.press('Tab'); assert.equal(await page.locator('.builder-catalog-add-document').evaluate(node => node === document.activeElement), true); await page.keyboard.press('Tab');
    assert.equal(await tile.evaluate(node => document.activeElement === node && getComputedStyle(node).outlineStyle !== 'none'), true, `${width}px: catalog card has visible keyboard focus`);
    await page.screenshot({ path: path.join(testOutput(), `ui-links-document-catalog-${width}.png`) });
    await page.keyboard.press('Escape'); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#builder-view').selectOption('links'); assert.equal(await page.locator('.builder-link-row').count(), 2); assert.equal(await page.locator('#builder-links-columns').inputValue(), '3');
  await page.locator('#builder-type').selectOption('content'); await page.locator('#builder-type').selectOption('links');
  assert.equal(await page.locator('#builder-view').inputValue(), 'links'); assert.equal(await page.locator('.builder-link-row').count(), 2);
  await page.locator('#builder-view').selectOption('documents'); assert.equal(await page.locator('.builder-link-row').count(), 1); assert.equal(await page.locator('#builder-links-columns').inputValue(), '1');
  await page.locator('.builder-link-row > details > summary').click(); await page.locator('.builder-link-row .builder-item-markdown > summary').click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    assert.equal(await page.locator('.builder-link-row').evaluate(node => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().right <= innerWidth + 1), true, `${width}px: document row fits`);
    assert.equal(await page.locator('#page-builder-modal .modal-body').evaluate(node => node.scrollWidth <= node.clientWidth), true, `${width}px: editor body fits`);
    const card = await page.locator('.builder-link-row').evaluate(node => {
      const rect = element => element.getBoundingClientRect(), preview = rect(node.querySelector('.builder-document-preview')),
        fields = [...node.querySelectorAll('.builder-document-fields input')].map(rect), settings = [...node.querySelectorAll('.builder-document-settings > div')].map(rect);
      return { previewLeft: preview.right <= fields[0].left, fieldsStack: fields[1].top >= fields[0].bottom,
        settingsRow: Math.abs(settings[0].top - settings[1].top) < 1, settingsFit: settings.every(box => box.left >= rect(node).left && box.right <= rect(node).right),
        hintFit: node.querySelector('.builder-image-preview-hint').scrollWidth <= node.querySelector('.builder-image-preview-hint').clientWidth,
        fieldsReadable: fields.every(box => box.width >= 100), textFull: rect(node.querySelector('textarea')).width >= 150,
        labelsFit: [...node.querySelectorAll('.builder-document-settings label')].every(label => label.scrollWidth <= label.clientWidth) };
    });
    assert.deepEqual(card, { previewLeft: true, fieldsStack: true, settingsRow: true, settingsFit: true, hintFit: true, fieldsReadable: true, textFull: true, labelsFit: true }, `${width}px: document card geometry`);
    const targetFits = await page.locator('.builder-document-settings select').evaluate(select => {
      const style = getComputedStyle(select), context = document.createElement('canvas').getContext('2d'); context.font = style.font;
      const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return [...select.options].every(option => context.measureText(option.textContent).width <= available);
    });
    assert.equal(targetFits, true, `${width}px: both opening options fit the visible select`);
    await page.locator('.builder-document-settings select').selectOption('blank');
    assert.equal(await page.locator('.builder-link-row .builder-document-preview').evaluate(button => {
      const outer = button.getBoundingClientRect(), icon = button.querySelector('.media-document-icon'), fill = icon.getBoundingClientRect(), name = icon.querySelector('.builder-document-preview-name');
      return Math.abs(outer.left - fill.left) <= 1 && Math.abs(outer.right - fill.right) <= 1 && Math.abs(outer.top - fill.top) <= 1 && Math.abs(outer.bottom - fill.bottom) <= 1 && getComputedStyle(icon).backgroundColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(name).color === getComputedStyle(icon).color && name.getBoundingClientRect().bottom <= outer.bottom && name.title === 'Руководство.pdf';
    }), true, `${width}px: selected preview has a full color fill`);
    assert.equal(await page.locator('.builder-document-catalog-grid').count(), 0);
    await page.locator('.builder-link-row').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(testOutput(), `ui-links-document-editor-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await page.locator('.builder-document-settings select').evaluate(select => {
    const style = getComputedStyle(select), context = document.createElement('canvas').getContext('2d'); context.font = style.font;
    return [...select.options].every(option => context.measureText(option.textContent).width <= select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  }), true, 'desktop opening options fit the visible select');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close(); assert.deepEqual(queue.pageBuilder.read(job.id), original, 'cancel discards both view drafts');
  await page.setViewportSize({ width: 1440, height: 1000 }); await opener.click(); await page.getByRole('button', { name: 'Добавить ссылку' }).click();
  await page.locator('.builder-link-row').first().getByLabel('URL').fill('https://example.org/saved'); await page.locator('.builder-link-row').first().getByLabel('Текст ссылки').fill('Сохранено');
  await page.locator('#page-builder-save').click(); await close();
  let stored = queue.pageBuilder.read(job.id); assert.equal(stored.document.common.blocks[1].items.length, 1); assert.equal(stored.document.common.blocks[1].items[0].link_text, 'Сохранено');
  await opener.click(); assert.equal(await page.locator('.builder-link-row').count(), 1);
  await page.locator('.builder-link-row').first().getByLabel('URL').fill('wrong address');
  const beforeBadLink = queue.pageBuilder.read(job.id).revision; await page.locator('#page-builder-save').click();
  assert.match(await page.locator('#page-builder-form-error').innerText(), /ссылка 1, поле «URL».*http:\/\/.*https:\/\//);
  assert.doesNotMatch(await page.locator('#page-builder-form-error').innerText(), /common\.blocks|items\[/);
  assert.equal(queue.pageBuilder.read(job.id).revision, beforeBadLink);
  await page.locator('.builder-link-row').first().getByLabel('URL').fill(`/${'a'.repeat(4096)}`);
  await page.locator('#page-builder-save').click();
  assert.match(await page.locator('#page-builder-form-error').innerText(), /ссылка 1, поле «URL» слишком длинное.*4096 символов/);
  assert.doesNotMatch(await page.locator('#page-builder-form-error').innerText(), /common\.blocks|items\[/);
  assert.equal(queue.pageBuilder.read(job.id).revision, beforeBadLink);
  await page.locator('.builder-link-row').first().getByLabel('URL').fill('https://example.org/saved');
  await page.locator('#builder-view').selectOption('documents'); await page.getByRole('button', { name: 'Добавить документ' }).click(); await page.locator('.builder-link-row').first().locator(':scope > .builder-item-details > summary').click();
  await page.getByRole('button', { name: 'Выбрать документ 1' }).click(); await page.locator('.builder-document-catalog-tile').first().click(); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
  await page.locator('#page-builder-save').click(); await close();
  stored = queue.pageBuilder.read(job.id); const selected = stored.document.common.blocks[1].items[0];
  assert.equal(stored.document.common.blocks[1].view, 'documents'); assert.equal(selected.link, 'https://example.org/manual.pdf'); assert.equal(selected.sourceDocument.resourceId, 1); assert.equal(selected.meta.file_type, 'PDF'); assert.equal(selected.meta.download, true); assert.equal(selected.meta.file_id, undefined);
  await opener.click(); assert.equal(await page.locator('.builder-link-row').count(), 1); assert.equal(await page.locator('.builder-link-row input[readonly]').count(), 0); assert.equal(await page.locator('.builder-link-row .media-document-icon').count(), 1);
  await page.waitForFunction(() => document.querySelector('.builder-link-row .builder-document-preview-name')?.textContent === 'Руководство.pdf');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close();
  for (const legacyTarget of ['_blank', '_self']) {
    const current = queue.pageBuilder.read(job.id), changed = structuredClone(current.document);
    changed.common.blocks[1].items[0].meta.target = legacyTarget;
    queue.pageBuilder.write(job.id, current.revision, changed, 1); queue.save();
    await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
    await opener.click(); await page.waitForSelector('#page-builder-modal.show');
    assert.deepEqual(await page.locator('.builder-link-row select[id$="-target"] option').evaluateAll(nodes => nodes.map(node => [node.value, node.textContent])), [['self', 'В этом окне'], ['blank', 'В новом окне']], 'target selector has exactly two distinct choices');
    assert.equal(await page.locator('.builder-link-row select[id$="-target"]').inputValue(), legacyTarget.slice(1), `legacy ${legacyTarget} displays the matching choice`);
    assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[1].items[0].meta.target, legacyTarget, 'opening the selector does not rewrite stored data');
    await page.locator('.builder-link-row > details > summary').click();
    await page.locator('.builder-link-row').getByLabel('Заголовок').fill(`Проверка ${legacyTarget}`);
    await page.locator('#page-builder-save').click(); await close();
    assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[1].items[0].meta.target, legacyTarget, 'unrelated save preserves the legacy target');
  }
  await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  await page.locator('.builder-link-row > details > summary').click();
  await page.locator('.builder-link-row').getByRole('button', { name: 'Очистить документ 1' }).click();
  await page.locator('#page-builder-save').click(); await close();
  const cleared = queue.pageBuilder.read(job.id).document.common.blocks[1].items[0];
  assert.equal(cleared.link, ''); assert.equal(cleared.sourceDocument, undefined); assert.equal(cleared.meta.file_type, undefined); assert.equal(cleared.meta.size, undefined);
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('.builder-link-row .builder-media-placeholder').count(), 1);
  assert.equal(await page.locator('.builder-link-row .builder-clear-media').count(), 0);
  await page.locator('.builder-link-row > details > summary').click();
  await page.getByRole('button', { name: 'Выбрать документ 1' }).click(); await page.locator('.builder-document-catalog-tile').nth(1).click(); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
  await page.locator('#page-builder-save').click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[1].items[0].sourceDocument.resourceId, 2, 'a cleared saved document can be selected again');
  for (const [catalogIndex, fileType, category] of [[2, 'SVG', 'graphic'], [3, 'MP3', 'audio'], [4, 'MP4', 'video'], [5, 'ZIP', 'archive']]) {
    await opener.click(); await page.waitForSelector('#page-builder-modal.show');
    await page.locator('.builder-link-row > details > summary').click();
    const row = page.locator('.builder-link-row').first();
    await row.getByLabel('Заголовок').fill('Свой заголовок'); await row.getByLabel('Текст ссылки').fill('Своя ссылка');
    await row.getByRole('button', { name: 'Выбрать документ 1' }).click();
    const tile = page.locator('.builder-document-catalog-tile').nth(catalogIndex);
    assert.equal(await tile.locator(`.media-document-${category}`).count(), 1, `${fileType}: catalog uses file kind`);
    await tile.click(); await page.waitForSelector('.builder-document-catalog', { state: 'detached' });
    assert.equal(await row.locator(`.builder-document-preview .media-document-${category}`).count(), 1, `${fileType}: selected preview matches catalog`);
    assert.equal(await row.getByLabel('Текст ссылки').inputValue(), 'Своя ссылка');
    await page.locator('#page-builder-save').click(); await close();
    const current = queue.pageBuilder.read(job.id).document.common.blocks[1].items[0];
    assert.equal(current.meta.file_type, fileType); assert.equal(current.link_text, 'Своя ссылка');
    await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
    await opener.click(); await page.waitForSelector('#page-builder-modal.show');
    assert.equal(await page.locator(`.builder-link-row .builder-document-preview .media-document-${category}`).count(), 1, `${fileType}: saved preview keeps file kind`);
    await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close();
  }
  const beforeFallback = queue.pageBuilder.read(job.id), withoutType = structuredClone(beforeFallback.document);
  delete withoutType.common.blocks[1].items[0].meta.file_type;
  queue.pageBuilder.write(job.id, beforeFallback.revision, withoutType, 1); queue.save();
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('.builder-link-row .builder-document-preview .media-document-archive').count(), 1, 'URL extension supplies legacy file kind when meta.file_type is absent');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close();
  const beforeTab = queue.pageBuilder.read(job.id), withTabLink = structuredClone(beforeTab.document);
  const tabLinks = structuredClone(withTabLink.common.blocks[1]); tabLinks.id = 'news-links'; tabLinks.title = 'Ссылка во вкладке'; tabLinks.view = 'links'; tabLinks.media = [];
  tabLinks.items = [{ id: 'news-link-1', title: '', text: '', link: '/news', link_text: 'Новости', meta: { kind: 'link' } }];
  withTabLink.tabs[0].blocks.push(tabLinks); queue.pageBuilder.write(job.id, beforeTab.revision, withTabLink, 1); queue.save();
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator('[data-tab-id="news"]').click(); await page.locator('[data-builder-id="news-links"]').click(); await page.waitForSelector('#page-builder-modal.show');
  const tabRevision = queue.pageBuilder.read(job.id).revision;
  await page.locator('.builder-link-row').first().getByLabel('URL').fill('bad address'); await page.locator('#page-builder-save').click();
  assert.match(await page.locator('#page-builder-form-error').innerText(), /ссылка 1, поле «URL».*http:\/\//);
  assert.doesNotMatch(await page.locator('#page-builder-form-error').innerText(), /tabs\[|blocks\[|items\[/);
  await page.locator('.builder-link-row').first().getByLabel('URL').fill(`/${'a'.repeat(4096)}`); await page.locator('#page-builder-save').click();
  assert.match(await page.locator('#page-builder-form-error').innerText(), /ссылка 1, поле «URL» слишком длинное.*4096 символов/);
  assert.doesNotMatch(await page.locator('#page-builder-form-error').innerText(), /tabs\[|blocks\[|items\[/);
  assert.equal(queue.pageBuilder.read(job.id).revision, tabRevision);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close();
  assert.deepEqual(errors, []);
});

test('step 3 canonical editor offers dependent views, browser media selection and safe review with reload', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-editor-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0];
  seedMoriPage(queue, job);
  const openedFolders = [];
  const previewBytes = installLocalPreview(queue, job, queue.pageBuilder.read(job.id).document.common.blocks[0].media[0]);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), external = [], errors = [], origin = `http://127.0.0.1:${server.address().port}`;
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.evaluate(() => {
    const host = document.createElement('div'), card = document.createElement('div'), button = document.createElement('button'), image = document.createElement('img');
    host.id = 'step-two-style-probe'; host.style.cssText = 'position:fixed;z-index:9999;top:10px;left:10px;width:150px;height:214px'; card.className = 'card image-card h-100';
    button.className = 'btn w-100'; image.className = 'gallery-thumb w-100'; image.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
    button.append(image); card.append(button); host.append(card); document.body.append(host);
  });
  const buttonStyle = locator => locator.evaluate(button => {
    const style = getComputedStyle(button), box = button.getBoundingClientRect();
    return { border: style.border, outline: style.outline, boxShadow: style.boxShadow, background: style.backgroundColor, rect: [box.x, box.y, box.width, box.height] };
  });
  const stepTwoButton = page.locator('#step-two-style-probe button');
  const stepTwoIdle = await buttonStyle(stepTwoButton);
  await stepTwoButton.hover(); await page.waitForTimeout(200); const stepTwoHover = await buttonStyle(stepTwoButton);
  await stepTwoButton.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(200); const stepTwoFocus = await buttonStyle(stepTwoButton);
  assert.notEqual(stepTwoHover.border, stepTwoIdle.border, 'step 2 highlights the button border on hover');
  assert.notEqual(stepTwoFocus.boxShadow, stepTwoIdle.boxShadow, 'step 2 highlights the button with a focus shadow');
  await page.locator('#step-two-style-probe').evaluate(node => node.remove());
  const opener = page.locator('[data-builder-id="common-hero"]'), modal = page.locator('#page-builder-modal');
  const close = async () => { await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); };
  const initial = queue.pageBuilder.read(job.id);
  await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.getByRole('button', { name: 'Выбрать основную картинку' }).isDisabled(), false);
  assert.equal(await page.locator('.builder-media-status').count(), 0, 'there is no media preparation stage');
  const preview = await page.locator('.builder-image-row img').first().evaluate(async image => { const response = await fetch(image.src); return { type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength }; });
  assert.deepEqual(preview, { type: 'image/png', bytes: previewBytes.length }, 'saved media uses the verified local stage-2 image instead of the SVG placeholder');
  const savedAsset = initial.document.common.blocks[0].media[0], savedRow = page.locator('.builder-image-row').first();
  assert.equal(await savedRow.locator('input').count(), 2, 'image link and alt remain beside the previews');
  assert.equal(await page.locator('.builder-banner-advanced').evaluate(node => node.open), false);
  assert.deepEqual(await page.locator('#page-builder-fields > *').evaluateAll(nodes => nodes.slice(0, 3).map(node => node.className)), ['builder-type-view', 'mb-3', 'builder-content-fields']);
  assert.deepEqual(await page.locator('.builder-content-fields > *').evaluateAll(nodes => nodes.map(node => node.className)), ['builder-images-section builder-banner-image', 'builder-text-fields', 'builder-link-fields', 'builder-banner-advanced']);
  assert.equal(await page.locator('.builder-image-row').count(), 1);
  assert.equal(await page.locator('#builder-add-image, .builder-media-drag, .builder-image-tools').count(), 0);
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await modal.locator('.modal-body').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'banner editor fits 320px');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('.builder-banner-advanced summary').click();
  assert.equal(await page.locator('.builder-banner-advanced').evaluate(node => node.open), true);
  assert.equal(await page.locator('.builder-banner-advanced summary').innerText(), 'Дополнительные настройки');
  assert.equal(await page.locator('#builder-meta-media_mode').inputValue(), 'fill', 'hero uses the documented fill default');
  assert.equal(await savedRow.locator('input[readonly], input:disabled, input[type="file"]').count(), 0);
  assert.equal(await savedRow.locator('figcaption').count(), 0); assert.equal(await savedRow.locator('label').count(), 0);
  assert.equal(await savedRow.locator('.builder-media-placeholder').count(), 1, 'empty large preview remains visible');
  assert.equal(await savedRow.locator('.builder-image-preview-button').count(), 2);
  assert.equal(await savedRow.locator('.builder-image-preview-hint').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).opacity === '0')), true, 'preview hints are hidden at rest');
  assert.equal(await savedRow.locator('.builder-image-preview-hint svg').count(), 0, 'image picker hover contains text only');
  await savedRow.getByRole('button', { name: 'Выбрать основную картинку' }).hover();
  assert.equal(await savedRow.getByRole('button', { name: 'Выбрать основную картинку' }).locator('.builder-image-preview-hint').evaluate(node => getComputedStyle(node).opacity), '1', 'hover reveals the text-only hint');
  assert.equal(await savedRow.getByRole('button', { name: 'Выбрать основную картинку' }).locator('.builder-image-preview-hint-text').innerText(), 'Выбрать основную\nкартинку');
  await page.mouse.move(0, 0);
  await savedRow.getByRole('button', { name: 'Выбрать основную картинку' }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await savedRow.getByRole('button', { name: 'Сбросить основную картинку' }).evaluate(node => node === document.activeElement), true, 'clear action follows its picker in keyboard order');
  await page.keyboard.press('Tab');
  assert.equal(await savedRow.getByRole('button', { name: 'Выбрать большую картинку' }).locator('.builder-image-preview-hint').evaluate(node => getComputedStyle(node).opacity), '1', 'keyboard focus reveals the distinct picker hint');
  assert.equal(await page.locator('#builder-title').getAttribute('placeholder'), 'Заголовок');
  for (const label of ['Ссылка изображения', 'Альтернативный текст', 'Подпись']) assert.equal(await page.getByLabel(label, { exact: true }).getAttribute('placeholder'), label);
  assert.equal(await page.locator('.builder-link-fields #builder-link_text').count(), 1);
  assert.deepEqual(await page.locator('.builder-banner-advanced select').evaluateAll(nodes => nodes.map(node => node.id)), ['builder-meta-ratio', 'builder-meta-fit', 'builder-meta-media_mode', 'builder-meta-media_align']);
  assert.equal(await page.locator('.builder-banner-advanced #builder-meta-media_width').count(), 1);
  const imageName = filename(queue.stage.media.read(job, job.attempts[0]).resources[0]);
  const selectImage = async (row, kind) => {
    await row.getByRole('button', { name: `Выбрать ${kind} картинку`, exact: true }).click();
    await page.waitForSelector('.builder-catalog-layer');
    assert.equal(await page.locator('#builder-catalog-title').innerText(), `Выбор ${kind === 'основную' ? 'основной' : 'большой'} картинки`);
    assert.equal(await page.locator('.builder-catalog-layer img').first().getAttribute('src').then(src => src.startsWith(`/api/page-builder/${job.id}/catalog/`)), true);
    await page.getByRole('button', { name: 'Выбрать изображение 1', exact: true }).click();
    await page.waitForSelector('.builder-catalog-layer', { state: 'detached' });
  };
  await savedRow.getByRole('button', { name: 'Выбрать основную картинку' }).click();
  await page.waitForSelector('.builder-catalog-layer');
  assert.equal(await page.locator('.builder-catalog-layer').getAttribute('role'), 'dialog');
  assert.equal(await page.locator('.builder-catalog-layer').getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('.builder-catalog-layer button:focus').count(), 1);
  assert.equal(await page.locator('#builder-catalog-title').innerText(), 'Выбор основной картинки');
  assert.equal(await page.locator('.builder-catalog-header .btn-close').getAttribute('aria-label'), 'Закрыть');
  assert.equal(await page.locator('.builder-catalog-header .btn-close').evaluate(node => getComputedStyle(node).backgroundImage === getComputedStyle(document.querySelector('#png-modal .btn-close')).backgroundImage), true, 'the catalog uses the same close icon as the image modal');
  assert.equal(await page.locator('.builder-catalog-message').isHidden(), true, 'the catalog does not display an image count');
  assert.ok((await page.locator('.builder-catalog-tile').allTextContents()).every(text => text === ''), 'image tiles show no filenames while the catalog retains its add button');
  assert.equal(await page.locator('.builder-catalog-tile[title]').count(), 0, 'image buttons have no filename tooltip');
  assert.equal(await page.getByRole('button', { name: 'Выбрать изображение 1', exact: true }).count(), 1, 'the image keeps a numbered accessible name');
  const catalogButton = page.locator('.builder-catalog-tile').first();
  assert.deepEqual((await buttonStyle(catalogButton)).border, stepTwoIdle.border, 'catalog and step 2 have the same idle button border');
  await catalogButton.hover(); await page.waitForTimeout(200);
  assert.deepEqual((await buttonStyle(catalogButton)).border, stepTwoHover.border, 'catalog and step 2 have the same hover border');
  await catalogButton.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(200);
  assert.deepEqual((await buttonStyle(catalogButton)).boxShadow, stepTwoFocus.boxShadow, 'catalog and step 2 have the same keyboard focus shadow');
  await page.locator('.builder-catalog-grid').evaluate(grid => {
    const first = grid.querySelector('.builder-catalog-card');
    for (let index = 0; index < 37; index++) {
      const card = first.cloneNode(true), tile = card.querySelector('button'), image = tile.querySelector('img');
      tile.setAttribute('aria-label', `Выбрать изображение ${index + 2}`);
      image.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${index % 2 ? 240 : 40}" height="${index % 2 ? 40 : 240}"><rect width="100%" height="100%" fill="orange"/></svg>`)}`;
      grid.append(card);
    }
  });
  await page.locator('.builder-catalog-grid img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  assert.equal(await page.locator('.builder-catalog-tile').count(), 38);
  for (const width of [957, 390, 320]) {
    await page.setViewportSize({ width, height: width === 957 ? 766 : 844 });
    const geometry = await page.locator('.builder-catalog-layer').evaluate(layer => {
      const panel = layer.querySelector('.builder-catalog-panel'), grid = layer.querySelector('.builder-catalog-grid');
      grid.scrollTop = 0;
      const tiles = [...grid.querySelectorAll('.builder-catalog-tile')];
      const boxes = tiles.map(tile => ({ tile: tile.getBoundingClientRect(), image: tile.querySelector('img').getBoundingClientRect() }));
      const insideTile = (tile, child) => child.left >= tile.left && child.top >= tile.top && child.right <= tile.right && child.bottom <= tile.bottom;
      const inside = boxes.every(({ tile, image }) => insideTile(tile, image));
      const separated = boxes.every(({ tile }, index) => boxes.every(({ tile: other }, otherIndex) => index === otherIndex || tile.right <= other.left || other.right <= tile.left || tile.bottom <= other.top || other.bottom <= tile.top));
      const firstTop = Math.min(...boxes.map(({ tile }) => tile.top));
      const firstRowRight = Math.max(...boxes.filter(({ tile }) => Math.abs(tile.top - firstTop) <= 1).map(({ tile }) => tile.right));
      const focusIndex = boxes.findIndex(({ tile }) => Math.abs(tile.top - firstTop) <= 1 && Math.abs(tile.right - firstRowRight) <= 1);
      const gridBox = grid.getBoundingClientRect(), focusInset = { top: firstTop - gridBox.top, right: gridBox.left + grid.clientWidth - firstRowRight };
      const scrollable = grid.scrollHeight > grid.clientHeight;
      grid.scrollTop = grid.scrollHeight;
      return { inside, outside: boxes.flatMap(({ tile, image }, index) => insideTile(tile, image) ? [] : [{ index, tile: [tile.left, tile.top, tile.right, tile.bottom], image: [image.left, image.top, image.right, image.bottom] }]).slice(0, 2), separated, focusInset, focusIndex, scrollable, reachedBottom: Math.abs(grid.scrollTop - (grid.scrollHeight - grid.clientHeight)) <= 1, gridWidth: [grid.clientWidth, grid.scrollWidth], panelWidth: [panel.clientWidth, panel.scrollWidth] };
    });
    assert.equal(geometry.inside && geometry.separated && geometry.focusInset.top >= 4 && geometry.focusInset.right >= 4 && geometry.gridWidth[1] <= geometry.gridWidth[0] && geometry.panelWidth[1] <= geometry.panelWidth[0] && geometry.scrollable && geometry.reachedBottom, true, `${width}px catalog geometry: ${JSON.stringify(geometry)}`);
    const edgeTile = page.locator('.builder-catalog-tile').nth(geometry.focusIndex);
    await edgeTile.hover(); await page.waitForTimeout(200);
    assert.equal((await buttonStyle(edgeTile)).border, stepTwoHover.border, `${width}px hover matches step 2`);
    await page.locator('.builder-catalog-header .btn-close').focus();
    await page.keyboard.press('Tab'); assert.equal(await page.locator('.builder-catalog-add-image').evaluate(node => node === document.activeElement), true, 'the add-image button precedes image tiles in keyboard order');
    for (let index = 0; index <= geometry.focusIndex; index++) await page.keyboard.press('Tab');
    assert.equal(await edgeTile.evaluate(node => node === document.activeElement && node.matches(':focus-visible')), true, `${width}px first-row edge tile has keyboard focus`);
    await page.waitForTimeout(200);
    assert.equal((await buttonStyle(edgeTile)).boxShadow, stepTwoFocus.boxShadow, `${width}px focus matches step 2`);
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.keyboard.press('Escape'); await page.waitForSelector('.builder-catalog-layer', { state: 'detached' });
  assert.equal(await savedRow.locator('.builder-image-preview-button img').count(), 1, 'closing catalog leaves the draft unchanged');
  await savedRow.getByRole('button', { name: 'Выбрать основную картинку' }).click(); await page.waitForSelector('.builder-catalog-layer');
  await page.locator('.builder-catalog-header .btn-close').click(); await page.waitForSelector('.builder-catalog-layer', { state: 'detached' });
  assert.equal(await savedRow.getByRole('button', { name: 'Выбрать основную картинку' }).evaluate(node => node === document.activeElement), true, 'the close icon returns focus to the picker');
  await page.locator('#builder-link_text').fill('Черновик ссылки');
  await page.locator('#builder-meta-ratio').selectOption('poster');
  await selectImage(savedRow, 'большую'); assert.equal(await savedRow.locator('img').count(), 2);
  assert.equal(await page.locator('#builder-link_text').inputValue(), 'Черновик ссылки', 'image selection preserves advanced settings');
  assert.equal(await page.locator('#builder-meta-ratio').inputValue(), 'poster', 'image selection preserves new banner settings');
  assert.deepEqual(queue.pageBuilder.read(job.id), initial, 'browser selection changes only the draft');
  assert.equal(await page.locator('.builder-image-row').first().getByText(/Изображение 1/).count(), 0, 'image number is not visibly rendered');
  assert.equal(await page.locator('.builder-image-row').first().getByRole('button', { name: /Выше|Ниже/ }).count(), 0, 'separate arrow buttons are removed');
  assert.equal(await page.locator('.builder-image-row').first().locator('.builder-image-tools').count(), 0);
  assert.equal(await page.locator('#builder-add-image').count(), 0);
  await page.locator('#builder-type').selectOption('content');
  assert.equal(await page.locator('.builder-image-row').count(), 2); assert.equal(await page.locator('#builder-add-image, .builder-image-tools .builder-delete').count(), 0);
  assert.equal(await page.locator('.builder-images-section').evaluate(node => parseFloat(getComputedStyle(node).marginBottom) > 0), true, 'image section keeps vertical separation before review status');
  const emptyRow = page.locator('.builder-image-row').last();
  assert.equal(await emptyRow.locator('.builder-media-placeholder').count(), 2);
  assert.equal(await emptyRow.locator('.builder-image-preview-button').count(), 2);
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
  assert.doesNotMatch(await page.locator('#page-builder-fields').innerText(), /Mori|Принудительный|Описание карточки|JSON/i);
  assert.deepEqual(await page.locator('#builder-type option').evaluateAll(nodes => nodes.map(node => node.value)), initial.blockTypes.map(type => type.name));
  await page.locator('#builder-type').selectOption('content');
  let serviceDraftMediaIds;
  for (const type of initial.blockTypes) {
    await page.locator('#builder-type').selectOption(type.name);
    assert.deepEqual(await page.locator('#builder-view option').evaluateAll(nodes => nodes.map(node => node.value)), type.views);
    assert.equal(await page.locator('#builder-view').inputValue(), type.default_view);
    assert.equal(await page.locator('#builder-review-status').inputValue(), 'unreviewed');
    for (const name of new Set(initial.blockTypes.flatMap(item => item.fields.map(field => field.name)))) assert.equal(await page.locator(`#builder-${name}`).count(), Number(type.fields.some(field => field.name === name) && !(type.name === 'embed' && name === 'source_url')), `${type.name}: only applicable editable scalar ${name}`);
    const structured = type.name === 'data-table';
    assert.equal(await page.locator('.builder-editor-placeholder').count(), 0, `${type.name}: editor is available`);
    assert.equal(await page.locator('#builder-add-image').count(), 0, `${type.name}: fixed media types do not show an add-image control`);
    if (type.name === 'big-media') assert.equal(await page.locator('#builder-meta-media_mode').inputValue(), 'intrinsic', 'ordinary banner uses the documented intrinsic default');
    if (type.name === 'grid') assert.equal(await page.locator('#builder-add-gallery-item').count(), 1, 'every grid view has the item editor');
    if (type.name === 'table') assert.equal(await page.locator('#builder-add-table-row').count(), 1, 'table has the row editor');
    if (type.name === 'service') serviceDraftMediaIds = await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId));
    if (structured) {
      assert.equal(await page.locator('#builder-add-data-column').count(), 1);
      assert.deepEqual(await page.locator('.builder-text-fields legend').allInnerTexts(), ['Текст']);
      assert.equal(await page.getByLabel('Текст в Markdown', { exact: true }).count(), 1);
    }
  }
  await page.locator('#builder-type').selectOption('service'); await page.locator('#builder-view').selectOption('media-right'); await page.locator('#builder-badge').fill('Новинка');
  await page.locator('#builder-link').fill('https://example.org/service'); await page.locator('#builder-link_text').fill('Подробнее'); await page.locator('#builder-title').fill('Новая услуга');
  assert.deepEqual(await page.locator('.builder-content-fields > *').evaluateAll(nodes => nodes.map(node => node.className)), ['builder-text-fields', 'builder-images-section', 'mb-3', 'builder-link-fields', 'builder-banner-advanced']);
  assert.equal(await page.locator('.builder-image-row').count(), 2); assert.equal(await page.locator('#builder-add-image, .builder-image-tools .builder-delete').count(), 0);
  assert.equal(await page.locator('.builder-media-drag').count(), 2, 'both service slots retain reorder handles');
  assert.equal(await page.locator('.builder-link-fields #builder-link_text').count(), 1);
  await page.locator('.builder-banner-advanced summary').click();
  await page.locator('#builder-meta-image_ratio').selectOption('3x2'); await page.locator('#builder-meta-image_fit').selectOption('cover');
  await page.locator('#builder-meta-action_style').selectOption('primary'); await page.locator('#builder-meta-media_mode').selectOption('fill');
  await page.locator('#builder-meta-media_align').selectOption('center'); await page.locator('#builder-meta-media_width').fill('640');
  for (const [index, name] of ['first', 'second'].entries()) {
    const row = page.locator('.builder-image-row').nth(index);
    await selectImage(row, 'основную'); await selectImage(row, 'большую');
    await row.getByLabel('Ссылка изображения', { exact: true }).fill(`/${name}`); await row.getByLabel('Альтернативный текст', { exact: true }).fill(name); await row.getByLabel('Подпись', { exact: true }).fill(`Caption ${name}`);
  }
  const mediaIds = await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)); assert.deepEqual(mediaIds, serviceDraftMediaIds, 'service restores its own media slots after the type tour'); assert.notEqual(mediaIds[0], savedAsset.id, 'table-to-service starts a separate media pool'); assert.match(mediaIds[1], /^media-[a-f0-9-]{36}$/);
  assert.equal(await page.locator('.builder-image-row img').count(), 4, 'both browser selections preview immediately before save');
  await page.locator(`.builder-image-row[data-media-id="${mediaIds[1]}"] .builder-media-drag`).focus(); await page.keyboard.press('ArrowUp');
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), [...mediaIds].reverse());
  await page.locator(`.builder-image-row[data-media-id="${mediaIds[0]}"] .builder-media-drag`).dragTo(page.locator(`.builder-image-row[data-media-id="${mediaIds[1]}"]`), { targetPosition: { x: 25, y: 5 } });
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), mediaIds, 'native image DnD restores first/second order');
  await page.locator('#builder-review-status').selectOption('passed');
  const caption = page.locator('.builder-image-row').first().getByLabel('Подпись', { exact: true });
  const shortHeight = await caption.evaluate(node => node.getBoundingClientRect().height);
  await caption.fill('Первая строка\nВторая строка\nТретья строка');
  const tallHeight = await caption.evaluate(node => node.getBoundingClientRect().height);
  assert.ok(tallHeight > shortHeight, 'caption grows as multiline text is entered');
  await caption.fill('Изменена подпись');
  assert.ok(await caption.evaluate(node => node.getBoundingClientRect().height) < tallHeight, 'caption shrinks after removing lines');
  assert.equal(await page.locator('#builder-review-status').inputValue(), 'unreviewed');
  for (const width of [1440, 600, 390, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 1000 }); assert.equal(await modal.evaluate(node => { const box = node.querySelector('.modal-dialog').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && node.querySelector('.modal-body').scrollWidth <= node.querySelector('.modal-body').clientWidth; }), true, `${width}: canonical/media editor fits the modal`);
    const media = await page.locator('.builder-image-row').first().evaluate(node => {
      const box = element => element.getBoundingClientRect(), previews = [...node.querySelectorAll('.builder-image-preview-button')].map(box), fields = [...node.querySelectorAll('.builder-media-fields input')].map(box), caption = box(node.querySelector('.builder-media-caption')), body = box(node.querySelector('.builder-media-form'));
      const hintFits = [...node.querySelectorAll('.builder-image-preview-hint')].every(hint => {
        const lines = [...hint.querySelectorAll('.builder-image-preview-hint-text span')];
        return !hint.querySelector('svg') && lines.length === 2 && lines[0].textContent.startsWith('Выбрать ') && lines[1].textContent === 'картинку' && lines[1].getBoundingClientRect().top >= lines[0].getBoundingClientRect().bottom && hint.scrollWidth <= hint.clientWidth && hint.scrollHeight <= hint.clientHeight;
      });
      return { previewSideBySide: previews[0].right <= previews[1].left && Math.abs(previews[0].top - previews[1].top) < 1, previewHeightMatchesFields: previews.every(rect => Math.abs(rect.height - (fields[1].bottom - fields[0].top)) < 1), hintFits, fieldsPositioned: innerWidth > 575 ? Math.abs(previews[0].top - fields[0].top) < 1 : fields[0].top >= previews[0].bottom, captionBelow: caption.top >= Math.max(previews[0].bottom, fields[1].bottom), fits: [previews[0], previews[1], ...fields, caption].every(rect => rect.left >= body.left - 1 && rect.right <= body.right + 1) };
    });
    assert.deepEqual(media, { previewSideBySide: true, previewHeightMatchesFields: true, hintFits: true, fieldsPositioned: true, captionBelow: true, fits: true }, `${width}: media card geometry`);
    await page.waitForFunction(() => { const node = document.querySelector('.builder-image-row .builder-media-caption'); return node && node.scrollHeight <= node.clientHeight + 1; }, null, { timeout: 3000 });
    const selectors = await page.locator('.builder-type-view').evaluate(node => { const [type, view] = [...node.querySelectorAll('select')].map(item => item.getBoundingClientRect()); return { sameRow: Math.abs(type.top - view.top) < 1, fits: view.right <= node.getBoundingClientRect().right + 1, separate: type.right <= view.left, labelsFit: [...node.querySelectorAll('label')].every(label => label.scrollWidth <= label.clientWidth) }; });
    assert.equal(selectors.sameRow, true, `${width}: type/view selectors stay in one row`); assert.equal(selectors.fits, true); assert.equal(selectors.separate, true); assert.equal(selectors.labelsFit, true);
    if ([1440, 320].includes(width)) {
      await page.locator('#builder-type').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(testOutput(), `ui-stage-three-editor-${width}.png`) });
      await page.locator('.builder-image-row').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(testOutput(), `ui-stage-three-media-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1100 }); await page.locator('#builder-review-status').selectOption('passed'); await page.locator('#page-builder-save').click(); await close();
  const saved = queue.pageBuilder.read(job.id), block = saved.document.common.blocks[0]; assert.equal(saved.revision, 2); assert.equal(block.type, 'service'); assert.equal(block.view, 'media-right'); assert.equal(block.badge, 'Новинка'); assert.equal(block.review.status, 'passed'); assert.deepEqual(block.media.map(item => item.id), mediaIds);
  assert.deepEqual(block.meta, { image_ratio: '3x2', image_fit: 'cover', action_style: 'primary', media_mode: 'fill', media_align: 'center', media_width: 640 });
  assert.equal(block.media[0].bigUrl, savedAsset.originalUrl); assert.equal(block.media[0].bigMedia.sha256, block.media[0].originalMedia.sha256); assert.equal(block.media[0].href, '/first'); assert.equal(block.media[0].caption, 'Изменена подпись');
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)'); await opener.click();
  assert.equal(await page.locator('#builder-type').inputValue(), 'service'); assert.equal(await page.locator('#builder-view').inputValue(), 'media-right'); assert.equal(await page.locator('#builder-badge').inputValue(), 'Новинка');
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), mediaIds);
  await page.locator('.builder-image-row').nth(1).getByRole('button', { name: 'Сбросить большую картинку' }).click(); await page.locator('#page-builder-save').click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].media.length, 2); assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].media[1].bigUrl, ''); assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].review.status, 'unreviewed');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});

test('pending catalog selection keeps close focused and Escape cancels without changing the draft', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-catalog-pending-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  const job = queue.jobs[0]; seedMoriPage(queue, job);
  installLocalPreview(queue, job, queue.pageBuilder.read(job.id).document.common.blocks[0].media[0]);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`;
  const original = queue.pageBuilder.read(job.id);
  let started, release;
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route('**/choose-media', async route => {
    started();
    await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); } catch { /* The catalog closed and aborted the request. */ }
  });
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show');
  const trigger = page.getByRole('button', { name: 'Выбрать большую картинку' });
  await trigger.click(); await page.waitForSelector('.builder-catalog-tile');
  await page.locator('.builder-catalog-tile').first().click(); await requestStarted;
  const focusedClose = () => page.locator('.builder-catalog-layer .builder-catalog-header button').evaluate(node => node === document.activeElement && !node.disabled);
  assert.equal(await focusedClose(), true, 'pending request leaves an enabled close button focused');
  assert.equal(await page.locator('.builder-catalog-tile').first().isDisabled(), true);
  assert.equal(await page.locator('.builder-catalog-message').isHidden(), true, 'selection shows no status text');
  await page.keyboard.press('Tab'); assert.equal(await focusedClose(), true, 'Tab stays in the catalog');
  await page.keyboard.press('Shift+Tab'); assert.equal(await focusedClose(), true, 'reverse Tab stays in the catalog');
  await page.keyboard.press('Escape'); await page.waitForSelector('.builder-catalog-layer', { state: 'detached' });
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true, 'focus returns to the image control');
  assert.equal(await page.locator('#page-builder-save').isEnabled(), true);
  release();
  assert.deepEqual(queue.pageBuilder.read(job.id), original);
  assert.equal(await page.locator('.builder-image-row').first().locator('img').count(), 1, 'the cancelled choice adds no large preview');
});

test('each image preview clears only its own URL, provenance and draft preview', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-clear-variant-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  const job = queue.jobs[0]; seedMoriPage(queue, job);
  const asset = queue.pageBuilder.read(job.id).document.common.blocks[0].media[0]; installLocalPreview(queue, job, asset);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  let pickCount = 0;
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 320, height: 844 } }), errors = [], external = [], origin = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/media-catalog')) pickCount++; });
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const opener = page.locator('[data-builder-id="common-hero"]'), row = page.locator('.builder-image-row').first();
  const close = async () => { await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); };
  await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await row.getByRole('button', { name: 'Сбросить основную картинку' }).count(), 1);
  assert.equal(await row.getByRole('button', { name: 'Сбросить большую картинку' }).count(), 0, 'empty preview has no clear action');
  const chooseBig = row.getByRole('button', { name: 'Выбрать большую картинку' });
  await chooseBig.click(); await page.waitForSelector('.builder-catalog-layer');
  await page.locator('.builder-catalog-tile').first().click(); await page.waitForSelector('.builder-catalog-layer', { state: 'detached' });
  assert.equal(pickCount, 1); assert.equal(await row.locator('img').count(), 2);
  const before = await row.evaluate(node => {
    const slots = [...node.querySelectorAll('.builder-image-preview-slot')];
    return slots.map(slot => ({ picker: slot.querySelector('.builder-image-preview-button')?.tagName, clear: slot.querySelector('.builder-clear-media')?.tagName, nested: Boolean(slot.querySelector('.builder-image-preview-button .builder-clear-media')), fits: slot.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1 }));
  });
  assert.deepEqual(before, [{ picker: 'BUTTON', clear: 'BUTTON', nested: false, fits: true }, { picker: 'BUTTON', clear: 'BUTTON', nested: false, fits: true }]);
  await row.getByRole('button', { name: 'Выбрать большую картинку' }).click(); await page.waitForSelector('.builder-catalog-layer');
  await page.keyboard.press('Escape'); await page.waitForSelector('.builder-catalog-layer', { state: 'detached' });
  assert.equal(await row.locator('img').count(), 2, 'cancelled picker leaves both variants intact');
  await row.getByLabel('Ссылка изображения', { exact: true }).fill('/banner');
  await row.getByLabel('Альтернативный текст', { exact: true }).fill('Сохранённый alt');
  await row.getByLabel('Подпись', { exact: true }).fill('Сохранённая подпись');
  await page.locator('#builder-title').fill('Заголовок после сброса');
  await row.getByRole('button', { name: 'Сбросить основную картинку' }).hover();
  assert.deepEqual(await row.getByRole('button', { name: 'Сбросить основную картинку' }).evaluate(node => {
    const style = getComputedStyle(node); return { cursor: style.cursor, border: style.borderTopWidth, radius: style.borderTopLeftRadius, background: style.backgroundColor };
  }), { cursor: 'pointer', border: '0px', radius: '0px', background: 'rgba(0, 0, 0, 0)' }, 'hovered clear action has no frame or backdrop');
  await row.getByRole('button', { name: 'Сбросить основную картинку' }).focus(); await page.keyboard.press('Enter');
  assert.equal(pickCount, 2, 'keyboard clear never opens the catalog');
  assert.equal(await row.locator('.builder-media-placeholder').count(), 1); assert.equal(await row.locator('img').count(), 1);
  assert.equal(await row.getByRole('button', { name: 'Сбросить основную картинку' }).count(), 0);
  await page.locator('#page-builder-save').click(); await close();
  let saved = queue.pageBuilder.read(job.id).document.common.blocks[0].media[0];
  assert.equal(saved.originalUrl, ''); assert.equal(Object.hasOwn(saved, 'originalMedia'), false);
  assert.ok(saved.bigUrl); assert.ok(saved.bigMedia);
  assert.deepEqual([saved.href, saved.alt, saved.caption], ['/banner', 'Сохранённый alt', 'Сохранённая подпись']);
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].title, 'Заголовок после сброса');
  await opener.click(); await page.waitForSelector('#page-builder-modal.show'); assert.equal(await row.locator('img').count(), 1); assert.equal(await row.getByRole('button', { name: 'Сбросить большую картинку' }).count(), 1);
  await row.getByRole('button', { name: 'Сбросить большую картинку' }).click(); assert.equal(pickCount, 2);
  assert.equal(await row.locator('.builder-media-placeholder').count(), 2); assert.equal(await row.getByRole('button', { name: /Сбросить .* картинку/ }).count(), 0);
  await page.locator('#page-builder-save').click(); await close();
  saved = queue.pageBuilder.read(job.id).document.common.blocks[0].media[0];
  assert.equal(saved.bigUrl, ''); assert.equal(Object.hasOwn(saved, 'bigMedia'), false);
  await opener.click(); await page.waitForSelector('#page-builder-modal.show'); assert.equal(await row.locator('.builder-media-placeholder').count(), 2); assert.equal(pickCount, 2);
  await row.getByRole('button', { name: 'Выбрать большую картинку' }).click(); await page.waitForSelector('.builder-catalog-layer');
  await page.locator('.builder-catalog-tile').first().click(); await page.waitForSelector('.builder-catalog-layer', { state: 'detached' });
  assert.equal(await row.locator('.builder-image-preview-slot').nth(1).locator('img').count(), 1);
  await page.locator('#builder-type').selectOption('service'); await page.locator('#builder-type').selectOption('big-media');
  assert.equal(await row.locator('.builder-image-preview-slot').nth(1).locator('img').count(), 1, 'banner retains its unsaved large preview after type switching');
  await row.getByRole('button', { name: 'Сбросить большую картинку' }).click();
  assert.equal(await row.locator('.builder-image-preview-slot').nth(1).locator('.builder-media-placeholder').count(), 1);
  await page.locator('#builder-type').selectOption('service');
  assert.equal(await row.locator('.builder-image-preview-slot').nth(1).locator('img').count(), 1, 'service restores its own unsaved large preview');
  assert.equal(await row.getByRole('button', { name: 'Сбросить большую картинку' }).count(), 1);
  assert.equal(pickCount, 3, 'switching types and clearing a variant never opens another catalog');
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
});

test('saving a block refreshes only its images and keeps replacement pixels in the reopened editor', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-original-preview-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/');
  const job = queue.jobs[0]; seedMoriPage(queue, job);
  const initial = queue.pageBuilder.read(job.id), asset = initial.document.common.blocks[0].media[0], attempt = job.attempts[0];
  const replacementUrl = new URL('/replacement.png', job.url).href;
  const urls = new Set([replacementUrl, ...[initial.document.common, ...initial.document.tabs].flatMap(section => section.blocks.flatMap(block => block.media.map(asset => asset.originalUrl))).filter(Boolean)]);
  const manifest = queue.stage.media.create(job, attempt, Buffer.from([...urls].map(url => `<img src="${url}">`).join('')), 'test');
  const oldImage = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const newImage = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#0000ff' } }).png().toBuffer();
  const imageDirectory = queue.stage.media.directory(job, attempt);
  for (const url of urls) {
    const bytes = url === replacementUrl ? newImage : oldImage;
    const resource = manifest.resources.find(item => item.originalUrl === url), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.ok(resource, `manifest contains ${url}`);
    fs.writeFileSync(path.join(imageDirectory, 'objects', sha256), bytes);
    Object.assign(resource, { status: 'downloaded', finalUrl: url, redirects: [], mime: 'image/png', bytes: bytes.length, sha256, object: `objects/${sha256}` });
    }
  queue.stage.media.publish(job, attempt, manifest);
  Object.assign(attempt, { status: 'complete', captureStatus: 'complete' }); attempt.htmlMedia.status = 'complete'; queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 2000 } }), origin = `http://127.0.0.1:${server.address().port}`, requests = [], errors = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith(`/api/page-builder/${job.id}/media/`)) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  const pixel = image => image.evaluate(async element => {
    await element.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(element, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const opener = page.locator('[data-builder-id="common-hero"]'), cardImage = opener.locator('.builder-media-preview img').first();
  assert.deepEqual(await pixel(cardImage), [255, 0, 0, 255]);
  await page.locator('.builder-block:visible img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.evaluate(() => {
    window.untouchedImages = [...document.querySelectorAll('[data-block-id]:not([data-block-id="common-hero"]) img')].map(image => ({ image, src: image.src }));
    window.untouchedImageRemovals = 0;
    new MutationObserver(records => {
      for (const record of records) for (const removed of record.removedNodes) {
        if (window.untouchedImages.some(({ image }) => removed === image || removed.contains(image))) window.untouchedImageRemovals++;
      }
    }).observe(document.getElementById('page-builder-content'), { childList: true, subtree: true });
  });
  const before = await cardImage.elementHandle();
  await opener.click(); await page.waitForFunction(() => !document.getElementById('builder-media-common-hero-media-originalUrl-choose')?.disabled);
  await page.getByRole('button', { name: 'Выбрать основную картинку' }).click(); await page.waitForSelector('.builder-catalog-layer');
  await page.getByRole('button', { name: 'Выбрать изображение 1', exact: true }).click(); await page.waitForSelector('.builder-catalog-layer', { state: 'detached' });
  assert.deepEqual(await pixel(page.locator('.builder-image-previews img').first()), [0, 0, 255, 255], 'draft previews the selected image');
  requests.length = 0;
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/page-builder/${job.id}`);
  await page.locator('#page-builder-save').click(); assert.equal((await saved).status(), 200);
  await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForFunction(node => !node.isConnected, before);
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].media[0].originalMedia.sha256, crypto.createHash('sha256').update(newImage).digest('hex'));
  assert.deepEqual(await pixel(cardImage), [0, 0, 255, 255], 'card shows the saved image immediately');
  assert.ok(requests.some(url => new URL(url).pathname.endsWith(`/${asset.id}`)), 'the saved block fetches fresh image bytes');
  assert.deepEqual(requests.filter(url => !new URL(url).pathname.endsWith(`/${asset.id}`)), [], 'saving does not request images belonging to other blocks');
  assert.equal(await page.evaluate(() => window.untouchedImages.every(({ image, src }) => image.isConnected && image.src === src) && window.untouchedImageRemovals === 0), true, 'all other image nodes, including hidden lazy thumbnails, stay attached with unchanged URLs');
  await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.deepEqual(await pixel(page.locator('.builder-image-previews img').first()), [0, 0, 255, 255], 'reopened editor shows the saved image without reload');
  // A text-only save must follow the same scoped path.
  await page.locator('#builder-title').fill('Изменённый баннер'); requests.length = 0;
  await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  await page.waitForSelector('[data-builder-id="common-hero"][aria-label^="Изменённый баннер"]');
  assert.deepEqual(await pixel(cardImage), [0, 0, 255, 255]);
  assert.deepEqual(requests.filter(url => !new URL(url).pathname.endsWith(`/${asset.id}`)), [], 'text-only save also leaves other image requests untouched');
  assert.equal(await page.evaluate(() => window.untouchedImages.every(({ image, src }) => image.isConnected && image.src === src) && window.untouchedImageRemovals === 0), true);
  const captureImages = async (excluded = '') => {
    await page.evaluate(excluded => {
      window.untouchedImages = [...document.querySelectorAll('#page-builder-content img')].filter(image => !excluded || !image.closest(excluded)).map(image => ({ image, src: image.src }));
      window.untouchedImageRemovals = 0;
    }, excluded);
    requests.length = 0;
  };
  const assertImagesRetained = async label => {
    await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
    assert.equal(await page.evaluate(() => window.untouchedImages.every(({ image, src }) => image.isConnected && image.src === src) && window.untouchedImageRemovals === 0), true, `${label}: neighboring images never detach or change URL`);
    assert.deepEqual(requests, [], `${label}: no neighboring image requests`);
  };
  await page.locator('[data-add-section="common"]').click(); await page.locator('#builder-title').fill('Добавленный блок');
  await captureImages(); await page.locator('#page-builder-save').click();
  await page.waitForSelector('[data-builder-id][aria-label^="Добавленный блок"]'); await assertImagesRetained('create block');
  assert.equal(await page.getByRole('button', { name: 'Ниже: Быстрые действия', exact: true, includeHidden: true }).isEnabled(), true, 'previous last block can now move down');
  await page.getByRole('button', { name: 'Удалить блок: Добавленный блок', exact: true }).click();
  await captureImages(); await page.locator('#page-builder-save').click();
  await page.waitForSelector('[data-builder-id][aria-label^="Добавленный блок"]', { state: 'detached' }); await assertImagesRetained('delete block');
  assert.equal(await page.getByRole('button', { name: 'Ниже: Быстрые действия', exact: true, includeHidden: true }).isDisabled(), true, 'last-block controls are recalculated after deletion');
  await page.locator('[data-tab-menu-id="news"]').click(); await page.getByRole('button', { name: 'Переименовать', exact: true }).click();
  await page.locator('#builder-title').fill('Новости после правки'); await captureImages(); await page.locator('#page-builder-save').click();
  await page.waitForSelector('[data-tab-id="news"][aria-label^="Новости после правки"]'); await assertImagesRetained('rename tab');
  assert.equal(await page.locator('[data-block-id="common-hero"] .builder-move option[value="news"]').textContent(), 'Новости после правки', 'retained cards receive updated destination names');
  await page.getByRole('button', { name: 'Добавить вкладку', exact: true }).click(); await page.locator('#builder-title').fill('Добавленная вкладка');
  await captureImages(); await page.locator('#page-builder-save').click();
  await page.waitForSelector('[data-tab-id][aria-label^="Добавленная вкладка"]'); await assertImagesRetained('create tab');
  assert.equal(await page.locator('.builder-tab-panel:visible').count(), 1);
  // Deleting an existing tab may remove its own images, but keeps every neighbor.
  await page.locator('[data-tab-menu-id="posters"]').click(); await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await captureImages('#builder-panel-posters'); await page.locator('#page-builder-save').click();
  await page.waitForSelector('#builder-panel-posters', { state: 'detached' }); await assertImagesRetained('delete tab with images');
  assert.equal(await page.locator('.builder-tab-panel:visible').getAttribute('id'), 'builder-panel-news');
  assert.equal(await page.locator('[data-block-id="common-hero"] .builder-move option[value="posters"]').count(), 0);
  // A retained neighbor must open with the current document and save its review.
  await page.locator('[data-builder-id="common-actions"]').click(); await page.locator('#builder-review-status').selectOption('passed');
  await captureImages('[data-block-id="common-actions"]'); await page.locator('#page-builder-save').click();
  await page.waitForSelector('[data-block-id="common-actions"] .review-passed');
  assert.equal(await page.evaluate(() => window.untouchedImages.every(({ image, src }) => image.isConnected && image.src === src) && window.untouchedImageRemovals === 0), true);
  const neighborAssets = queue.pageBuilder.read(job.id).document.common.blocks[1].media.map(asset => asset.id);
  assert.deepEqual(requests.filter(url => !neighborAssets.includes(new URL(url).pathname.split('/').at(-1))), [], 'saving the retained neighbor refreshes only its own media');
  assert.deepEqual(await pixel(cardImage), [0, 0, 255, 255], 'a subsequent neighbor save preserves the replacement image');
  await page.waitForSelector('.modal-backdrop', { state: 'hidden' });
  await page.getByRole('button', { name: 'Перетащить блок: Быстрые действия', exact: true }).focus(); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelector('#page-builder-content > .builder-section [data-block-id]')?.dataset.blockId === 'common-actions');
  assert.deepEqual(queue.pageBuilder.read(job.id).document.common.blocks.map(block => block.id), ['common-actions', 'common-hero'], 'retained neighbor keyboard controls use current section and index');
  // Subsequent full renders must retain the unchanged blocks' media versions.
  const unchangedUrl = await page.locator('[data-builder-id="common-actions"] img').first().getAttribute('src');
  await page.locator('[data-tab-id="prices"]').click();
  assert.equal(await page.locator('[data-builder-id="common-actions"] img').first().getAttribute('src'), unchangedUrl);
  // External revisions still invalidate media, even when asset URLs did not change.
  const current = queue.pageBuilder.read(job.id), external = structuredClone(current.document);
  external.common.blocks.find(block => block.id === 'common-hero').title = 'Изменено извне'; queue.pageBuilder.write(job.id, current.revision, external);
  await page.waitForSelector('[data-builder-id="common-hero"][aria-label^="Изменено извне"]');
  assert.notEqual(await page.locator('[data-builder-id="common-actions"] img').first().getAttribute('src'), unchangedUrl);
  assert.deepEqual(await pixel(cardImage), [0, 0, 255, 255]); assert.deepEqual(errors, []);
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
  assert.equal(await page.getByRole('button', { name: 'Выбрать основную картинку' }).first().isDisabled(), false);
  assert.equal(preparations, 0);
  await page.locator('#builder-type').selectOption('grid'); await page.locator('#builder-type').selectOption('content');
  assert.equal(preparations, 0, 'rerendering image fields does not prepare media');
  await page.getByRole('button', { name: 'Выбрать основную картинку' }).first().click(); await page.waitForSelector('.builder-catalog-layer');
  await page.locator('.builder-catalog-tile').first().click(); await page.waitForSelector('.builder-catalog-layer', { state: 'detached' });
  assert.equal(preparations, 0);
});

test('embed frame catalog uses step 2 provenance, isolates players, restores focus and persists responsive previews', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-frame-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  const attempt = job.attempts[0], first = 'https://rutube.ru/play/embed/first/', second = 'https://rutube.ru/play/embed/second/';
  const manifest = queue.stage.media.create(job, attempt, Buffer.from(`<iframe src="${first}"></iframe><iframe src="${second}"></iframe><iframe src="https://yandex.ru/map-widget/v1/?ll=37,55&amp;z=13"></iframe><iframe srcdoc="hello"></iframe><iframe src="http://127.0.0.1/private"></iframe>`), 'test');
  const initial = queue.pageBuilder.read(job.id), document = structuredClone(initial.document), block = document.common.blocks[0];
  const selected = queue.framePicker.choose(job.id, { revision: initial.revision, attempt: 1, htmlRevision: 1 }, 1);
  Object.assign(block, { type: 'embed', view: 'default', text: 'Прежний Markdown', source_url: selected.source_url, sourceFrame: selected.sourceFrame, link: '/watch', provider: 'video', ratio: '4:3' });
  queue.pageBuilder.write(job.id, initial.revision, document); manifest.status = 'ready_with_issues'; queue.stage.media.publish(job, attempt, manifest); Object.assign(attempt, { status: 'complete', captureStatus: 'complete' }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), external = [], errors = [], origin = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(origin)) return route.continue();
    external.push(route.request().url()); return route.fulfill({ contentType: 'text/html', body: '<h1>Fixture player</h1>' });
  });
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const opener = page.locator('[data-builder-id="common-hero"]'); await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('#builder-source_url').count(), 0); assert.equal(await page.locator('.builder-embed-inputs label').count(), 0);
  assert.deepEqual(await page.locator('.builder-embed-inputs > *').evaluateAll(nodes => nodes.map(node => [node.tagName, node.getAttribute('aria-label')])), [['INPUT', 'Ссылка'], ['SELECT', 'Тип источника']]);
  assert.equal(await page.locator('#builder-content').inputValue(), 'Прежний Markdown'); assert.equal(await page.locator('#builder-link').getAttribute('placeholder'), 'URL для открытия');
  const picker = page.getByRole('button', { name: 'Выбрать фрейм шага 2', exact: true });
  const attrs = await picker.locator('iframe').evaluate(frame => ({ src: frame.src, credentialless: frame.credentialless, sandbox: frame.sandbox.value, lazy: frame.loading, tab: frame.tabIndex, pointer: getComputedStyle(frame).pointerEvents }));
  assert.deepEqual(attrs, { src: first, credentialless: true, sandbox: 'allow-scripts allow-presentation allow-same-origin', lazy: 'lazy', tab: -1, pointer: 'none' });
  for (const width of [1440, 390, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await picker.scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#page-builder-modal .modal-body').evaluate(node => node.scrollWidth <= node.clientWidth), true, `${width}: editor fits`);
    const geometry = await page.locator('.builder-embed-card').evaluate(node => { const [p, i] = [...node.children].map(child => child.getBoundingClientRect()), c = node.getBoundingClientRect(), style = getComputedStyle(node); return { side: i.left >= p.right, below: i.top >= p.bottom, gap: i.left - p.right, previewWidth: p.width, fieldsWidth: i.width, remaining: c.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) - i.right, fieldsFill: [...node.querySelectorAll('.builder-embed-inputs > *')].every(field => Math.abs(field.getBoundingClientRect().width - i.width) < .1) }; });
    if ([1440, 390, 320].includes(width)) t.diagnostic('FRAME_FIELD_GEOMETRY ' + JSON.stringify({ width, ...geometry }));
    assert.equal(width === 1440 ? geometry.side : geometry.below, true, `${width}: frame/field placement`);
    assert.equal(geometry.remaining, 0, `${width}: fields fill the available width to the inner right edge`);
    assert.equal(geometry.fieldsFill, true, `${width}: link and provider both use the full field column`);
    if (width === 1440) assert.equal(geometry.gap, 12, 'only the regular gap separates the compact preview and fields');
    if ([1440, 390, 320].includes(width)) {
      const frameGeometry = await picker.evaluate(node => {
        const box = item => { const rect = item.getBoundingClientRect(); return { width: rect.width, height: rect.height }; };
        const viewport = node.querySelector('.media-frame-viewport'), frame = viewport.querySelector('iframe'), style = getComputedStyle(frame);
        const rect = node.getBoundingClientRect(), corner = document.elementFromPoint(rect.right - 2, rect.bottom - 2), outside = document.elementFromPoint(rect.right + 2, rect.bottom - 2);
        return { button: box(node), clickAreaMatches: corner?.closest('.builder-embed-preview') === node && outside?.closest('.builder-embed-preview') !== node, viewport: box(viewport), iframe: box(frame), inner: { width: frame.clientWidth, height: frame.clientHeight, scale: style.transform }, fields: box(node.closest('.builder-embed-card').querySelector('.builder-embed-inputs')), section: box(node.closest('.builder-embed-card')), formHeight: node.closest('.modal-body').scrollHeight };
      });
      await page.locator('#builder-type').selectOption('big-media');
      const imageGeometry = await page.locator('.builder-image-preview-button').first().evaluate(node => {
        const box = item => { const rect = item.getBoundingClientRect(); return { width: rect.width, height: rect.height }; };
        return { button: box(node), fields: box(node.closest('.builder-media-top').querySelector('.builder-media-fields')), section: box(node.closest('.builder-media-top')), formHeight: node.closest('.modal-body').scrollHeight };
      });
      await page.locator('#builder-type').selectOption('embed');
      assert.deepEqual(frameGeometry.button, { width: 154, height: 88 }, `${width}: editor uses an image-sized compact button`);
      assert.equal(frameGeometry.button.height, imageGeometry.button.height, `${width}: frame is no taller than existing image previews`);
      assert.deepEqual(frameGeometry.iframe, frameGeometry.viewport, `${width}: the whole scaled iframe fits its visible viewport`);
      assert.deepEqual(frameGeometry.inner, { width: 608, height: 344, scale: 'matrix(0.25, 0, 0, 0.25, 0, 0)' }, `${width}: player has a full internal viewport, not enlarged thumbnail text`);
      assert.equal(frameGeometry.clickAreaMatches, true, `${width}: selection hit area matches the visible box`);
      assert.ok(frameGeometry.section.height <= (width === 1440 ? 120 : 220), `${width}: preview does not stretch the editor section`);
      assert.ok(frameGeometry.formHeight < ({ 1440: 877, 390: 985, 320: 1038 })[width], `${width}: reduced preview reduces form height`);
      t.diagnostic('FRAME_EDITOR_GEOMETRY ' + JSON.stringify({ width, frame: frameGeometry, image: imageGeometry }));
    }
    if ([1440, 320].includes(width)) {
      await page.mouse.move(0, 0); await page.locator('#builder-link').focus();
      await picker.frameLocator('iframe').getByRole('heading', { name: 'Fixture player', exact: true }).waitFor({ state: 'visible' });
      await page.screenshot({ path: path.join(testOutput(), `ui-frame-editor-${width}.png`) });
    }
    await picker.click(); await page.locator('.builder-frame-tile').first().waitFor();
    assert.equal(await page.locator('.builder-frame-tile').count(), 5); assert.equal(await page.locator('.builder-frame-tile:disabled').count(), 2);
    assert.equal(await page.locator('.builder-frame-tile').nth(2).locator('iframe').count(), 0); assert.match(await page.locator('.builder-frame-tile').nth(2).innerText(), /вне списка/);
    assert.equal(await page.locator('.builder-catalog-panel').evaluate(node => node.scrollWidth <= node.clientWidth), true, `${width}: catalog fits`);
    assert.equal(await page.locator('#builder-frame-catalog-title').innerText(), 'Выбрать фрейм');
    assert.equal(await page.locator('.builder-frame-catalog a, .builder-frame-source').count(), 0);
    assert.equal(await page.locator('.builder-frame-tile').evaluateAll(nodes => nodes.every(node => !/https?:/.test(node.innerText))), true, 'frame tiles have no visible source URLs');
    assert.deepEqual(await page.locator('.builder-frame-tile').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Выбрать фрейм 1', 'Выбрать фрейм 2', 'Выбрать фрейм 3', 'Выбрать фрейм 4', 'Выбрать фрейм 5']);
    assert.equal(await page.locator('.builder-frame-tile .media-frame-unavailable').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), true, `${width}: reasons wrap without clipping`);
    for (const index of [0, 1]) await page.locator('.builder-frame-tile').nth(index).frameLocator('iframe').getByRole('heading', { name: 'Fixture player', exact: true }).waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('.builder-frame-tile iframe').first().evaluate(frame => ({ scale: getComputedStyle(frame).transform, height: frame.getBoundingClientRect().height })), { scale: 'matrix(0.5, 0, 0, 0.5, 0, 0)', height: 96 }, `${width}: catalog keeps its existing size and scale`);
    if ([1440, 320].includes(width)) await page.screenshot({ path: path.join(testOutput(), `ui-frame-catalog-${width}.png`) });
    await page.locator('.builder-frame-catalog .btn-close').focus(); await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.builder-frame-tile').nth(2).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Tab'); assert.equal(await page.locator('.builder-frame-catalog .btn-close').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Escape'); await page.waitForSelector('.builder-frame-catalog', { state: 'detached' });
    assert.equal(await picker.evaluate(node => node === document.activeElement), true); assert.equal(await page.locator('#page-builder-modal').isVisible(), true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A response arriving after Escape cannot change the draft.
  let release, started; const pending = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { started = resolve; });
  const slowChoice = async route => { started(); await pending; await route.continue().catch(() => {}); };
  await page.route('**/choose-frame', slowChoice); await picker.click(); await page.locator('.builder-frame-tile').nth(1).click(); await requested;
  assert.equal(await page.locator('#page-builder-save').isDisabled(), true); assert.equal(await page.locator('#builder-frame-clear').isDisabled(), true); await page.keyboard.press('Escape'); assert.equal(await page.locator('#builder-frame-clear').isEnabled(), true); release(); await page.unroute('**/choose-frame', slowChoice);
  assert.equal(await picker.locator('iframe').getAttribute('src'), first); assert.equal(await page.locator('#page-builder-save').isEnabled(), true);
  await picker.click(); await page.locator('.builder-frame-tile').nth(1).click(); await page.waitForSelector('.builder-frame-catalog', { state: 'detached' });
  assert.equal(await picker.locator('iframe').getAttribute('src'), second);
  await page.locator('#builder-type').selectOption('service'); await page.locator('#builder-type').selectOption('embed');
  assert.equal(await picker.locator('iframe').getAttribute('src'), second, 'frame draft survives type switches');
  await page.locator('#builder-content').fill('Новый **Markdown**'); await page.locator('#builder-link').fill('/new-watch'); await page.locator('#builder-provider').selectOption('video');
  let releaseSave, savingStarted; const savingGate = new Promise(resolve => { releaseSave = resolve; }), savingRequest = new Promise(resolve => { savingStarted = resolve; });
  const builderRequest = url => url.pathname === `/api/page-builder/${job.id}`;
  const slowSave = async route => { if (route.request().method() === 'POST') { savingStarted(); await savingGate; } await route.continue(); };
  await page.route(builderRequest, slowSave); await page.locator('#page-builder-save').click(); await savingRequest;
  assert.equal(await page.locator('#builder-frame-clear').isDisabled(), true, 'saving fences frame clearing');
  releaseSave(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.unroute(builderRequest, slowSave);
  await page.waitForFunction(url => document.querySelector('[data-builder-id="common-hero"] iframe')?.src === url, second);
  const saved = queue.pageBuilder.read(job.id).document.common.blocks[0]; assert.equal(saved.source_url, second); assert.equal(saved.sourceFrame.resourceId, 2); assert.equal(saved.text, 'Новый **Markdown**'); assert.equal(saved.link, '/new-watch');
  for (const width of [1440, 390, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await opener.scrollIntoViewIfNeeded();
    assert.equal(await opener.locator('iframe').isVisible(), true); assert.equal(await opener.evaluate(node => node.scrollWidth <= node.clientWidth), true, `${width}: saved card fits`);
    assert.ok(await opener.locator('.builder-block-copy').evaluate(node => node.getBoundingClientRect().width) >= 60, `${width}: saved text remains visible`);
    if ([1440, 390, 320].includes(width)) {
      const geometry = await opener.evaluate((node, width) => {
      const box = item => { const rect = item.getBoundingClientRect(); return { width: rect.width, height: rect.height }; };
      const viewport = node.querySelector('.media-frame-viewport'), frame = viewport.querySelector('iframe'), image = document.querySelector('[data-builder-id="common-actions"] .builder-media-preview img'), imageStyle = getComputedStyle(image);
      return { width, viewport: box(viewport), iframe: box(frame), inner: { width: frame.clientWidth, height: frame.clientHeight, scale: getComputedStyle(frame).transform }, card: box(node.closest('.builder-block')), image: { width: parseFloat(imageStyle.width), height: parseFloat(imageStyle.height), card: box(image.closest('.builder-block')) } };
      }, width);
      assert.deepEqual(geometry.viewport, { width: 52, height: 32 }, `${width}: saved preview is compact`);
      assert.deepEqual(geometry.iframe, geometry.viewport, `${width}: saved preview shows the complete scaled frame`);
      assert.deepEqual(geometry.inner, { width: 416, height: 256, scale: 'matrix(0.125, 0, 0, 0.125, 0, 0)' });
      assert.ok(geometry.viewport.width <= geometry.image.width && geometry.viewport.height <= geometry.image.height, `${width}: saved frame does not exceed an image thumbnail`);
      assert.equal(geometry.card.height, geometry.image.card.height, `${width}: frame does not increase card height`);
      t.diagnostic('FRAME_SAVED_GEOMETRY ' + JSON.stringify(geometry));
    }
    await opener.frameLocator('iframe').getByRole('heading', { name: 'Fixture player', exact: true }).waitFor({ state: 'visible' });
    if ([1440, 320].includes(width)) await page.screenshot({ path: path.join(testOutput(), `ui-frame-saved-${width}.png`) });
  }
  const beforeClear = queue.pageBuilder.read(job.id);
  await opener.click(); await page.waitForSelector('#page-builder-modal.show');
  const clearFrame = page.getByRole('button', { name: 'Сбросить фрейм', exact: true });
  assert.equal(await picker.locator('#builder-frame-clear').count(), 0, 'clear is a sibling button, never nested in the picker');
  const clearBox = await clearFrame.evaluate(node => { const c = node.getBoundingClientRect(), p = node.parentElement.getBoundingClientRect(); return { width: c.width, height: c.height, inside: c.left >= p.left && c.right <= p.right && c.top >= p.top && c.bottom <= p.bottom }; });
  assert.deepEqual(clearBox, { width: 28, height: 28, inside: true });
  await page.locator('#builder-review-status').selectOption('passed'); await clearFrame.focus(); await page.keyboard.press('Enter');
  assert.equal(await picker.locator('iframe').count(), 0); assert.equal(await clearFrame.count(), 0); assert.equal(await picker.evaluate(node => node === document.activeElement), true);
  assert.equal(await page.locator('#builder-review-status').inputValue(), 'unreviewed'); assert.equal(await page.locator('#builder-link').inputValue(), '/new-watch'); assert.equal(await page.locator('#builder-provider').inputValue(), 'video');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  assert.deepEqual(queue.pageBuilder.read(job.id), beforeClear, 'Cancel leaves the saved source and provenance intact');
  await opener.click(); assert.equal(await picker.locator('iframe').getAttribute('src'), second);
  const concurrent = queue.pageBuilder.read(job.id); concurrent.document.common.title = 'Concurrent title'; queue.pageBuilder.write(job.id, concurrent.revision, concurrent.document);
  await clearFrame.click(); await page.locator('#page-builder-save').click();
  await page.waitForFunction(() => /изменены|обновилась/.test(document.querySelector('#page-builder-form-error')?.textContent || ''));
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].source_url, second, 'a stale clear loses CAS and cannot overwrite the saved source');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)'); await opener.click();
  await clearFrame.click(); await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  const cleared = queue.pageBuilder.read(job.id).document.common.blocks[0]; assert.equal(Object.hasOwn(cleared, 'source_url'), false); assert.equal(Object.hasOwn(cleared, 'sourceFrame'), false);
  assert.equal(cleared.link, '/new-watch'); assert.equal(cleared.provider, 'video'); assert.equal(cleared.review.status, 'unreviewed');
  await opener.locator('.builder-media-preview').waitFor({ state: 'detached' });
  assert.equal(await opener.locator('.builder-media-preview, .media-frame-viewport, .builder-media-placeholder, iframe').count(), 0, 'saved empty frame has no media preview or placeholder');
  await page.screenshot({ path: path.join(testOutput(), 'ui-frame-empty-saved-320.png') });
  await opener.click(); assert.equal(await picker.locator('iframe').count(), 0); assert.equal(await clearFrame.count(), 0);
  const requestsBeforeEmpty = external.length;
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await picker.scrollIntoViewIfNeeded();
    assert.equal(await picker.getAttribute('aria-label'), 'Выбрать фрейм шага 2');
    assert.equal(await picker.locator('.media-frame-unavailable, .media-frame-viewport, iframe').count(), 0);
    assert.equal(await picker.locator('.builder-frame-placeholder').innerText(), '');
    assert.equal(await picker.locator('.builder-frame-placeholder').getAttribute('aria-hidden'), 'true');
    const emptyGeometry = await picker.evaluate(node => {
      const rect = node.getBoundingClientRect(), icon = node.querySelector('svg'), svg = icon.getBoundingClientRect();
      return { width: rect.width, height: rect.height, iconWidth: svg.width, iconHeight: svg.height, centered: Math.abs(svg.left + svg.width / 2 - rect.left - rect.width / 2) < 1 && Math.abs(svg.top + svg.height / 2 - rect.top - rect.height / 2) < 1, fits: node.scrollWidth <= node.clientWidth, bodyFits: document.querySelector('#page-builder-fields').scrollWidth <= document.querySelector('#page-builder-fields').clientWidth, paths: icon.querySelectorAll('path').length, hidden: icon.getAttribute('aria-hidden') };
    });
    assert.deepEqual(emptyGeometry, { width: 154, height: 88, iconWidth: 24, iconHeight: 24, centered: true, fits: true, bodyFits: true, paths: 2, hidden: 'true' });
    await picker.hover(); assert.equal(await picker.locator('.builder-image-preview-hint').evaluate(node => getComputedStyle(node).opacity), '1');
    assert.equal(await picker.locator('.builder-image-preview-hint-text').innerText(), 'Выбрать фрейм');
    await page.mouse.move(0, 0); await page.locator('#builder-link').focus();
    if ([1440, 320].includes(width)) await page.screenshot({ path: path.join(testOutput(), `ui-frame-empty-editor-${width}.png`) });
    t.diagnostic('FRAME_EMPTY_GEOMETRY ' + JSON.stringify({ viewportWidth: width, ...emptyGeometry }));
  }
  assert.equal(external.length, requestsBeforeEmpty, 'empty preview makes no external request');
  await picker.click(); await page.locator('.builder-frame-tile').nth(2).click(); await page.waitForSelector('.builder-frame-catalog', { state: 'detached' });
  assert.equal(await picker.locator('iframe').count(), 0); assert.match(await picker.innerText(), /вне списка/);
  await page.locator('#builder-view').selectOption('map'); await page.locator('.builder-banner-advanced summary').click(); await page.locator('#builder-meta-map_height').fill('560');
  await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('[data-builder-id="common-hero"] .media-frame-unavailable')?.textContent.includes('вне списка'));
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].meta.map_height, 560);
  assert.ok(external.every(url => url.startsWith('https://rutube.ru/')), 'maps and unsafe sources never load'); assert.deepEqual(errors, []);
});

test('frame picker exposes missing, empty, unsupported and stale inventories without changing a legacy source', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-empty-frame-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  const stored = queue.pageBuilder.read(job.id), block = stored.document.common.blocks[0]; Object.assign(block, { type: 'embed', view: 'default', source_url: 'https://rutube.ru/unbound' });
  fs.writeFileSync(queue.pageBuilder.file(job.id), JSON.stringify(stored)); Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 0, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`, external = [];
  await page.route('**/*', route => { if (route.request().url().startsWith(origin)) return route.continue(); external.push(route.request().url()); return route.abort(); });
  const open = async () => {
    await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
    const card = page.locator('[data-builder-id="common-hero"]'); assert.equal(await card.locator('.builder-media-preview, .media-frame-viewport, .builder-media-placeholder, iframe').count(), 0, 'unverified legacy URL is not presented as a selected frame');
    await card.click(); const picker = page.getByRole('button', { name: 'Выбрать фрейм шага 2' });
    assert.equal(await picker.locator('.builder-frame-placeholder, iframe').count(), 0); assert.match(await picker.innerText(), /не найден/);
    await picker.click();
  };
  const close = async () => { await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); };
  await open(); assert.match(await page.locator('.builder-frame-catalog .builder-catalog-message').innerText(), /ещё нет HTML/); await close();
  { const manifest = queue.stage.media.create(job, job.attempts[0], Buffer.from('<p>No frames</p>'), 'test'); manifest.status = 'ready_with_issues'; queue.stage.media.publish(job, job.attempts[0], manifest); }
  await open(); await page.waitForFunction(() => document.querySelector('.builder-frame-catalog .builder-catalog-message')?.textContent === ''); await close();
  { const manifest = queue.stage.media.create(job, job.attempts[0], Buffer.from('<iframe srcdoc="hello"></iframe>'), 'test'); manifest.status = 'ready_with_issues'; queue.stage.media.publish(job, job.attempts[0], manifest); }
  await open(); await page.locator('.builder-frame-tile').waitFor(); assert.equal(await page.locator('.builder-frame-tile').isDisabled(), true); await close();
  { const manifest = queue.stage.media.create(job, job.attempts[0], Buffer.from('<iframe src="https://unknown.example/widget"></iframe>'), 'test'); manifest.status = 'ready_with_issues'; queue.stage.media.publish(job, job.attempts[0], manifest); }
  await open(); await page.locator('.builder-frame-tile').waitFor();
  const current = queue.pageBuilder.read(job.id); current.document.common.title = 'External edit'; queue.pageBuilder.write(job.id, current.revision, current.document);
  await page.locator('.builder-frame-tile').click(); await page.waitForFunction(() => document.querySelector('.builder-frame-catalog .builder-catalog-message')?.getAttribute('role') === 'alert');
  assert.match(await page.locator('.builder-frame-catalog .builder-catalog-message').innerText(), /изменились/); await page.keyboard.press('Escape');
  assert.match(await page.getByRole('button', { name: 'Выбрать фрейм шага 2' }).innerText(), /не найден/);
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].source_url, 'https://rutube.ru/unbound'); assert.deepEqual(external, []);
});

test('step 3 document item Markdown stays collapsed by default without responsive overflow', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-document-text-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator('[data-builder-id="common-hero"]').click(); const tablePatterns = await tableCellDisclosurePatterns(page); await page.locator('#builder-type').selectOption('links');
  await page.getByRole('button', { name: 'Добавить ссылку' }).click();
  assert.deepEqual(await page.locator('.builder-link-row').first().locator(':scope > .builder-image-tools > button').evaluateAll(nodes => nodes.map(node => node.classList.contains('builder-media-drag') ? 'drag' : node.classList.contains('builder-delete') ? 'delete' : 'other')), ['drag', 'delete'], 'ordinary links keep their original drag/delete order');
  await page.getByRole('button', { name: 'Удалить ссылку 1' }).click(); await page.locator('#builder-view').selectOption('documents');
  await page.getByRole('button', { name: 'Добавить документ' }).click();
  const row = page.locator('.builder-link-row').first(), item = row.locator(':scope > .builder-item-details'), summary = item.locator(':scope > summary'), text = row.locator('.builder-item-markdown');
  assert.equal(await item.getAttribute('open'), null); assert.equal(await summary.innerText(), 'Документ');
  assert.equal(await row.getByRole('button', { name: 'Перетащить документ 1' }).isEnabled(), true); assert.equal(await row.getByRole('button', { name: 'Удалить документ 1' }).isEnabled(), true);
  assert.deepEqual(await disclosurePattern(row), tablePatterns[1440], 'document item uses the table-cell disclosure geometry and control order');
  await summary.focus(); await page.keyboard.press('Enter'); assert.equal(await item.getAttribute('open'), '');
  assert.equal(await text.getAttribute('open'), null); assert.equal(await text.locator(':scope > summary').innerText(), 'Текст');
  assert.equal(await text.getByLabel('Текст в Markdown').getAttribute('placeholder'), 'Текст в Markdown');
  assert.equal(await text.locator('.builder-markdown-tools').isVisible(), false);
  await text.locator(':scope > summary').click(); assert.equal(await text.getByRole('button', { name: 'Жирный', exact: true }).count(), 1);
  await text.getByLabel('Текст в Markdown').fill('**Документ**'); assert.equal(await text.locator('.builder-markdown-preview strong').innerText(), 'Документ');
  await row.getByLabel('Заголовок').fill('Инструкция'); assert.equal(await summary.innerText(), 'Инструкция');
  for (const width of disclosureWidths) {
    await page.setViewportSize({ width, height: 900 }); await row.scrollIntoViewIfNeeded();
    assert.deepEqual(await disclosurePattern(row), tablePatterns[width], `${width}px: document disclosure matches the table cell`);
    assert.equal(await page.locator('#page-builder-modal .modal-body').evaluate(node => node.scrollWidth <= node.clientWidth), true, `${width}px: collapsed document item has no horizontal overflow`);
  }
  await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show');
  const reopened = page.locator('.builder-link-row').first().locator(':scope > .builder-item-details');
  assert.equal(await reopened.getAttribute('open'), null); assert.equal(await reopened.locator(':scope > summary').innerText(), 'Инструкция');
  await reopened.locator(':scope > summary').click(); assert.equal(await reopened.getAttribute('open'), '');
  const documentIds = await page.locator('.builder-link-row').evaluateAll(nodes => nodes.map(node => node.dataset.itemId));
  await page.getByRole('button', { name: 'Добавить документ' }).click(); const addedDocumentId = await page.locator('.builder-link-row').last().getAttribute('data-item-id');
  await page.locator('.builder-link-row').last().locator('.builder-link-drag').focus(); await page.keyboard.press('ArrowUp');
  assert.deepEqual(await page.locator('.builder-link-row').evaluateAll(nodes => nodes.map(node => node.dataset.itemId)), [addedDocumentId, ...documentIds]);
  const addedDocument = page.locator(`.builder-link-row[data-item-id="${addedDocumentId}"]`);
  await addedDocument.locator(':scope > details').evaluate(node => { window.documentItemDeleteToggles = 0; node.addEventListener('toggle', () => { window.documentItemDeleteToggles++; }); });
  await addedDocument.locator(':scope > .builder-image-tools .builder-delete').click(); assert.equal(await page.evaluate(() => window.documentItemDeleteToggles), 0); assert.equal(await page.locator('.builder-link-row').count(), 1);
});

test('step 3 grid views share the item editor, local images and saved data without overflow', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-gallery-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  installLocalPreview(queue, job, queue.pageBuilder.read(job.id).document.common.blocks[0].media[0]);
  const stored = queue.pageBuilder.read(job.id), document = structuredClone(stored.document);
  Object.assign(document.common.blocks[0], { type: 'grid', view: 'gallery', media: [], items: [], meta: {} }); queue.pageBuilder.write(job.id, stored.revision, document);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show');
  const tablePatterns = await tableCellDisclosurePatterns(page); await page.locator('#builder-type').selectOption('grid');
  assert.deepEqual(await page.locator('.builder-content-fields > *').evaluateAll(nodes => nodes.map(node => node.className)), ['builder-text-fields', 'builder-images-section builder-links-section builder-gallery-section', 'builder-banner-advanced builder-gallery-advanced']);
  assert.deepEqual(await page.locator('#builder-grid-image_ratio option').evaluateAll(nodes => nodes.map(node => node.value)), ['auto', '4x3', '3x2', '1x1']);
  assert.equal(await page.locator('#builder-grid-image_fit').inputValue(), 'contain', 'gallery uses the Beget template default');
  assert.deepEqual(await page.locator('#builder-grid-columns option').evaluateAll(nodes => nodes.map(node => node.value)), ['2', '3', '4', '5', '6']);
  assert.deepEqual(await page.locator('#builder-grid-item_max_width').evaluate(node => [node.min, node.max]), ['96', '720']);
  await page.locator('#builder-add-gallery-item').click();
  const row = page.locator('.builder-gallery-item').first(), itemId = await row.getAttribute('data-item-id');
  const galleryItem = row.locator(':scope > .builder-item-details'), gallerySummary = galleryItem.locator(':scope > summary');
  assert.equal(await galleryItem.getAttribute('open'), null); assert.equal(await gallerySummary.innerText(), 'Элемент');
  assert.equal(await row.getByRole('button', { name: 'Перетащить элемент 1' }).isEnabled(), true); assert.equal(await row.getByRole('button', { name: 'Удалить элемент 1' }).isEnabled(), true);
  assert.deepEqual(await disclosurePattern(row), tablePatterns[1440], 'gallery item uses the table-cell disclosure geometry and control order');
  await gallerySummary.focus(); await page.keyboard.press('Enter'); assert.equal(await galleryItem.getAttribute('open'), '');
  const itemText = row.locator('.builder-item-markdown');
  assert.equal(await itemText.getAttribute('open'), null); assert.equal(await itemText.locator(':scope > summary').innerText(), 'Текст');
  assert.equal(await itemText.getByLabel('Текст в Markdown').getAttribute('placeholder'), 'Текст в Markdown');
  assert.equal(await itemText.locator('.builder-markdown-tools').isVisible(), false, 'gallery Markdown editor is collapsed by default');
  assert.equal(await row.locator(`#builder-item-${itemId}-media_mode`).inputValue(), '');
  assert.equal(await row.locator(`#builder-item-${itemId}-media_mode option[value=""]`).textContent(), 'По умолчанию (intrinsic)');
  assert.equal(await row.locator(`#builder-item-${itemId}-media_width`).getAttribute('placeholder'), 'По умолчанию (без ограничения)');
  assert.deepEqual(await row.locator('.builder-gallery-item-body > details').evaluateAll(nodes => nodes.map(node => ({ title: node.querySelector(':scope > summary').textContent, open: node.open }))), [{ title: 'Текст', open: false }, { title: 'Изображение', open: false }, { title: 'Ссылка', open: false }]);
  await page.locator('.builder-gallery-advanced summary').click();
  await page.locator('#builder-grid-media_mode').selectOption('fill'); await page.locator('#builder-grid-media_align').selectOption('end');
  await page.locator('#builder-grid-media_width').fill('640');
  assert.equal(await row.locator(`#builder-item-${itemId}-media_mode option[value=""]`).textContent(), 'По умолчанию (fill)');
  assert.equal(await row.locator(`#builder-item-${itemId}-media_align option[value=""]`).textContent(), 'По умолчанию (end)');
  assert.equal(await row.locator(`#builder-item-${itemId}-media_width`).getAttribute('placeholder'), 'По умолчанию (640 px)');
  await row.getByText('Изображение', { exact: true }).click();
  await row.locator('.builder-gallery-image-settings summary').click();
  await row.locator(`#builder-item-${itemId}-media_mode`).selectOption('intrinsic');
  await row.locator(`#builder-item-${itemId}-media_align`).selectOption('center');
  await row.locator(`#builder-item-${itemId}-media_width`).fill('320');
  await row.locator(`#builder-item-${itemId}-media_mode`).selectOption('');
  await row.locator(`#builder-item-${itemId}-media_align`).selectOption('');
  await row.locator(`#builder-item-${itemId}-media_width`).fill('');
  assert.deepEqual(await row.locator('.builder-gallery-item-body > *').evaluateAll(nodes => nodes.map(node => node.tagName.toLowerCase())), ['input', 'details', 'details', 'details', 'div']);
  assert.deepEqual(await row.locator('.builder-gallery-item-body > input, .builder-gallery-item-body > textarea').evaluateAll(nodes => nodes.map(node => ({ placeholder: node.placeholder, label: node.getAttribute('aria-label') }))), [{ placeholder: 'Заголовок', label: 'Заголовок' }]);
  assert.equal(await row.locator('.builder-gallery-item-body > label').count(), 0);
  assert.deepEqual(await row.locator('.builder-gallery-labels input').evaluateAll(nodes => nodes.map(node => ({ placeholder: node.placeholder, label: node.getAttribute('aria-label') }))), [{ placeholder: 'Метка', label: 'Метка' }, { placeholder: 'Дата', label: 'Дата' }]);
  assert.equal(await row.locator('.builder-gallery-labels label').count(), 0);
  await row.locator(`#builder-item-${itemId}-title`).fill('Снимок'); assert.equal(await gallerySummary.innerText(), 'Снимок'); await itemText.locator(':scope > summary').click(); await itemText.getByLabel('Текст в Markdown').fill('**Описание**');
  assert.equal(await itemText.locator('.builder-markdown-preview strong').innerText(), 'Описание');
  await row.getByRole('button', { name: 'Выбрать основную картинку' }).click(); await page.waitForSelector('.builder-catalog-layer');
  await page.locator('.builder-catalog-tile').first().click(); await page.waitForSelector('.builder-catalog-layer', { state: 'detached' });
  assert.equal(await row.locator('.builder-media-image').count(), 1);
  await row.locator('.builder-gallery-link > summary').click();
  await row.locator(`#builder-item-${itemId}-link`).fill('https://example.com/'); await row.locator(`#builder-item-${itemId}-link_text`).fill('Подробнее');
  await row.locator(`#builder-item-${itemId}-badge`).fill('Новое'); await row.locator(`#builder-item-${itemId}-date`).fill('21.09.2026');
  await page.locator('#builder-grid-columns').selectOption('4');
  for (const width of disclosureWidths) {
    await page.setViewportSize({ width, height: 1000 }); await row.scrollIntoViewIfNeeded();
    assert.deepEqual(await disclosurePattern(row), tablePatterns[width], `${width}px: gallery disclosure matches the table cell`);
    const geometry = await page.locator('#page-builder-modal .modal-body').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(geometry.scroll <= geometry.client + 1, `${width}px: ${JSON.stringify(geometry)}`);
    const frames = await row.evaluate(node => {
      const body = node.querySelector('.builder-gallery-item-body'), parts = [...body.children].map(child => child.getBoundingClientRect());
      const outer = node.getBoundingClientRect(), image = body.querySelector('.builder-images-section').getBoundingClientRect();
      const imageSettings = body.querySelector('.builder-gallery-image-settings').getBoundingClientRect();
      const labels = [...body.querySelectorAll('.builder-gallery-labels input')].map(input => input.getBoundingClientRect());
      return { ordered: parts.every((part, index) => !index || part.top >= parts[index - 1].bottom - 1),
        contained: parts.every(part => part.left >= outer.left - 1 && part.right <= outer.right + 1),
        imageSettingsInside: imageSettings.left >= image.left && imageSettings.right <= image.right,
        labelsOneRow: labels.length === 2 && Math.abs(labels[0].top - labels[1].top) <= 1 };
    });
    assert.deepEqual(frames, { ordered: true, contained: true, imageSettingsInside: true, labelsOneRow: true }, `${width}px: field order and shared frames`);
  }
  await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  const saved = queue.pageBuilder.read(job.id).document.common.blocks[0];
  assert.equal(saved.items[0].title, 'Снимок'); assert.equal(saved.items[0].text, '**Описание**'); assert.equal(saved.items[0].image_asset_id, saved.media[0].id);
  assert.equal(saved.items[0].link_text, 'Подробнее'); assert.equal(saved.meta.columns, 4); assert.ok(saved.media[0].originalMedia);
  assert.deepEqual([saved.meta.media_mode, saved.meta.media_align, saved.meta.media_width], ['fill', 'end', 640]);
  assert.deepEqual(Object.keys(saved.items[0].meta), [], 'cleared item overrides inherit block image settings');
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator(`#builder-item-${itemId}-title`).inputValue(), 'Снимок');
  assert.equal(await page.locator('.builder-gallery-item .builder-media-image').count(), 1);
  const reopenedGallery = page.locator('.builder-gallery-item').first().locator(':scope > .builder-item-details');
  assert.equal(await reopenedGallery.getAttribute('open'), null); assert.equal(await reopenedGallery.locator(':scope > summary').innerText(), 'Снимок');
  assert.deepEqual(await reopenedGallery.locator('.builder-gallery-item-body > details').evaluateAll(nodes => nodes.map(node => node.open)), [false, false, false], 'item and nested sections reopen collapsed');
  const galleryIds = await page.locator('.builder-gallery-item').evaluateAll(nodes => nodes.map(node => node.dataset.itemId));
  await page.locator('#builder-add-gallery-item').click(); const addedGalleryId = await page.locator('.builder-gallery-item').last().getAttribute('data-item-id');
  await page.locator('.builder-gallery-item').last().locator('.builder-link-drag').focus(); await page.keyboard.press('ArrowUp');
  assert.deepEqual(await page.locator('.builder-gallery-item').evaluateAll(nodes => nodes.map(node => node.dataset.itemId)), [addedGalleryId, ...galleryIds]);
  const addedGallery = page.locator(`.builder-gallery-item[data-item-id="${addedGalleryId}"]`);
  await addedGallery.locator(':scope > details').evaluate(node => { window.galleryItemDeleteToggles = 0; node.addEventListener('toggle', () => { window.galleryItemDeleteToggles++; }); });
  await addedGallery.locator(':scope > .builder-image-tools .builder-delete').click(); assert.equal(await page.evaluate(() => window.galleryItemDeleteToggles), 0); assert.equal(await page.locator('.builder-gallery-item').count(), 1);
  for (let index = 1; index < 13; index++) await page.locator('#builder-add-gallery-item').click();
  assert.equal(await page.locator('.builder-gallery-item').count(), 13);
  const gridDefaults = {
    default: ['auto', 'contain', false], gallery: ['auto', 'contain', false], catalog: ['auto', 'contain', true], compact: ['auto', 'contain', false],
    promo: ['3x2', 'cover', true], news: ['3x2', 'cover', true], services: ['4x3', 'cover', true], list: ['auto', 'cover', true]
  };
  for (const [view, [ratio, fit, border]] of Object.entries(gridDefaults)) {
    await page.locator('#builder-view').selectOption(view);
    assert.equal(await page.locator('.builder-editor-placeholder').count(), 0, `${view}: uses the grid item editor`);
    assert.equal(await page.locator('.builder-gallery-item').count(), 13, `${view}: keeps all items`);
    assert.equal(await page.locator(`#builder-item-${itemId}-title`).inputValue(), 'Снимок', `${view}: keeps item fields`);
    assert.equal(await page.locator('#builder-grid-image_ratio').inputValue(), ratio, `${view}: renderer ratio default`);
    assert.equal(await page.locator('#builder-grid-image_fit').inputValue(), fit, `${view}: renderer fit default`);
    assert.equal(await page.locator('#builder-grid-show_border').isChecked(), border, `${view}: renderer border default`);
    assert.equal(await page.locator('.builder-gallery-item').first().locator(':scope > .builder-item-details').getAttribute('open'), null, `${view}: whole item starts collapsed`);
    assert.deepEqual(await page.locator('.builder-gallery-item').first().locator('.builder-gallery-item-body > details').evaluateAll(nodes => nodes.map(node => node.open)), [false, false, false], `${view}: nested item sections start collapsed`);
  }
  await page.locator('#builder-view').selectOption('catalog');
  await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  const catalog = queue.pageBuilder.read(job.id).document.common.blocks[0];
  assert.equal(catalog.view, 'catalog'); assert.equal(catalog.items.length, 13); assert.equal(catalog.media.length, 13);
  assert.deepEqual(catalog.items[0], saved.items[0], 'catalog view preserves gallery item content and image reference');
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('#builder-view').inputValue(), 'catalog');
  assert.equal(await page.locator('.builder-gallery-item').count(), 13);
  assert.equal(await page.locator(`#builder-item-${itemId}-title`).inputValue(), 'Снимок');
  await page.locator('.builder-gallery-item').first().locator(':scope > .builder-item-details > summary').click();
  await page.locator('.builder-gallery-item').first().getByText('Изображение', { exact: true }).click();
  assert.equal(await page.locator('.builder-gallery-item .builder-media-image').first().count(), 1);
  assert.deepEqual(errors, []);
});

test('step 3 table editor manages collapsed rows, cells and pooled images with stable responsive persistence', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-table-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], external = [], origin = `http://127.0.0.1:${server.address().port}`; page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
  await page.goto(origin); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show'); await page.locator('#builder-type').selectOption('table');
  assert.deepEqual(await page.locator('.builder-content-fields > *').evaluateAll(nodes => nodes.map(node => node.className)), ['builder-text-fields', 'builder-images-section builder-table-section', 'builder-banner-advanced builder-table-advanced']);
  assert.equal(await page.locator('.builder-editor-placeholder').count(), 0); await page.locator('#builder-add-table-row').click();
  let rows = page.locator('.builder-table-row'); assert.equal(await rows.count(), 1, JSON.stringify({ errors, formError: await page.locator('#page-builder-form-error').textContent() })); assert.equal(await rows.first().locator(':scope > details').evaluate(node => node.open), false); assert.equal(await rows.first().locator(':scope > details > summary').innerText(), 'Строка');
  const assertToolsGeometry = async (shell, width, label, expectedOrder) => {
    await page.setViewportSize({ width, height: 1000 }); await shell.scrollIntoViewIfNeeded();
    const geometry = await shell.evaluate(node => {
      const summary = node.querySelector(':scope > details > summary'), remove = node.querySelector(':scope > .builder-image-tools > .builder-delete'), drag = node.querySelector(':scope > .builder-image-tools > .builder-media-drag'), controls = node.querySelector(':scope > .builder-image-tools');
      const range = document.createRange(); range.selectNodeContents(summary); const rect = item => item.getBoundingClientRect();
      return { shell: rect(node), summary: rect(summary), title: range.getBoundingClientRect(), remove: rect(remove), drag: rect(drag), listStyleType: getComputedStyle(summary).listStyleType,
        order: [...controls.children].map(button => button.classList.contains('builder-delete') ? 'delete' : button.classList.contains('builder-media-drag') ? 'drag' : 'other'), client: node.clientWidth, scroll: node.scrollWidth };
    });
    assert.notEqual(geometry.listStyleType, 'none', `${width}px: ${label} keeps its native disclosure marker`); assert.equal(geometry.title.left > geometry.summary.left, true, `${width}px: ${label} title follows the native disclosure ${JSON.stringify(geometry)}`);
    const controlRect = name => geometry[name === 'delete' ? 'remove' : name], first = controlRect(expectedOrder[0]), second = controlRect(expectedOrder[1]);
    assert.deepEqual(geometry.order, expectedOrder, `${width}px: ${label} keeps its control order`); assert.equal(geometry.title.right <= first.left + 1 && first.right <= second.left + 1 && second.right <= geometry.shell.right + 1, true, `${width}px: ${label} title and actions do not overlap ${JSON.stringify(geometry)}`); assert.equal(geometry.scroll <= geometry.client + 1, true, `${width}px: ${label} header fits ${JSON.stringify(geometry)}`);
  };
  for (const width of [1440, 390, 375, 360, 320]) await assertToolsGeometry(rows.first(), width, 'row', ['drag', 'delete']); await page.setViewportSize({ width: 1440, height: 1000 });
  const firstRowId = await rows.first().getAttribute('data-row-id'), rowSummary = rows.first().locator(':scope > details > summary'); await rowSummary.focus(); await page.keyboard.press('Enter'); assert.equal(await rows.first().locator(':scope > details').evaluate(node => node.open), true, 'native row summary opens with Enter'); await page.keyboard.press('Enter'); assert.equal(await rows.first().locator(':scope > details').evaluate(node => node.open), false); await page.keyboard.press('Space'); assert.equal(await rows.first().locator(':scope > details').evaluate(node => node.open), true, 'native row summary opens with Space'); await page.keyboard.press('Space'); assert.equal(await rows.first().locator(':scope > details').evaluate(node => node.open), false); await rowSummary.click(); assert.equal(await rows.first().locator(':scope > details').evaluate(node => node.open), true, 'row summary still toggles by click');
  let cells = rows.first().locator('.builder-table-cell'); assert.equal(await cells.count(), 1); assert.equal(await cells.first().locator(':scope > details').evaluate(node => node.open), false); assert.equal(await cells.first().locator(':scope > details > summary').innerText(), 'Ячейка');
  for (const width of [1440, 390, 375, 360, 320]) await assertToolsGeometry(cells.first(), width, 'cell', ['delete', 'drag']); await page.setViewportSize({ width: 1440, height: 1000 });
  const firstCellId = await cells.first().getAttribute('data-cell-id'); await cells.first().locator(':scope > details > summary').click(); assert.equal(await cells.first().locator(':scope > details').evaluate(node => node.open), true, 'cell summary still toggles by click');
  assert.deepEqual(await cells.first().locator('.builder-table-cell-body > *').evaluateAll(nodes => nodes.map(node => node.tagName.toLowerCase())), ['input', 'details', 'details', 'details', 'details']);
  assert.deepEqual(await cells.first().locator('.builder-table-cell-body > details').evaluateAll(nodes => nodes.map(node => ({ summary: node.querySelector(':scope > summary').textContent, open: node.open }))), [
    { summary: 'Текст', open: false }, { summary: 'Изображения', open: false }, { summary: 'Ссылка', open: false }, { summary: 'Настройки ячейки', open: false }
  ]);
  const title = cells.first().locator(`#builder-cell-${firstCellId}-title`), textDetails = cells.first().locator('.builder-table-cell-text'), text = textDetails.locator(`#builder-cell-${firstCellId}-text`);
  assert.equal(await textDetails.locator('.builder-markdown-tools').isVisible(), false); assert.equal(await text.isVisible(), false); assert.equal(await text.getAttribute('aria-label'), 'Текст в Markdown'); assert.equal(await text.getAttribute('maxlength'), '12000'); await textDetails.locator(':scope > summary').click(); assert.equal(await textDetails.locator('.builder-markdown-tools').isVisible(), true); await title.fill('Основная ячейка'); await text.fill('**Короткий текст**'); assert.equal(await textDetails.locator('.builder-markdown-preview strong').innerText(), 'Короткий текст'); assert.equal(await cells.first().locator(':scope > details > summary').innerText(), 'Основная ячейка'); await title.fill(''); assert.equal(await cells.first().locator(':scope > details > summary').innerText(), 'Ячейка'); await title.fill('Основная ячейка'); assert.equal(await cells.first().locator(':scope > details > summary').innerText(), 'Основная ячейка');
  await rows.first().locator('.builder-table-add-cell').click(); rows = page.locator(`[data-row-id="${firstRowId}"]`); assert.equal(await rows.locator(':scope > details').evaluate(node => node.open), true); cells = rows.locator('.builder-table-cell');
  assert.equal(await cells.count(), 2);
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await rows.locator('.builder-table-add-cell').scrollIntoViewIfNeeded(); const gap = await rows.evaluate(node => { const body = node.querySelector('.builder-table-row-body'), last = node.querySelector('.builder-table-cells > .builder-table-cell:last-child').getBoundingClientRect(), add = node.querySelector('.builder-table-add-cell').getBoundingClientRect(); return { actual: add.top - last.bottom, expected: parseFloat(getComputedStyle(body).rowGap) }; }); assert.ok(Math.abs(gap.actual - gap.expected) <= 1, `${width}px: add-cell uses one standard gap ${JSON.stringify(gap)}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); const secondCellId = await cells.nth(1).getAttribute('data-cell-id'); await cells.nth(1).locator(':scope > details > summary').click(); await cells.nth(1).locator(`#builder-cell-${secondCellId}-title`).fill('Временная ячейка');
  await cells.nth(1).locator('.builder-table-cell-drag').focus(); await page.keyboard.press('ArrowUp');
  assert.deepEqual(await rows.locator('.builder-table-cell').evaluateAll(nodes => nodes.map(node => node.dataset.cellId)), [secondCellId, firstCellId]);
  assert.equal(await rows.locator(':scope > details').evaluate(node => node.open), true, 'cell keyboard move keeps its row open'); assert.equal(await rows.locator(`[data-cell-id="${secondCellId}"] > details`).evaluate(node => node.open), true, 'cell keyboard move keeps the moved cell open'); assert.equal(await page.evaluate(id => document.activeElement?.closest('.builder-table-cell')?.dataset.cellId === id, secondCellId), true, 'cell handle keeps visible focus after move');
  await page.keyboard.press('ArrowDown'); assert.deepEqual(await rows.locator('.builder-table-cell').evaluateAll(nodes => nodes.map(node => node.dataset.cellId)), [firstCellId, secondCellId]); assert.equal(await page.evaluate(id => document.activeElement?.closest('.builder-table-cell')?.dataset.cellId === id, secondCellId), true, 'the same focused cell handle accepts a repeated move'); await page.keyboard.press('ArrowUp'); assert.deepEqual(await rows.locator('.builder-table-cell').evaluateAll(nodes => nodes.map(node => node.dataset.cellId)), [secondCellId, firstCellId]);
  await rows.locator(`[data-cell-id="${secondCellId}"] > details`).evaluate(node => { window.tableCellDeleteToggles = 0; node.addEventListener('toggle', () => { window.tableCellDeleteToggles++; }); }); await rows.locator(`[data-cell-id="${secondCellId}"] .builder-delete`).click(); assert.equal(await page.evaluate(() => window.tableCellDeleteToggles), 0, 'cell delete does not toggle its disclosure'); rows = page.locator(`[data-row-id="${firstRowId}"]`); await rows.locator(':scope > details > summary').click(); cells = rows.locator('.builder-table-cell'); await cells.first().locator(':scope > details > summary').click();
  const images = cells.first().locator('.builder-table-cell-images'); await images.locator(':scope > summary').click();
  for (let index = 0; index < 3; index++) await images.getByRole('button', { name: 'Добавить изображение', exact: true }).click();
  let mediaRows = images.locator('.builder-image-row'); const mediaIds = await mediaRows.evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)); assert.equal(mediaIds.length, 3);
  await mediaRows.nth(2).locator('.builder-media-drag').focus(); await page.keyboard.press('ArrowUp'); assert.deepEqual(await images.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), [mediaIds[0], mediaIds[2], mediaIds[1]]); assert.equal(await page.evaluate(id => document.activeElement?.closest('.builder-image-row')?.dataset.mediaId === id, mediaIds[2]), true);
  await images.locator('.builder-image-row').nth(1).getByRole('button', { name: 'Удалить изображение 2' }).click(); assert.deepEqual(await images.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), [mediaIds[0], mediaIds[1]]);
  await cells.first().locator('.builder-table-cell-link > summary').click(); await cells.first().locator(`#builder-cell-${firstCellId}-link`).fill('/table-cell');
  await cells.first().locator('.builder-table-cell-settings > summary').click(); await cells.first().locator(`#builder-cell-${firstCellId}-align`).selectOption('right'); await cells.first().locator(`#builder-cell-${firstCellId}-media_mode`).selectOption('fill'); await cells.first().locator(`#builder-cell-${firstCellId}-media_align`).selectOption('end'); await cells.first().locator(`#builder-cell-${firstCellId}-colspan`).fill('2'); await cells.first().locator(`#builder-cell-${firstCellId}-rowspan`).fill('3'); await cells.first().locator(`#builder-cell-${firstCellId}-is_header`).check();
  const revisionBeforeInvalid = queue.pageBuilder.read(job.id).revision; await cells.first().locator(`#builder-cell-${firstCellId}-media_width`).fill('10'); await page.locator('#page-builder-save').click(); assert.equal(queue.pageBuilder.read(job.id).revision, revisionBeforeInvalid, 'invalid browser-bounded settings do not write'); await cells.first().locator(`#builder-cell-${firstCellId}-media_width`).fill('320');
  await page.locator('#builder-add-table-row').click(); rows = page.locator('.builder-table-row'); const secondRowId = await rows.nth(1).getAttribute('data-row-id'); await rows.nth(1).locator(':scope > details > summary').click(); await rows.nth(1).locator('.builder-table-cell-details > summary').click(); await rows.nth(1).locator('.builder-table-cell-images > summary').click(); await rows.nth(1).getByRole('button', { name: 'Добавить изображение', exact: true }).click(); const deletedRowMediaId = await rows.nth(1).locator('.builder-image-row').getAttribute('data-media-id');
  await rows.nth(1).locator('.builder-table-row-drag').focus(); await page.keyboard.press('ArrowUp'); assert.deepEqual(await page.locator('.builder-table-row').evaluateAll(nodes => nodes.map(node => node.dataset.rowId)), [secondRowId, firstRowId]); assert.equal(await page.locator(`[data-row-id="${secondRowId}"] > details`).evaluate(node => node.open), true, 'row keyboard move keeps the moved row open'); assert.equal(await page.evaluate(id => document.activeElement?.closest('.builder-table-row')?.dataset.rowId === id, secondRowId), true, 'row handle keeps visible focus after move'); await page.keyboard.press('ArrowDown'); assert.deepEqual(await page.locator('.builder-table-row').evaluateAll(nodes => nodes.map(node => node.dataset.rowId)), [firstRowId, secondRowId]); assert.equal(await page.evaluate(id => document.activeElement?.closest('.builder-table-row')?.dataset.rowId === id, secondRowId), true, 'the same focused row handle accepts a repeated move'); rows = page.locator('.builder-table-row');
  await rows.nth(1).locator('.builder-table-row-drag').dragTo(rows.first(), { targetPosition: { x: 10, y: 5 } }); assert.equal(await page.locator('.builder-table-row').first().getAttribute('data-row-id'), secondRowId, 'mouse drag reorders rows');
  await page.locator(`[data-row-id="${secondRowId}"] > details`).evaluate(node => { window.tableRowDeleteToggles = 0; node.addEventListener('toggle', () => { window.tableRowDeleteToggles++; }); }); await page.locator(`[data-row-id="${secondRowId}"] > .builder-image-tools .builder-delete`).click(); assert.equal(await page.evaluate(() => window.tableRowDeleteToggles), 0, 'row delete does not toggle its disclosure'); assert.deepEqual(await page.locator('.builder-table-row').evaluateAll(nodes => nodes.map(node => node.dataset.rowId)), [firstRowId]);
  await page.locator('.builder-table-advanced > summary').click(); await page.locator('#builder-show_border').check();
  await page.locator('#builder-type').selectOption('content'); await page.locator('#builder-type').selectOption('table'); assert.equal(await page.locator('.builder-table-row').count(), 1); assert.equal(await page.locator(`[data-cell-id="${firstCellId}"] > details > summary`).textContent(), 'Основная ячейка'); assert.equal(await page.locator('.builder-table-row-details').evaluate(node => node.open), false); assert.equal(await page.locator('.builder-table-cell-text').evaluate(node => node.open), false); assert.equal(await page.locator(`#builder-cell-${firstCellId}-text`).inputValue(), '**Короткий текст**', 'table type draft restores the Markdown source'); assert.equal(await page.locator('.builder-table-cell-images').evaluate(node => node.open), false); assert.equal(await page.locator('.builder-table-cell-images .builder-image-row').count(), 2, 'restored images remain in the closed section');
  await page.locator('.builder-table-row-details > summary').click(); await page.locator('.builder-table-cell-details > summary').click(); await page.locator('.builder-table-cell-text > summary').click(); await page.locator('.builder-table-cell-images > summary').click(); await page.locator('.builder-table-cell-link > summary').click(); await page.locator('.builder-table-cell-settings > summary').click();
  for (const width of [1440, 390, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await page.locator('.builder-table-cell-images').scrollIntoViewIfNeeded(); const geometry = await page.locator('#page-builder-modal .modal-body').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth })); assert.equal(geometry.scroll <= geometry.client, true, `${width}px: table editor has no horizontal overflow ${JSON.stringify(geometry)}`);
    const internals = await page.locator('.builder-table-row-details, .builder-table-row-body, .builder-table-cell-details, .builder-table-cell-body, .builder-table-cell-text, .builder-table-cell-images, .builder-table-cell-link, .builder-table-cell-settings, .builder-media-form').evaluateAll(nodes => nodes.map(node => ({ className: node.className, client: node.clientWidth, scroll: node.scrollWidth })));
    assert.equal(internals.every(item => item.scroll <= item.client + 1), true, `${width}px: expanded internals fit ${JSON.stringify(internals)}`);
    const sizes = await page.locator('.builder-table-cell-images').evaluate(node => ({ media: Math.min(...[...node.querySelectorAll('.builder-media-form')].map(item => item.getBoundingClientRect().width)), preview: Math.min(...[...node.querySelectorAll('.builder-image-preview-button')].map(item => item.getBoundingClientRect().width)), control: Math.min(...[...node.querySelectorAll('.builder-image-tools .btn')].map(item => item.getBoundingClientRect().width)) }));
    assert.ok(sizes.media >= 140 && sizes.preview >= 54 && sizes.control >= 30, `${width}px: expanded image controls remain usable ${JSON.stringify(sizes)}`);
    const hints = await page.locator('.builder-table-cell-images .builder-image-preview-hint, .builder-table-cell-images .builder-image-preview-hint-text').evaluateAll(nodes => nodes.map(node => ({ client: node.clientWidth, scroll: node.scrollWidth })));
    assert.equal(hints.every(item => item.scroll <= item.client + 1), true, `${width}px: preview hints fit without clipping ${JSON.stringify(hints)}`);
  }
  await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  const saved = queue.pageBuilder.read(job.id).document.common.blocks[0], savedCell = saved.rows[0].cells[0];
  assert.equal(saved.show_border, true); assert.equal(saved.rows.length, 1); assert.equal(saved.rows[0].id, firstRowId); assert.equal(savedCell.id, firstCellId); assert.equal(savedCell.title, 'Основная ячейка'); assert.equal(savedCell.text, '**Короткий текст**'); assert.equal(savedCell.link, '/table-cell'); assert.deepEqual(savedCell.image_asset_ids, [mediaIds[0], mediaIds[1]]); assert.equal(saved.image_asset_id, undefined); assert.deepEqual(saved.media.map(asset => asset.id), [mediaIds[0], mediaIds[1]]); assert.equal(saved.media.some(asset => asset.id === deletedRowMediaId), false, 'deleting a row removes only its unshared image from the pool'); assert.deepEqual(savedCell.meta, { align: 'right', media_mode: 'fill', media_align: 'end', colspan: 2, rowspan: 3, is_header: true, media_width: 320 });
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show'); assert.equal(await page.locator('.builder-table-row-details').evaluate(node => node.open), false); await page.locator('.builder-table-row-details > summary').click(); assert.equal(await page.locator('.builder-table-cell-details').evaluate(node => node.open), false); assert.equal(await page.locator('.builder-table-cell-details > summary').innerText(), 'Основная ячейка'); await page.locator('.builder-table-cell-details > summary').click(); assert.equal(await page.locator('.builder-table-cell-text').evaluate(node => node.open), false); assert.equal(await page.locator(`#builder-cell-${firstCellId}-text`).inputValue(), '**Короткий текст**'); assert.deepEqual(errors, []); assert.deepEqual(external, [], 'the table Markdown editor makes no external requests');
});

test('table type drafts keep their large pool while non-table saves discard it', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-table-pool-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  const initial = queue.pageBuilder.read(job.id), document = structuredClone(initial.document), media = Array.from({ length: 13 }, (_, index) => ({ id: `table-pool-${index + 1}`, originalUrl: '', bigUrl: '', href: '', alt: '', caption: '' }));
  Object.assign(document.common.blocks[0], { type: 'table', view: 'default', media, meta: {}, rows: [{ id: 'table-pool-row', cells: [
    { id: 'table-pool-cell-many', title: 'Много изображений', text: '', link: '', image_asset_ids: media.slice(0, 12).map(asset => asset.id), meta: {} },
    { id: 'table-pool-cell-one', title: 'Одно изображение', text: '', link: '', image_asset_id: media[12].id, meta: {} }
  ] }] });
  queue.pageBuilder.write(job.id, initial.revision, document); const savedTableBlock = structuredClone(queue.pageBuilder.read(job.id).document.common.blocks[0]);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), posts = []; page.on('response', response => { if (response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/page-builder/${job.id}`) posts.push(response.status()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const open = async () => { await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show'); };
  const close = async () => { await page.waitForSelector('#page-builder-modal', { state: 'hidden' }); await page.waitForSelector('.modal-backdrop', { state: 'hidden' }); };
  await open(); assert.equal(await page.locator('.builder-table-cell-images .builder-image-row').count(), 13);
  await page.locator('#builder-type').selectOption('links'); assert.equal(await page.locator('.builder-image-row').count(), 0, 'a fresh links draft does not render the table pool');
  await page.locator('#builder-type').selectOption('table'); assert.equal(await page.locator('.builder-table-cell-images .builder-image-row').count(), 13, 'the table draft restores its ordered pool');
  await page.locator('#builder-type').selectOption('links'); await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].type, 'table'); assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].media.length, 13, 'cancel leaves the durable table intact');
  await open(); await page.locator('#builder-type').selectOption('links'); await page.locator('#page-builder-save').click(); await close();
  let stored = queue.pageBuilder.read(job.id), block = stored.document.common.blocks[0]; assert.equal(block.type, 'links'); assert.deepEqual(block.media, []); assert.deepEqual(posts, [200], 'links saves without the hidden over-limit table pool');
  const restored = structuredClone(stored.document); restored.common.blocks[0] = structuredClone(savedTableBlock); queue.pageBuilder.write(job.id, stored.revision, restored); await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await open(); assert.equal(await page.locator('.builder-table-cell-images .builder-image-row').count(), 13); await page.locator('#builder-type').selectOption('data-table'); assert.equal(await page.locator('#builder-add-data-column').count(), 1); assert.equal(await page.locator('.builder-image-row').count(), 0);
  await page.locator('#page-builder-save').click(); await close(); stored = queue.pageBuilder.read(job.id); block = stored.document.common.blocks[0]; assert.equal(block.type, 'data-table'); assert.deepEqual(block.media, []); assert.deepEqual(posts, [200, 200], 'data-table also saves without hidden table media');
});

test('step 3 type and view changes keep drafts and expose every structured editor', { timeout: 45000 }, async t => {
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
  const typeLabels = await page.locator('#builder-type option').allTextContents();
  assert.equal(typeLabels.length, 10);
  assert.deepEqual(typeLabels, original.blockTypes.map(type => type.label));
  assert.equal(typeLabels.some(label => label.includes('✓')), false);
  assert.equal(typeLabels.find(label => label.includes('Ссылки и документы')), 'Ссылки и документы');
  assert.equal(original.blockTypes.find(type => type.name === 'big-media').label, 'Изображение / баннер', 'API catalog label stays canonical');
  assert.equal(original.blockTypes.find(type => type.name === 'service').label, 'Описание услуги');
  assert.equal(original.blockTypes.find(type => type.name === 'embed').label, 'Видео, карта или виджет');
  for (const type of original.blockTypes) {
    await page.locator('#builder-type').selectOption(type.name);
    for (const view of type.views) {
      await page.locator('#builder-view').focus();
      await page.locator('#builder-view').selectOption(view);
      assert.match(await page.locator('#builder-view option:checked').innerText(), /[А-Яа-я]/, `${type.name}/${view}: descriptive Russian view name`);
      assert.equal(await page.locator('#builder-view').evaluate(node => node === document.activeElement), true, 'changing view keeps the selector focused');
      if (type.name === 'data-table') { assert.equal(await page.locator('.builder-editor-placeholder').count(), 0); assert.equal(await page.locator('#builder-add-data-column').count(), 1); }
      if (type.name === 'table') { assert.equal(await page.locator('.builder-editor-placeholder').count(), 0); assert.equal(await page.locator('#builder-add-table-row').count(), 1); }
      if (type.name === 'grid') { assert.equal(await page.locator('.builder-editor-placeholder').count(), 0); assert.equal(await page.locator('#builder-add-gallery-item').count(), 1); }
    }
  }
  await page.locator('#builder-type').selectOption('service'); await page.locator('#builder-badge').fill('Черновик метки'); await page.locator('#builder-content').fill('Черновик текста');
  await page.locator('#builder-view').selectOption('media-left'); assert.equal(await page.locator('#builder-images-title').innerText(), 'Изображения слева');
  await page.locator('#builder-view').selectOption('media-right'); assert.equal(await page.locator('#builder-images-title').innerText(), 'Изображения справа');
  assert.equal(await page.locator('#builder-badge').inputValue(), 'Черновик метки'); assert.equal(await page.locator('#builder-content').inputValue(), 'Черновик текста');
  await page.locator('#builder-type').selectOption('embed');
  assert.deepEqual(await page.locator('.builder-content-fields > *').evaluateAll(nodes => nodes.map(node => node.className)), ['builder-embed-section', 'builder-text-fields', 'builder-banner-advanced']);
  assert.deepEqual(await page.locator('.builder-embed-inputs label').allInnerTexts(), []);
  assert.equal(await page.locator('.builder-embed-preview iframe').count(), 0);
  assert.equal(await page.locator('.builder-embed-preview img').count(), 0);
  await page.locator('.builder-banner-advanced summary').click(); await page.locator('#builder-ratio').selectOption('4:3');
  assert.deepEqual(await page.locator('#builder-provider option').allTextContents(), ['Не задано', 'Виджет (iframe)', 'Карта', 'Видео', 'Другой источник']);
  await page.locator('#builder-view').selectOption('map'); assert.equal(await page.locator('#builder-ratio').count(), 0); assert.equal(await page.locator('#builder-source_url').count(), 0);
  assert.equal(await page.locator('#builder-meta-map_height').inputValue(), '420');
  await page.locator('.builder-banner-advanced summary').click(); await page.locator('#builder-meta-map_height').fill('560');
  await page.locator('#builder-view').selectOption('wide'); assert.equal(await page.locator('#builder-ratio').inputValue(), '4:3');
  await page.locator('#builder-view').selectOption('map'); assert.equal(await page.locator('#builder-meta-map_height').inputValue(), '560');
  await page.locator('#builder-type').selectOption('rich-content'); assert.equal(await page.getByRole('textbox', { name: 'HTML', exact: true }).getAttribute('contenteditable'), 'true'); assert.equal(await page.getByLabel('Обоснование', { exact: true }).getAttribute('required'), '');
  await page.locator('#builder-type').selectOption('service'); assert.equal(await page.locator('#builder-view').inputValue(), 'default'); assert.equal(await page.locator('#builder-badge').inputValue(), 'Черновик метки');
  assert.equal(await page.locator('.builder-image-row').count(), Math.max(2, original.document.common.blocks[0].media.length), 'service slots and hidden media survive type/view switches');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close(); assert.deepEqual(queue.pageBuilder.read(job.id), original, 'type and view exploration never writes data');
  // A legacy structured block can still update its real common fields and review;
  // its existing text, media and settings are not replaced by pretend rows/items.
  const structured = structuredClone(original.document); Object.assign(structured.common.blocks[0], { type: 'grid', view: 'gallery' }); queue.pageBuilder.write(job.id, original.revision, structured);
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)'); await opener.click();
  assert.equal(await page.locator('.builder-editor-placeholder').count(), 0); assert.equal(await page.locator('#builder-add-gallery-item').count(), 1);
  for (const width of [1440, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await page.locator('#builder-add-gallery-item').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#page-builder-modal .modal-body').evaluate(node => node.scrollWidth <= node.clientWidth), true, `${width}: gallery editor has no horizontal overflow`);
  }
  await page.locator('#builder-title').fill('Галерея с новым заголовком'); await page.locator('#builder-review-status').selectOption('passed'); await page.locator('#page-builder-save').click(); await close();
  const saved = queue.pageBuilder.read(job.id).document.common.blocks[0];
  assert.equal(saved.review.status, 'passed'); assert.equal(saved.title, 'Галерея с новым заголовком');
  for (const field of ['text', 'content', 'settings', 'media']) assert.deepEqual(saved[field], original.document.common.blocks[0][field], `${field} survives a structured block edit`);
  assert.deepEqual(errors, []);
});

test('step 3 sections editor saves nested items, order and settings without image controls', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-sections-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show');
  const tablePatterns = await tableCellDisclosurePatterns(page); await page.locator('#builder-type').selectOption('sections');
  assert.deepEqual(await page.locator('#page-builder-fields > *').evaluateAll(nodes => nodes.slice(0, 3).map(node => node.className)), ['builder-type-view', 'mb-3', 'builder-content-fields']);
  assert.deepEqual(await page.locator('.builder-content-fields > *').evaluateAll(nodes => nodes.map(node => node.className)), ['builder-text-fields', 'builder-images-section builder-sections-section', 'builder-banner-advanced builder-sections-advanced']);
  assert.equal(await page.locator('.builder-editor-placeholder, #builder-add-image, .builder-media-picker').count(), 0);
  await page.locator('#builder-title').fill('Разделы'); await page.locator('#builder-content').fill('Описание');
  await page.locator('#builder-add-section-item').click();
  const first = page.locator('.builder-section-item').first(), firstItem = first.locator(':scope > .builder-item-details'), firstSummary = firstItem.locator(':scope > summary');
  assert.equal(await firstItem.getAttribute('open'), null); assert.equal(await firstSummary.innerText(), 'Элемент');
  assert.equal(await first.getByRole('button', { name: 'Перетащить элемент 1' }).isEnabled(), true); assert.equal(await first.getByRole('button', { name: 'Удалить элемент 1' }).isEnabled(), true);
  assert.deepEqual(await disclosurePattern(first), tablePatterns[1440], 'section item uses the table-cell disclosure geometry and control order');
  await firstSummary.focus(); await page.keyboard.press('Space'); assert.equal(await firstItem.getAttribute('open'), '');
  await first.getByPlaceholder('Заголовок').fill('Группа'); assert.equal(await firstSummary.innerText(), 'Группа');
  for (const view of ['list', 'columns', 'contacts']) {
    await page.locator('#builder-view').selectOption(view);
    const sectionText = first.locator('.builder-item-markdown');
    assert.equal(await sectionText.getAttribute('open'), null, `${view}: section Markdown is collapsed by default`);
    assert.equal(await sectionText.locator(':scope > summary').textContent(), 'Текст');
    assert.equal(await sectionText.getByLabel('Текст в Markdown').getAttribute('placeholder'), 'Текст в Markdown');
    assert.equal(await first.evaluate(node => node.scrollWidth <= node.clientWidth), true, `${view}: collapsed section Markdown has no horizontal overflow`);
    assert.deepEqual(await first.locator('.builder-section-link label').allTextContents(), ['Ссылка', 'Текст ссылки'], `${view}: link inputs have separate labels`);
    assert.equal(await first.locator('.builder-section-link legend, .builder-section-link fieldset').count(), 0, `${view}: link inputs have no shared fieldset`);
  }
  await page.locator('#builder-view').selectOption('list');
  await first.locator(':scope > .builder-item-details > summary').click();
  await first.locator('.builder-item-markdown > summary').click(); await first.getByLabel('Текст в Markdown').fill('**Группа**');
  assert.equal(await first.locator('.builder-markdown-preview strong').innerText(), 'Группа');
  await page.locator('.builder-section-add-child').first().click();
  const child = page.locator('.builder-section-item').nth(1); await child.locator(':scope > .builder-item-details > summary').click(); await child.getByPlaceholder('Заголовок').fill('Почта');
  await child.getByPlaceholder('URL').fill('mailto:office@example.com'); await child.getByPlaceholder('Текст ссылки').fill('office@example.com');
  await child.getByLabel('Тип элемента').selectOption('email');
  await page.locator('#builder-add-section-item').click(); await page.locator('.builder-section-item').last().locator(':scope > .builder-item-details > summary').click(); await page.locator('.builder-section-item').last().getByPlaceholder('Заголовок').fill('Вторая группа');
  await page.locator('.builder-section-item').last().locator('.builder-section-drag').focus(); await page.keyboard.press('ArrowUp');
  await page.locator('#builder-view').selectOption('contacts'); await page.locator('#builder-view').selectOption('list');
  assert.equal(await page.locator('.builder-section-item').count(), 3, 'view changes keep the nested draft');
  await page.locator('.builder-sections-advanced summary').click(); await page.locator('#builder-sections-columns').selectOption('4');
  await page.locator('#builder-sections-compact').check(); await page.locator('#builder-sections-show_icons').check();
  await page.locator('#builder-type').selectOption('content'); await page.locator('#builder-type').selectOption('sections');
  assert.equal(await page.locator('#builder-view').inputValue(), 'list');
  assert.equal(await page.locator('.builder-section-item').count(), 3, 'type changes keep the nested draft');
  await page.locator('.builder-sections-advanced summary').click();
  assert.equal(await page.locator('#builder-sections-columns').inputValue(), '4');
  assert.equal(await page.locator('#builder-sections-compact').isChecked(), true);
  for (let depth = 3; depth <= 6; depth++) {
    await page.locator('.builder-section-item').last().evaluate(row => row.nextElementSibling.querySelector(':scope > .builder-section-add-child').click());
    await page.locator('.builder-section-item').last().locator(':scope > .builder-item-details > summary').click();
    await page.locator('.builder-section-item').last().getByPlaceholder('Заголовок').fill(`Вложенность ${depth}`);
  }
  assert.equal(await page.locator('.builder-section-item').count(), 7);
  await page.locator('.builder-section-item').first().locator(':scope > .builder-item-details > summary').click();
  for (const width of disclosureWidths) {
    await page.setViewportSize({ width, height: 1000 });
    assert.deepEqual(await disclosurePattern(page.locator('.builder-section-item').first()), tablePatterns[width], `${width}px: section disclosure matches the table cell`);
    const geometry = await page.locator('#page-builder-modal .modal-body').evaluate(node => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    assert.ok(geometry.scrollWidth <= geometry.clientWidth, `${width}: depth-6 sections editor has no horizontal overflow (${JSON.stringify(geometry)})`);
  }
  await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  const saved = queue.pageBuilder.read(job.id).document.common.blocks[0];
  assert.equal(saved.type, 'sections'); assert.equal(saved.view, 'list'); assert.deepEqual(saved.meta, { columns: 4, compact: true, show_icons: true });
  assert.deepEqual(saved.items.map(item => item.title), ['Вторая группа', 'Группа']);
  assert.equal(saved.items[1].children[0].meta.kind, 'email'); assert.equal(saved.items[1].children[0].link, 'mailto:office@example.com');
  assert.deepEqual(saved.media, []);
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show');
  const reopenedId = await page.locator('.builder-section-title').evaluateAll(inputs => inputs.find(input => input.value === 'Почта')?.closest('.builder-section-item')?.dataset.itemId);
  const reopened = page.locator(`.builder-section-item[data-item-id="${reopenedId}"]`);
  assert.equal(await reopened.locator(':scope > .builder-item-details').getAttribute('open'), null); assert.equal(await reopened.locator(':scope > .builder-item-details > summary').innerText(), 'Почта');
  assert.equal(await reopened.getByPlaceholder('URL').inputValue(), 'mailto:office@example.com');
  assert.equal(await reopened.getByPlaceholder('Текст ссылки').inputValue(), 'office@example.com');
  assert.deepEqual(await reopened.locator('.builder-section-link label').allTextContents(), ['Ссылка', 'Текст ссылки']);
  const sectionCount = await page.locator('.builder-section-item').count(); await page.locator('#builder-add-section-item').click();
  const addedSection = page.locator('.builder-section-items > .builder-section-item').last(); assert.equal(await addedSection.locator(':scope > details > summary').innerText(), 'Элемент');
  await addedSection.locator(':scope > details').evaluate(node => { window.sectionItemDeleteToggles = 0; node.addEventListener('toggle', () => { window.sectionItemDeleteToggles++; }); });
  await addedSection.locator(':scope > .builder-image-tools .builder-delete').click(); assert.equal(await page.evaluate(() => window.sectionItemDeleteToggles), 0); assert.equal(await page.locator('.builder-section-item').count(), sectionCount);
  assert.deepEqual(errors, []);
});

test('step 3 sections cards expose compact fields and reorder whole branches with keyboard and mouse', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(testTempRoot(), 'page-builder-sections-drag-ui-'));
  const queue = new Queue({ root, autoStart: false }); queue.add('https://mori-cinema.reestr35.ru/'); const job = queue.jobs[0]; seedMoriPage(queue, job);
  Object.assign(job.attempts[0], { status: 'complete', captureStatus: 'complete', htmlMedia: { status: 'complete', revision: 1, source: { bytes: 0 }, total: 0, pending: 0 } }); queue.save();
  const server = createServer(queue); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await queue.shutdown(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 3200 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  const mainDrop = await page.locator('[data-add-section]').first().evaluate(node => ({ tag: node.tagName, height: node.getBoundingClientRect().height,
    target: node.dataset.dropSection, dropClass: node.classList.contains('builder-section-drop'), plus: node.querySelector('.builder-add-plus')?.textContent }));
  assert.equal(mainDrop.tag, 'BUTTON'); assert.ok(mainDrop.height >= 50); assert.ok(mainDrop.target); assert.equal(mainDrop.dropClass, true); assert.equal(mainDrop.plus, '+');
  await page.locator('[data-builder-id="common-hero"]').click(); await page.waitForSelector('#page-builder-modal.show'); await page.locator('#builder-type').selectOption('sections');
  const roots = page.locator('.builder-section-items > .builder-section-item');
  const titles = async rows => rows.locator('.builder-section-item-body > .builder-section-title').evaluateAll(inputs => inputs.map(input => input.value));
  for (const title of ['А', 'Б', 'В']) { await page.locator('#builder-add-section-item').click(); await roots.last().locator(':scope > .builder-item-details > summary').click(); await roots.last().getByPlaceholder('Заголовок').fill(title); }
  const firstChildren = roots.first().locator('xpath=following-sibling::div[1]');
  for (const title of ['А1', 'А2']) { await firstChildren.locator(':scope > .builder-section-add-child').click(); await firstChildren.locator(':scope > .builder-section-item').last().locator(':scope > .builder-item-details > summary').click(); await firstChildren.locator(':scope > .builder-section-item').last().getByPlaceholder('Заголовок').fill(title); }
  const layout = await roots.first().evaluate(row => {
    const body = row.querySelector('.builder-section-item-body'), title = body.querySelector('.builder-section-title'), text = body.querySelector('.builder-section-text'), source = text.querySelector('.builder-markdown-source'), link = body.querySelector('.builder-section-link');
    return { labels: [...body.querySelectorAll('label')].map(node => node.textContent), legends: [...body.querySelectorAll('legend')].map(node => node.textContent),
      summaries: [...body.querySelectorAll('.builder-item-markdown > summary')].map(node => node.textContent), placeholders: [title.placeholder, source.placeholder, ...link.querySelectorAll('input')].map(value => typeof value === 'string' ? value : value.placeholder),
      widths: [title, text, link].map(node => Math.round(node.getBoundingClientRect().width)) };
  });
  assert.deepEqual(layout.labels, ['Ссылка', 'Текст ссылки', 'Тип элемента', 'Открывать ссылку']); assert.deepEqual(layout.legends, []);
  assert.deepEqual(layout.summaries, ['Текст']); assert.deepEqual(layout.placeholders, ['Заголовок', 'Текст в Markdown', 'URL', 'Текст ссылки']); assert.ok(Math.max(...layout.widths) - Math.min(...layout.widths) <= 2);
  assert.equal(await firstChildren.locator(':scope > .builder-section-add-child').evaluate(node => node.classList.contains('builder-add') && node.querySelector('.builder-add-plus')?.textContent === '+'), true);
  for (const width of [1440, 390, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 3200 });
    const geometry = await page.locator('.builder-sections-section').evaluate(section => {
      const top = section.querySelector('#builder-add-section-item'), nested = section.querySelector('.builder-section-add-child');
      const topLine = section.querySelector('.builder-section-items > .builder-section-drop-end'), nestedLine = nested.previousElementSibling;
      const linkInputs = [...section.querySelector('.builder-section-link').querySelectorAll('input')].map(node => node.getBoundingClientRect());
      const measure = () => ({ topHeight: top.getBoundingClientRect().height, nestedHeight: nested.getBoundingClientRect().height,
        topLineHeight: topLine.getBoundingClientRect().height, nestedLineHeight: nestedLine.getBoundingClientRect().height,
        topGap: top.getBoundingClientRect().top - topLine.getBoundingClientRect().bottom,
        nestedGap: nested.getBoundingClientRect().top - nestedLine.getBoundingClientRect().bottom,
        topLineOpacity: getComputedStyle(topLine).opacity, nestedLineOpacity: getComputedStyle(nestedLine).opacity });
      const resting = measure(); section.classList.add('builder-sections-dragging'); const dragging = measure(); section.classList.remove('builder-sections-dragging');
      return { resting, dragging, overflow: section.closest('.modal-body').scrollWidth > section.closest('.modal-body').clientWidth,
        linkSameRow: Math.abs(linkInputs[0].top - linkInputs[1].top) <= 1 };
    });
    assert.equal(geometry.overflow, false, `${width}: no horizontal overflow`);
    assert.equal(geometry.linkSameRow, width > 575, `${width}: link fields keep the responsive two-column layout`);
    assert.ok(geometry.resting.topLineHeight <= 4 && geometry.resting.nestedLineHeight <= 4, `${width}: thin lines`);
    assert.ok(geometry.resting.topGap <= 16 && geometry.resting.nestedGap <= 16, `${width}: no extra drop height`);
    assert.ok(Math.abs(geometry.resting.topHeight - geometry.resting.nestedHeight) <= 1, `${width}: plus buttons match`);
    assert.equal(geometry.resting.topLineOpacity, '0'); assert.equal(geometry.resting.nestedLineOpacity, '0');
    assert.equal(geometry.dragging.topLineOpacity, '1'); assert.equal(geometry.dragging.nestedLineOpacity, '1');
  }
  await page.setViewportSize({ width: 1440, height: 3200 });
  await roots.nth(1).locator('.builder-section-drag').focus(); await page.keyboard.press('ArrowUp'); assert.deepEqual(await titles(roots), ['Б', 'А', 'В']);
  const rootHandle = roots.nth(1).locator('.builder-section-drag'); assert.equal(await rootHandle.getAttribute('draggable'), 'true');
  const rootTarget = await roots.nth(2).boundingBox();
  await rootHandle.dragTo(roots.nth(2), { targetPosition: { x: 12, y: rootTarget.height - 6 }, timeout: 10000 });
  assert.deepEqual(await titles(roots), ['Б', 'В', 'А']);
  const nested = roots.last().locator('xpath=following-sibling::div[1]').locator(':scope > .builder-section-item');
  await nested.nth(1).locator('.builder-section-drag').dragTo(nested.nth(0), { targetPosition: { x: 12, y: 6 }, timeout: 10000 });
  assert.deepEqual(await titles(nested), ['А2', 'А1']);
  await nested.first().locator('.builder-section-drag').focus(); await page.keyboard.press('ArrowDown'); assert.deepEqual(await titles(nested), ['А1', 'А2']);
  const handle = roots.first().locator('.builder-section-drag');
  const end = page.locator('.builder-section-items > .builder-section-drop-end');
  await handle.dragTo(end, { timeout: 10000 });
  assert.deepEqual(await titles(roots), ['В', 'А', 'Б'], 'the end drop zone receives an actual mouse drag');
  await roots.first().locator('.builder-section-drag').dragTo(page.locator('#builder-add-section-item'), { timeout: 10000 });
  assert.deepEqual(await titles(roots), ['А', 'Б', 'В'], 'the top plus receives an actual mouse drag');
  const inA = roots.first().locator('xpath=following-sibling::div[1]'), nestedA = inA.locator(':scope > .builder-section-item');
  await nestedA.first().locator('.builder-section-drag').dragTo(inA.locator(':scope > .builder-section-add-child'), { timeout: 10000 });
  assert.deepEqual(await titles(nestedA), ['А2', 'А1'], 'the nested plus receives an actual mouse drag');
  await nestedA.first().locator('.builder-section-drag').dragTo(inA.locator(':scope > .builder-section-drop-end'), { timeout: 10000 });
  assert.deepEqual(await titles(nestedA), ['А1', 'А2'], 'the nested line receives an actual mouse drag');
  await roots.nth(1).locator('.builder-section-drag').dragTo(inA.locator(':scope > .builder-section-add-child'), { timeout: 10000 });
  assert.deepEqual(await titles(roots), ['А', 'В']); assert.deepEqual(await titles(nestedA), ['А1', 'А2', 'Б'], 'the plus reparents a whole branch');
  await nestedA.last().locator('.builder-section-drag').dragTo(page.locator('#builder-add-section-item'), { timeout: 10000 });
  assert.deepEqual(await titles(roots), ['А', 'В', 'Б']); assert.deepEqual(await titles(nestedA), ['А1', 'А2']);
  await inA.locator(':scope > .builder-section-add-child').click();
  assert.deepEqual(await titles(nestedA), ['А1', 'А2', '']); await nestedA.last().locator('.builder-delete').click();
  assert.deepEqual(await titles(nestedA), ['А1', 'А2'], 'the plus still adds by click');
  await page.locator('#page-builder-save').click(); await page.waitForSelector('#page-builder-modal', { state: 'hidden' });
  const saved = queue.pageBuilder.read(job.id).document.common.blocks[0];
  assert.deepEqual(saved.items.map(item => item.title), ['А', 'В', 'Б']); assert.deepEqual(saved.items[0].children.map(item => item.title), ['А1', 'А2']); assert.deepEqual(errors, []);
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
  await page.locator('#builder-type').selectOption('rich-content'); assert.equal(await preview.count(), 0); assert.equal(await page.evaluate(() => window.ArmEditors.text('builder-content')), markdown);
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
  await page.locator('#builder-type').selectOption('rich-content');
  assert.deepEqual(await page.locator('.builder-content-fields > .mb-3 label').allInnerTexts(), ['HTML', 'Обоснование']);
  const htmlEditor = page.getByRole('textbox', { name: 'HTML', exact: true });
  assert.equal(await htmlEditor.getAttribute('contenteditable'), 'true');
  assert.equal(await page.locator('#builder-content .cm-lineNumbers').count(), 1);
  assert.equal(await page.locator('#builder-content .cm-foldGutter').count(), 1);
  assert.ok(await page.locator('#builder-content .cm-line span').count());
  assert.equal(await page.locator('#builder-reason').getAttribute('placeholder'), 'Почему нужен HTML-фрагмент');
  assert.doesNotMatch(await page.locator('.builder-content-fields').innerText(), /необязательно|сохраняется как введён/);
  await htmlEditor.fill(''); await page.locator('#builder-reason').fill('');
  const richPosts = posts.length; await page.locator('#page-builder-save').click();
  assert.equal(posts.length, richPosts); assert.equal(await page.locator('#page-builder-form-error').innerText(), 'Заполните поле «HTML».'); assert.equal(await htmlEditor.evaluate(node => document.activeElement === node), true);
  const richHtml = '  <p class="note">Содержимое</p>\n';
  await htmlEditor.fill(richHtml); assert.equal(await page.evaluate(() => window.ArmEditors.text('builder-content')), richHtml);
  await page.locator('#builder-view').selectOption('wide'); assert.equal(await page.evaluate(() => window.ArmEditors.text('builder-content')), richHtml, 'view switch preserves exact HTML');
  await page.locator('#builder-type').selectOption('content'); assert.equal(await page.evaluate(() => window.ArmEditors.text('builder-content')), '', 'type switch destroys the old CodeMirror');
  await page.locator('#builder-type').selectOption('rich-content'); assert.equal(await page.evaluate(() => window.ArmEditors.text('builder-content')), richHtml, 'type switch restores exact HTML');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.locator('#builder-content').evaluate(node => ({ editor: node.getBoundingClientRect().width, scroll: node.scrollWidth, bodyScroll: node.closest('.modal-body').scrollWidth, bodyWidth: node.closest('.modal-body').clientWidth, background: getComputedStyle(node.querySelector('.cm-editor')).backgroundColor }));
    assert.ok(geometry.scroll <= geometry.editor + 1 && geometry.bodyScroll <= geometry.bodyWidth, `${width}: HTML editor stays within modal`);
    assert.equal(geometry.background, 'rgb(255, 255, 255)', `${width}: HTML editor keeps the light theme`);
  }
  await page.locator('#page-builder-save').click();
  assert.equal(posts.length, richPosts); assert.equal(await page.locator('#page-builder-form-error').innerText(), 'Заполните поле «Обоснование».'); assert.equal(await page.evaluate(() => document.activeElement.id), 'builder-reason');
  await page.locator('#builder-reason').fill('Нужно сохранить семантику'); await page.locator('#page-builder-save').click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].text, richHtml); assert.equal(queue.pageBuilder.read(job.id).document.common.blocks[0].reason, 'Нужно сохранить семантику');
  await opener.click(); assert.equal(await page.evaluate(() => window.ArmEditors.text('builder-content')), richHtml); await page.waitForFunction(() => document.activeElement?.closest('#page-builder-modal')); await page.keyboard.press('Escape'); await close(); assert.equal(await page.evaluate(() => window.ArmEditors.text('builder-content')), ''); assert.equal(await page.evaluate(() => document.activeElement.dataset.builderId), 'common-hero');
  await page.locator('[data-add-section="common"]').click(); assert.equal(await page.locator('.builder-image-row').count(), 2); await page.locator('#page-builder-save').click(); await close();
  const blank = queue.pageBuilder.read(job.id).document.common.blocks.at(-1); assert.equal(blank.title, ''); assert.equal(blank.text, ''); assert.equal(blank.media.length, 2); assert.equal(blank.media[0].originalUrl, '');
  await page.locator(`[data-builder-id="${blank.id}"]`).click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('.builder-image-row .builder-media-placeholder').count(), 4);
  const firstBlankImage = page.locator('.builder-image-row').first();
  await firstBlankImage.getByLabel('Ссылка изображения', { exact: true }).fill('example.org/promo');
  await firstBlankImage.getByLabel('Альтернативный текст', { exact: true }).fill('Афиша'); await firstBlankImage.getByLabel('Подпись', { exact: true }).fill('Акция');
  const beforeHref = queue.pageBuilder.read(job.id).revision; await page.locator('#page-builder-save').click();
  const hrefError = await page.locator('#page-builder-form-error').innerText();
  assert.match(hrefError, /изображение 1.*Ссылка изображения.*https?:\/\//); assert.doesNotMatch(hrefError, /common\.blocks|media\[0\]\.href/);
  assert.equal(queue.pageBuilder.read(job.id).revision, beforeHref);
  await firstBlankImage.getByLabel('Ссылка изображения', { exact: true }).fill(`/${'a'.repeat(4096)}`); await page.locator('#page-builder-save').click();
  const longHrefError = await page.locator('#page-builder-form-error').innerText();
  assert.match(longHrefError, /изображение 1.*Ссылка изображения.*4096 символов/); assert.doesNotMatch(longHrefError, /common\.blocks|media\[0\]\.href/);
  assert.equal(queue.pageBuilder.read(job.id).revision, beforeHref, 'overlong link is rejected without a write');
  await firstBlankImage.getByLabel('Ссылка изображения', { exact: true }).fill('/promo'); await page.locator('#page-builder-save').click(); await close();
  const savedBlank = queue.pageBuilder.read(job.id).document.common.blocks.find(block => block.id === blank.id).media[0];
  assert.deepEqual([savedBlank.originalUrl, savedBlank.bigUrl, savedBlank.href, savedBlank.alt, savedBlank.caption], ['', '', '/promo', 'Афиша', 'Акция']);
  await page.locator('[data-add-section="common"]').click(); await page.locator('#builder-type').selectOption('big-media');
  assert.equal(await page.locator('.builder-image-row').count(), 1, 'new banner starts with one image slot');
  assert.equal(await page.locator('#builder-add-image, .builder-media-drag, .builder-image-tools').count(), 0);
  await page.locator('.builder-banner-advanced summary').click();
  await page.locator('#builder-meta-ratio').selectOption('16x9'); await page.locator('#builder-meta-fit').selectOption('contain');
  await page.locator('#builder-meta-media_mode').selectOption('fill'); await page.locator('#builder-meta-media_align').selectOption('end');
  await page.locator('#builder-meta-media_width').fill('720');
  await page.locator('#page-builder-save').click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).media.length, 1, 'banner placeholder is saved');
  assert.deepEqual(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).meta, { ratio: '16x9', fit: 'contain', media_mode: 'fill', media_align: 'end', media_width: 720 });
  const beforeLegacy = queue.pageBuilder.read(job.id), legacy = structuredClone(beforeLegacy.document), legacyBanner = legacy.common.blocks.at(-1);
  legacyBanner.media = []; queue.pageBuilder.write(job.id, beforeLegacy.revision, legacy);
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator(`[data-builder-id="${legacyBanner.id}"]`).click();
  assert.equal(await page.locator('.builder-image-row').count(), 1, 'legacy banner without media gets an editable image slot');
  assert.equal(await page.locator('#builder-add-image, .builder-media-drag, .builder-image-tools').count(), 0);
  await page.locator('#page-builder-save').click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).media.length, 1, 'saving repairs the empty legacy banner');
  await page.locator('[data-add-section="common"]').click(); await page.locator('#builder-type').selectOption('service');
  assert.equal(await page.locator('.builder-image-row').count(), 2, 'new service starts with two image slots');
  assert.equal(await page.locator('#builder-add-image, .builder-image-tools .builder-delete').count(), 0);
  await page.locator('.builder-banner-advanced summary').click();
  assert.deepEqual(await page.locator('.builder-banner-advanced select').evaluateAll(nodes => nodes.map(node => node.value)), ['auto', 'contain', 'link', 'intrinsic', 'start']);
  await page.locator('#page-builder-save').click(); await close();
  const beforeExtra = queue.pageBuilder.read(job.id), extra = structuredClone(beforeExtra.document), oldService = extra.common.blocks.at(-1);
  assert.equal(oldService.media.length, 2); oldService.media.push({ id: 'legacy-service-extra', originalUrl: '', bigUrl: '', href: '', alt: '', caption: '' });
  queue.pageBuilder.write(job.id, beforeExtra.revision, extra);
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator(`[data-builder-id="${oldService.id}"]`).click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('.builder-image-row').count(), 2, 'older extra image stays hidden beyond the two fixed slots');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).media.length, 3, 'cancel keeps the old tail');
  await page.locator(`[data-builder-id="${oldService.id}"]`).click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('#builder-add-image, .builder-image-tools .builder-delete').count(), 0);
  const visibleIds = await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId));
  await page.locator('.builder-image-row').nth(1).locator('.builder-media-drag').focus(); await page.keyboard.press('ArrowDown');
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), visibleIds, 'second slot cannot move into hidden tail');
  await page.locator('.builder-image-row').first().locator('.builder-media-drag').focus(); await page.keyboard.press('ArrowDown');
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), [...visibleIds].reverse());
  await page.locator('.builder-image-row').nth(1).locator('.builder-media-drag').focus(); await page.keyboard.press('ArrowUp');
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), visibleIds);
  const serviceRevision = queue.pageBuilder.read(job.id).revision; await page.locator('#page-builder-save').click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).revision, serviceRevision + 1, 'unchanged service saves the removal of legacy media');
  assert.deepEqual(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).media.map(item => item.id), visibleIds, 'saving service removes its old extra media');
  await page.locator('[data-add-section="common"]').click(); await page.locator('#builder-type').selectOption('service');
  const serviceSlots = await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)); assert.equal(serviceSlots.length, 2);
  await page.locator('#builder-type').selectOption('big-media'); assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), serviceSlots.slice(0, 1));
  await page.locator('#builder-type').selectOption('service'); assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), serviceSlots, 'returning to service restores both draft slots');
  await page.locator('#builder-type').selectOption('big-media'); await page.locator('#page-builder-save').click(); await close();
  assert.deepEqual(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).media.map(item => item.id), serviceSlots.slice(0, 1), 'converting service to banner saves one image');
  await page.locator(`[data-builder-id="${queue.pageBuilder.read(job.id).document.common.blocks.at(-1).id}"]`).click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('.builder-image-row').count(), 1, 'saved banner reopens with one image');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close();
  const beforeHistorical = queue.pageBuilder.read(job.id), historical = structuredClone(beforeHistorical.document), oldBanner = historical.common.blocks.at(-1);
  oldBanner.media.push({ id: 'legacy-banner-extra', originalUrl: '', bigUrl: '', href: '', alt: '', caption: '' });
  queue.pageBuilder.write(job.id, beforeHistorical.revision, historical);
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator(`[data-builder-id="${oldBanner.id}"]`).click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('.builder-image-row').count(), 1, 'existing banner still shows its single slot');
  const beforeTrim = queue.pageBuilder.read(job.id).revision;
  await page.locator('#page-builder-save').click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).revision, beforeTrim + 1, 'save writes the trim even without other edits');
  assert.deepEqual(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).media.map(item => item.id), serviceSlots.slice(0, 1), 'saving old banner removes its hidden extra media');
  await page.locator('[data-add-section="common"]').click();
  assert.equal(await page.locator('#builder-type').inputValue(), 'content');
  assert.deepEqual(await page.locator('.builder-content-fields > *').evaluateAll(nodes => nodes.map(node => node.className)), ['builder-text-fields', 'builder-images-section', 'builder-link-fields', 'builder-banner-advanced']);
  assert.equal(await page.locator('.builder-image-row').count(), 2); assert.equal(await page.locator('#builder-add-image, .builder-image-tools .builder-delete').count(), 0);
  assert.equal(await page.locator('.builder-media-drag').count(), 2);
  await page.locator('.builder-banner-advanced summary').click();
  assert.deepEqual(await page.locator('.builder-banner-advanced select').evaluateAll(nodes => nodes.map(node => node.value)), ['', '', 'auto', 'cover', 'intrinsic', 'start']);
  await page.locator('#builder-meta-image_position').selectOption('right'); await page.locator('#builder-meta-image_layout').selectOption('flow');
  await page.locator('#builder-meta-image_ratio').selectOption('4x3'); await page.locator('#builder-meta-image_fit').selectOption('contain');
  await page.locator('#builder-meta-media_mode').selectOption('fill'); await page.locator('#builder-meta-media_align').selectOption('end');
  await page.locator('#builder-meta-media_width').fill('512');
  await page.locator('#builder-link').fill('/content'); await page.locator('#builder-link_text').fill('Подробнее');
  const contentSlots = await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId));
  await page.locator('#builder-type').selectOption('service'); await page.locator('#builder-type').selectOption('content');
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), contentSlots, 'content draft restores both slots');
  await page.locator('.builder-banner-advanced summary').click();
  assert.equal(await page.locator('#builder-meta-image_layout').inputValue(), 'flow', 'content draft restores new settings');
  await page.locator('#page-builder-save').click(); await close();
  const savedContent = queue.pageBuilder.read(job.id).document.common.blocks.at(-1);
  assert.deepEqual(savedContent.media.map(item => item.id), contentSlots);
  assert.deepEqual(savedContent.meta, { image_position: 'right', image_layout: 'flow', image_ratio: '4x3', image_fit: 'contain', media_mode: 'fill', media_align: 'end', media_width: 512 });
  assert.equal(savedContent.link_text, 'Подробнее');
  const beforeContentTail = queue.pageBuilder.read(job.id), contentTail = structuredClone(beforeContentTail.document);
  contentTail.common.blocks.at(-1).media.push({ id: 'legacy-content-extra', originalUrl: '', bigUrl: '', href: '', alt: '', caption: '' });
  queue.pageBuilder.write(job.id, beforeContentTail.revision, contentTail);
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator(`[data-builder-id="${savedContent.id}"]`).click(); await page.waitForSelector('#page-builder-modal.show');
  assert.equal(await page.locator('.builder-image-row').count(), 2);
  await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).media.length, 3, 'cancel keeps old content tail');
  await page.locator(`[data-builder-id="${savedContent.id}"]`).click(); await page.waitForSelector('#page-builder-modal.show');
  const contentRevision = queue.pageBuilder.read(job.id).revision; await page.locator('#page-builder-save').click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).revision, contentRevision + 1, 'save trims old content tail without other edits');
  assert.deepEqual(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).media.map(item => item.id), contentSlots);
  await page.locator(`[data-builder-id="${savedContent.id}"]`).click(); await page.waitForSelector('#page-builder-modal.show');
  await page.locator('#builder-type').selectOption('rich-content');
  assert.equal(await page.locator('.builder-image-row').count(), 0, 'rich-content has no image section');
  await page.locator('#builder-type').selectOption('content');
  assert.deepEqual(await page.locator('.builder-image-row').evaluateAll(nodes => nodes.map(node => node.dataset.mediaId)), contentSlots, 'returning to content restores unsaved media');
  await page.locator('#builder-type').selectOption('rich-content');
  await page.getByLabel('HTML', { exact: true }).fill('<p>Фрагмент</p>');
  await page.getByLabel('Обоснование', { exact: true }).fill('Нужна сохранённая разметка');
  await page.locator('#page-builder-save').click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).media.length, 0, 'saving rich-content clears all inherited media');
  const beforeRichTail = queue.pageBuilder.read(job.id), richTail = structuredClone(beforeRichTail.document);
  richTail.common.blocks.at(-1).media.push({ id: 'legacy-rich-extra', originalUrl: '', bigUrl: '', href: '', alt: '', caption: '' });
  queue.pageBuilder.write(job.id, beforeRichTail.revision, richTail);
  await page.reload(); await page.locator('#jobs-body tr').first().click(); await page.waitForSelector('#page-builder-content:not(.d-none)');
  await page.locator(`[data-builder-id="${savedContent.id}"]`).click(); await page.waitForSelector('#page-builder-modal.show');
  const richRevision = queue.pageBuilder.read(job.id).revision; await page.locator('#page-builder-save').click(); await close();
  assert.equal(queue.pageBuilder.read(job.id).revision, richRevision + 1, 'unchanged rich-content saves the removal of legacy media');
  assert.equal(queue.pageBuilder.read(job.id).document.common.blocks.at(-1).media.length, 0);
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
  await page.locator('.builder-block-open').first().click(); await page.locator('.builder-images-section').scrollIntoViewIfNeeded(); await page.keyboard.press('Escape');
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
  await newJobRow.locator('td').nth(1).locator('span').click();
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
