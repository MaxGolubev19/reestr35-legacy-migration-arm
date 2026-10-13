'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { serialize } = require('../src/stages/beget/serialize.cjs');

const sha = 'a'.repeat(64);
const block = (id, type, extra = {}) => ({ id, type, view: type === 'links' ? 'documents' : 'default', title: id, text: 'Текст', media: [], ...extra });
const page = blocks => ({ common: { id: 'common', blocks: [] }, tabs: [{ id: 'tab-a', title: 'Вкладка', blocks }] });

test('serializes all ten block types, stable nested IDs and Bitrix bindings', async () => {
  const blocks = [
    block('banner', 'big-media', { media: [{ id: 'image-1', originalUrl: 'https://source.example/a.jpg', originalMedia: { sha256: sha } }] }),
    block('table', 'table', { show_border: true, rows: [{ id: 'row-1', cells: [{ id: 'cell-1', title: 'Ячейка', text: 'Значение', meta: { colspan: 2 } }] }] }),
    block('service', 'service', { badge: 'Хит' }), block('content', 'content'),
    block('grid', 'grid', { items: [{ id: 'item-1', title: 'Карта', image_asset_id: 'image-2' }], media: [{ id: 'image-2', originalMedia: { sha256: sha } }] }),
    block('data-table', 'data-table', { caption: 'Подпись', columns: [{ id: 'col-1', key: 'x', title: 'X' }], rows: [{ id: 'row-2', cells: [{ id: 'cell-2', value: '42', colspan: 2 }] }] }),
    block('links', 'links', { items: [{ id: 'link-1', title: 'Документ', link: 'https://source.example/doc.pdf', meta: { kind: 'document' }, sourceDocument: { sha256: sha } }] }),
    block('sections', 'sections', { items: [{ id: 'section-1', title: 'Родитель', children: [{ id: 'section-2', title: 'Потомок' }] }] }),
    block('embed', 'embed', { source_url: 'https://source.example/embed', provider: 'iframe' }),
    block('rich', 'rich-content', { reason: 'Исходный HTML' })
  ];
  const snapshot = await serialize(page(blocks), {
    resolveMedia: async () => ({ name: 'image.jpg', base64: 'YQ==', sha256: sha }),
    resolveDocument: async () => ({ name: 'doc.pdf', base64: 'YQ==', sha256: sha }),
    bindings: { tabs: { 'tab-a': 11 }, blocks: { banner: 22 }, content: { banner: { 'root-banner': 33 } }, media: { 'image-1': 44 }, files: { 'file-link-1': 55 } }
  });
  assert.deepEqual(snapshot.blocks.map(item => item.type), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(snapshot.tabs[0].id, 11);
  assert.equal(snapshot.blocks[0].id, 22);
  assert.equal(snapshot.blocks[0].content[0].id, 33);
  assert.equal(snapshot.blocks[0].content[0].properties.image, 'image-1');
  assert.equal(snapshot.media[0].id, 44);
  assert.equal(snapshot.blocks[1].content[2].parent_local_id, 'row-1');
  assert.equal(snapshot.blocks[4].content[1].properties.image, 'image-2');
  assert.equal(snapshot.blocks[5].content[0].properties.meta.columns[0].key, 'x');
  assert.equal(snapshot.blocks[6].content[1].properties.meta.file_id, 'file-link-1');
  assert.equal(snapshot.files[0].id, 55);
  assert.equal(snapshot.blocks[7].content[2].parent_local_id, 'section-1');
  assert.equal(snapshot.blocks[8].content[0].properties.meta.source_url, 'https://source.example/embed');
});

test('rejects media without a verified local source', async () => {
  const document = page([block('banner', 'big-media', { media: [{ id: 'external', originalUrl: 'https://source.example/a.jpg' }] })]);
  await assert.rejects(serialize(document), /проверенной локальной копии/);
});

test('keeps common blocks without inventing a tab and omits empty image placeholders', async () => {
  const document = { common: { id: 'common', blocks: [block('shared', 'big-media', { media: [{ id: 'empty', originalUrl: '', bigUrl: '' }] })] }, tabs: [] };
  const snapshot = await serialize(document);
  assert.equal(snapshot.tabs.length, 0);
  assert.equal(snapshot.blocks[0].tab_local_id, null);
  assert.equal(snapshot.blocks[0].content[0].properties.image, undefined);
  assert.equal(snapshot.media.length, 0);
});

test('sends only metadata for already acknowledged binary assets', async () => {
  const document = page([
    block('banner', 'big-media', { media: [{ id: 'image-1', originalMedia: { sha256: sha, filename: 'picture.png' } }] }),
    block('links', 'links', { items: [{ id: 'doc-1', title: 'Файл', link: 'https://source.example/file.pdf', meta: {}, sourceDocument: { sha256: sha } }] })
  ]);
  const snapshot = await serialize(document, {
    resolveMedia: () => { throw Error('already acknowledged image should not be loaded again'); },
    resolveDocument: async () => ({ name: 'file.pdf', base64: 'YQ==', sha256: sha }),
    acknowledgedAssets: { media: { 'image-1': { original: sha } }, files: { 'file-doc-1': sha } }
  });
  assert.deepEqual(snapshot.media[0].original, { name: 'picture.png', sha256: sha });
  assert.deepEqual(snapshot.files[0], { local_id: 'file-doc-1', name: 'file.pdf', sha256: sha });
});

test('publishes Markdown formatting and keeps source HTML inert after Bitrix decodes', async () => {
  const document = page([block('safe', 'content', { text: '## Заголовок\n**жирный** <script>alert(1)</script> & [ссылка](https://example.org/?a=1&b=2)' })]);
  const html = (await serialize(document)).blocks[0].content[0].properties.text;
  assert.match(html, /<h2>Заголовок<\/h2>/);
  assert.match(html, /<strong>жирный<\/strong>/);
  assert.match(html, /&amp;lt;script&amp;gt;alert\(1\)&amp;lt;\/script&amp;gt;/);
  assert.match(html, /href="https:\/\/example\.org\/\?a=1&amp;amp;b=2"/);
  assert.doesNotMatch(html, /<script>/);
});

test('data-table cell Markdown uses the HTML text property and enforces the Bitrix byte limit', async () => {
  const document = page([block('table', 'data-table', { rows: [{ id: 'row', cells: [{ id: 'cell', value: 'Я'.repeat(9000) }] }] })]);
  const cell = (await serialize(document)).blocks[0].content[2];
  assert.equal(cell.properties.title, '');
  assert.equal(cell.properties.text, `<p>${'Я'.repeat(9000)}</p>`);
  document.tabs[0].blocks[0].rows[0].cells[0].value = '&'.repeat(8000);
  await assert.rejects(serialize(document), /лимит Beget 63200 байт/);
});
