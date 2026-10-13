'use strict';

// The wire model is deliberately independent of constructor and the v3 skill.
// All references remain stable ARM IDs until the Beget endpoint resolves them.
const TYPES = Object.freeze({
  'big-media': 1, table: 2, service: 3, content: 4, grid: 5,
  'data-table': 6, links: 7, sections: 8, embed: 9, 'rich-content': 10
});
const { render: markdown } = require('./markdown.cjs');

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const assignedId = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const withId = (value, id) => assignedId(id) ? { ...value, id } : value;
const sort = index => (index + 1) * 10;

function fail(message) {
  const error = new Error(message);
  error.code = 'BEGET_SERIALIZE';
  throw error;
}

function text(value) { return typeof value === 'string' ? value : ''; }

function refImage(localId, mediaIds, field) {
  if (!localId) return undefined;
  if (mediaIds.emptySlots?.has(localId)) return undefined;
  if (typeof localId !== 'string' || !mediaIds.has(localId)) fail(`Изображение ${field} отсутствует в медиа блока`);
  return localId;
}

function props(payload, extraMeta = {}) {
  const meta = { ...(object(payload.meta) ? payload.meta : {}), ...extraMeta };
  const result = {
    title: text(payload.title), text: payload.rawHtml ? text(payload.text) : markdown(payload.text), view: text(payload.view),
    meta, link: text(payload.link)
  };
  if (Buffer.byteLength(result.text, 'utf8') > 63200) fail('Текст после преобразования Markdown превышает лимит Beget 63200 байт');
  if (payload.image) result.image = payload.image;
  if (payload.left_image) result.left_image = payload.left_image;
  if (payload.right_image) result.right_image = payload.right_image;
  if (payload.show_border !== undefined) result.show_border = payload.show_border ? 'Y' : 'N';
  return result;
}

function contentEntry(localId, parentLocalId, index, payload, bindings, extraMeta) {
  if (typeof localId !== 'string' || !localId) fail('У содержимого нет локального ID');
  return withId({ local_id: localId, parent_local_id: parentLocalId, sort: sort(index),
    properties: props(payload, extraMeta) }, bindings?.[localId]);
}

function rootPayload(block, mediaIds) {
  const meta = { ...(object(block.meta) ? block.meta : {}) };
  for (const key of ['link_text', 'badge', 'caption', 'source_url', 'provider', 'ratio', 'reason']) {
    if (block[key] !== undefined && block[key] !== '') meta[key] = block[key];
  }
  if (block.type === 'data-table') {
    meta.columns = (block.columns || []).map(({ id, ...column }) => ({ id, ...column }));
    if (block.caption !== undefined) meta.caption = block.caption;
  }
  if (block.settings) fail(`Настройки блока ${block.id} не имеют поля в контракте Beget`);
  const payload = { title: block.title, text: block.text, view: block.view, link: block.link, meta,
    rawHtml: block.type === 'rich-content' };
  if (block.type === 'table') payload.show_border = !!block.show_border;
  if (block.type === 'big-media' && mediaIds.has(block.media?.[0]?.id)) payload.image = block.media[0].id;
  if (block.type === 'service' || block.type === 'content') {
    if (mediaIds.has(block.media?.[0]?.id)) payload.left_image = block.media[0].id;
    if (mediaIds.has(block.media?.[1]?.id)) payload.right_image = block.media[1].id;
  }
  return payload;
}

function addItems(entries, block, rootId, contentBindings, mediaIds, files, resolveDocument, acknowledgedAssets) {
  if (!['grid', 'links', 'sections'].includes(block.type)) return;
  const add = async (item, parentId, index) => {
    const meta = { ...(object(item.meta) ? item.meta : {}) };
    for (const key of ['link_text', 'badge', 'date']) if (item[key] !== undefined && item[key] !== '') meta[key] = item[key];
    const payload = { title: item.title, text: item.text, link: item.link, meta };
    if (item.image_asset_id) payload.image = refImage(item.image_asset_id, mediaIds, `${block.id}.${item.id}`);
    if (item.sourceDocument) {
      if (typeof resolveDocument !== 'function') fail(`Документ ${item.id} не может быть проверен локально`);
      const file = await resolveDocument(item.sourceDocument, item.link);
      if (!file || typeof file.name !== 'string' || typeof file.base64 !== 'string' || file.sha256 !== item.sourceDocument.sha256) fail(`Документ ${item.id} изменился`);
      const fileId = `file-${item.id}`;
      files.push({ local_id: fileId, name: file.name, sha256: file.sha256,
        ...(acknowledgedAssets?.files?.[fileId] === file.sha256 ? {} : { base64: file.base64 }) });
      meta.file_id = fileId;
      payload.link = '';
    }
    entries.push(contentEntry(item.id, parentId, index, payload, contentBindings));
    for (let childIndex = 0; childIndex < (item.children || []).length; childIndex++) {
      await add(item.children[childIndex], item.id, childIndex);
    }
  };
  return (async () => {
    for (let index = 0; index < (block.items || []).length; index++) await add(block.items[index], rootId, index);
  })();
}

function addRows(entries, block, rootId, contentBindings, mediaIds) {
  if (block.type !== 'table' && block.type !== 'data-table') return;
  for (let rowIndex = 0; rowIndex < (block.rows || []).length; rowIndex++) {
    const row = block.rows[rowIndex];
    if (block.type === 'data-table' && Object.hasOwn(row, 'group')) {
      entries.push(contentEntry(row.id, rootId, rowIndex, { title: row.group, meta: { role: 'group' } }, contentBindings));
      continue;
    }
    entries.push(contentEntry(row.id, rootId, rowIndex, { title: `row ${rowIndex + 1}` }, contentBindings));
    for (let cellIndex = 0; cellIndex < (row.cells || []).length; cellIndex++) {
      const cell = row.cells[cellIndex];
      if (block.type === 'data-table') {
        const { id, value, ...settings } = cell;
        entries.push(contentEntry(id, row.id, cellIndex, { text: value, meta: settings }, contentBindings));
      } else {
        const meta = { ...(object(cell.meta) ? cell.meta : {}) };
        const images = cell.image_asset_ids || (cell.image_asset_id ? [cell.image_asset_id] : []);
        for (const image of images) refImage(image, mediaIds, `${block.id}.${cell.id}`);
        if (images.length > 1) meta.image_asset_ids = images;
        const payload = { ...cell, meta, ...(images.length === 1 ? { image: images[0] } : {}) };
        entries.push(contentEntry(cell.id, row.id, cellIndex, payload, contentBindings));
      }
    }
  }
}

async function serialize(document, { resolveMedia, resolveDocument, bindings = {}, acknowledgedAssets = {} } = {}) {
  if (!object(document) || !object(document.common) || !Array.isArray(document.tabs)) fail('Некорректный документ шага 3');
  const snapshot = { tabs: [], media: [], files: [], blocks: [] };
  for (let index = 0; index < document.tabs.length; index++) {
    const tab = document.tabs[index];
    snapshot.tabs.push(withId({ local_id: tab.id, name: tab.title, sort: sort(index), parent_local_id: null }, bindings.tabs?.[tab.id]));
  }
  for (const section of [document.common, ...document.tabs]) {
    for (let blockIndex = 0; blockIndex < section.blocks.length; blockIndex++) {
      const block = section.blocks[blockIndex], type = TYPES[block.type];
      if (!type) fail(`Тип блока ${block.type} не поддерживается Beget`);
      const mediaIds = new Set();
      // A local, still empty gallery slot is an editor placeholder, not media.
      mediaIds.emptySlots = new Set();
      for (const asset of block.media || []) {
        const hasBytes = !!(asset.originalMedia || asset.bigMedia);
        if (!hasBytes) {
          if (asset.originalUrl || asset.bigUrl) fail(`Изображение ${asset.id} не имеет проверенной локальной копии`);
          if (block.type === 'grid') mediaIds.emptySlots.add(asset.id);
          continue;
        }
        if (typeof resolveMedia !== 'function') fail(`Изображение ${asset.id} не может быть проверено локально`);
        const media = { local_id: asset.id, href: text(asset.href), alt: text(asset.alt), caption: text(asset.caption) };
        for (const kind of ['original', 'big']) {
          const reference = asset[`${kind}Media`];
          if (!reference) continue;
          if (acknowledgedAssets.media?.[asset.id]?.[kind] === reference.sha256) {
            media[kind] = { name: reference.filename, sha256: reference.sha256 };
          } else {
            const resolved = await resolveMedia(reference, asset[`${kind}Url`]);
            if (!resolved || typeof resolved.name !== 'string' || typeof resolved.base64 !== 'string' || resolved.sha256 !== reference.sha256) fail(`Изображение ${asset.id} изменилось`);
            media[kind] = { name: resolved.name, base64: resolved.base64, sha256: resolved.sha256 };
          }
        }
        mediaIds.add(asset.id);
        snapshot.media.push(withId(media, bindings.media?.[asset.id]));
      }
      const rootId = `root-${block.id}`;
      const contentBindings = bindings.content?.[block.id] || {};
      const content = [contentEntry(rootId, null, 0, rootPayload(block, mediaIds), contentBindings)];
      await addItems(content, block, rootId, contentBindings, mediaIds, snapshot.files, resolveDocument, acknowledgedAssets);
      addRows(content, block, rootId, contentBindings, mediaIds);
      snapshot.blocks.push(withId({ local_id: block.id, tab_local_id: section === document.common ? null : section.id,
        name: block.title || block.type, type, sort: sort(blockIndex), content }, bindings.blocks?.[block.id]));
    }
  }
  for (const file of snapshot.files) {
    const id = assignedId(bindings.files?.[file.local_id]);
    if (id) file.id = id;
  }
  return snapshot;
}

module.exports = { serialize, TYPES };
