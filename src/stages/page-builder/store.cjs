'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicJson } = require('../../infrastructure/files.cjs');
const { provenance } = require('../../infrastructure/media.cjs');
const { provenance: frameProvenance } = require('./frame-picker.cjs');
const { provenance: documentProvenance } = require('./document-picker.cjs');

const VERSION = 1;
const STATUSES = new Set(['unreviewed', 'passed', 'failed']);
// Portable editor catalog for company-block-contract.v1.json (1.0).
// Nested editor models are validated below; their IDs belong to local ARM.
const f = (name, label, kind = 'text', values) => ({ name, label, kind, ...(values ? { values } : {}) });
const links = [f('link', 'Ссылка', 'link'), f('link_text', 'Текст ссылки')];
const BLOCK_TYPES = [
  { name: 'big-media', label: 'Изображение / баннер', views: ['default', 'hero', 'compact'], fields: links },
  { name: 'table', label: 'Таблица с текстом и изображениями', views: ['default'], fields: [f('show_border', 'Показывать рамки', 'boolean')] },
  { name: 'service', label: 'Описание услуги', views: ['default', 'media-left', 'media-right', 'plain'], fields: [...links, f('badge', 'Метка')] },
  { name: 'content', label: 'Текст с изображениями', views: ['default', 'narrow', 'note'], fields: links },
  { name: 'grid', label: 'Карточки / галерея', views: ['default', 'gallery', 'catalog', 'compact', 'promo', 'news', 'services', 'list'], fields: [] },
  { name: 'data-table', label: 'Таблица данных', views: ['default', 'compact'], fields: [f('caption', 'Подпись')] },
  { name: 'links', label: 'Ссылки и документы', views: ['links', 'documents'], fields: [] },
  { name: 'sections', label: 'Список разделов', views: ['list', 'columns', 'contacts'], fields: [] },
  { name: 'embed', label: 'Видео, карта или виджет', views: ['default', 'wide', 'map'], fields: [f('link', 'Ссылка', 'link'), f('source_url', 'URL источника', 'url'), f('provider', 'Тип источника', 'select', ['iframe', 'map', 'video', 'unknown']), f('ratio', 'Соотношение сторон', 'select', ['16:9', '4:3', '3:2', '1:1', '21:9'])] },
  { name: 'rich-content', label: 'HTML-фрагмент', views: ['default', 'wide', 'compact'], fields: [f('reason', 'Причина использования HTML')] }
].map((type, index) => ({ ...type, id: index + 1, default_view: type.views[0] }));
const LEGACY_TYPES = { hero: ['big-media', 'hero'], text: ['content', 'default'], buttons: ['links', 'links'], image: ['big-media', 'default'], gallery: ['grid', 'gallery'], video: ['embed', 'default'] };
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const validId = value => typeof value === 'string' && idPattern.test(value);
const limited = (value, field, max, { required = false } = {}) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`Некорректное поле ${field}`);
  return value;
};
function review(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !STATUSES.has(value.status)) throw new Error(`Некорректный статус ${field}`);
  const reason = limited(value.reason || '', `${field}.reason`, 1000);
  if (value.status === 'failed' && !reason.trim()) throw new Error(`Для статуса «Не пройдено» нужна причина (${field})`);
  if (value.status !== 'failed' && reason) throw new Error(`Причина разрешена только для непройденной проверки (${field})`);
  return { status: value.status, reason };
}
function safeUrl(value, field, { required = false, link = false } = {}) {
  const url = limited(value ?? '', field, 4096, { required }); if (!url) return '';
  if (/[\u0000-\u0020\u007f\\]/.test(url)) throw new Error(`Некорректный URL ${field}`);
  if (link && /^\/(?!\/)/.test(url)) return url;
  let parsed; try { parsed = new URL(url); } catch { throw new Error(`Некорректный URL ${field}`); }
  if (!(link ? ['http:', 'https:', 'mailto:', 'tel:'] : ['http:', 'https:']).includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`Некорректный URL ${field}`);
  return parsed.href;
}
function media(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)) throw new Error(`Некорректное медиа ${field}`);
  if (Object.keys(value).some(key => !['id', 'originalUrl', 'bigUrl', 'originalMedia', 'bigMedia', 'href', 'alt', 'caption'].includes(key))) throw new Error(`Неизвестное поле медиа ${field}`);
  return { id: value.id, originalUrl: safeUrl(value.originalUrl, `${field}.originalUrl`, { link: true }), bigUrl: safeUrl(value.bigUrl, `${field}.bigUrl`, { link: true }), href: safeUrl(value.href, `${field}.href`, { link: true }), alt: limited(value.alt ?? '', `${field}.alt`, 500), caption: limited(value.caption ?? '', `${field}.caption`, 1000),
    ...(value.originalMedia ? { originalMedia: provenance(value.originalMedia) } : {}), ...(value.bigMedia ? { bigMedia: provenance(value.bigMedia) } : {}) };
}
const BANNER_META = {
  ratio: ['auto', '16x9', '4x3', '3x2', '1x1', 'poster'],
  fit: ['cover', 'contain'],
  media_mode: ['intrinsic', 'fill'],
  media_align: ['start', 'center', 'end']
};
const SERVICE_META = {
  image_ratio: ['auto', '4x3', '3x2', '1x1'],
  image_fit: ['cover', 'contain'],
  action_style: ['link', 'primary'],
  media_mode: ['intrinsic', 'fill'],
  media_align: ['start', 'center', 'end']
};
const CONTENT_META = {
  image_position: ['left', 'right', 'after'],
  image_layout: ['split', 'flow'],
  image_ratio: ['auto', '4x3', '3x2', '1x1'],
  image_fit: ['cover', 'contain'],
  media_mode: ['intrinsic', 'fill'],
  media_align: ['start', 'center', 'end']
};
const GRID_META = {
  image_ratio: ['auto', '16x9', '4x3', '3x2', '1x1', 'poster'],
  image_fit: ['cover', 'contain'],
  items_align: ['start', 'center', 'end'],
  media_mode: ['intrinsic', 'fill'],
  media_align: ['start', 'center', 'end']
};
const TABLE_CELL_META = {
  align: ['left', 'center', 'right'],
  media_mode: ['intrinsic', 'fill'],
  media_align: ['start', 'center', 'end']
};
const TABLE_CELL_SETTINGS = ['colspan', 'rowspan', 'is_header', 'align', 'media_mode', 'media_width', 'media_align'];
const legacyTableId = (kind, field) => `${kind}-${crypto.createHash('sha256').update(field).digest('hex').slice(0, 16)}`;
// Local ARM editor resource limits, not limits of the Beget contract.
const DATA_TABLE_LIMITS = Object.freeze({ columns: 100, rows: 100, cells: 1000, key: 200, title: 500, value: 12000, caption: 1000 });
function dataTableObject(value, field, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Некорректное поле ${field}`);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Неизвестное поле ${field}`);
}
function dataTableId(value, kind, field) {
  const id = value.id === undefined ? legacyTableId(kind, field) : value.id;
  if (!validId(id)) throw new Error(`Некорректное поле ${field}.id`);
  return id;
}
function dataTableSettings(value, field, kind) {
  const result = {}, keys = kind === 'meta' ? ['striped', 'bordered', 'sticky_header', 'min_width'] : kind === 'column' ? ['align', 'width', 'nowrap'] : ['align', 'colspan', 'rowspan', 'is_header', 'nowrap'];
  for (const key of keys) {
    const item = value[key]; if (item === undefined) continue;
    const range = { width: [5, 80], colspan: [1, 12], rowspan: [1, 100], min_width: [480, 1600] }[key];
    if (range && (!Number.isInteger(item) || item < range[0] || item > range[1])
      || key === 'align' && !['left', 'center', 'right'].includes(item)
      || ['striped', 'bordered', 'sticky_header', 'is_header', 'nowrap'].includes(key) && typeof item !== 'boolean') throw new Error(`Некорректное поле ${field}.${key}`);
    result[key] = item;
  }
  return result;
}
function dataTable(value, field) {
  const meta = value.meta === undefined ? {} : value.meta;
  dataTableObject(meta, `${field}.meta`, ['caption', 'columns', 'striped', 'bordered', 'sticky_header', 'min_width']);
  const columns = value.columns !== undefined ? value.columns : meta.columns !== undefined ? meta.columns : [], rows = value.rows === undefined ? [] : value.rows;
  if (!Array.isArray(columns) || columns.length > DATA_TABLE_LIMITS.columns) throw new Error(`Некорректное поле ${field}.columns`);
  if (!Array.isArray(rows) || rows.length > DATA_TABLE_LIMITS.rows) throw new Error(`Некорректное поле ${field}.rows`);
  let cellCount = 0;
  return {
    caption: limited(value.caption !== undefined ? value.caption : meta.caption !== undefined ? meta.caption : '', `${field}.caption`, DATA_TABLE_LIMITS.caption),
    meta: dataTableSettings(meta, `${field}.meta`, 'meta'),
    columns: columns.map((column, index) => {
      const at = `${field}.columns[${index}]`;
      dataTableObject(column, at, ['id', 'key', 'title', 'align', 'width', 'nowrap']);
      return { id: dataTableId(column, 'column', at), key: limited(column.key === undefined ? '' : column.key, `${at}.key`, DATA_TABLE_LIMITS.key), title: limited(column.title === undefined ? '' : column.title, `${at}.title`, DATA_TABLE_LIMITS.title), ...dataTableSettings(column, at, 'column') };
    }),
    rows: rows.map((row, index) => {
      const at = `${field}.rows[${index}]`;
      dataTableObject(row, at, ['id', 'group', 'cells']);
      const id = dataTableId(row, 'row', at);
      if (Object.hasOwn(row, 'group') === Object.hasOwn(row, 'cells')) throw new Error(`Строка должна содержать либо group, либо cells (${at})`);
      if (Object.hasOwn(row, 'group')) return { id, group: limited(row.group, `${at}.group`, DATA_TABLE_LIMITS.title, { required: true }) };
      if (!Array.isArray(row.cells) || !row.cells.length || (cellCount += row.cells.length) > DATA_TABLE_LIMITS.cells) throw new Error(`Некорректное поле ${at}.cells`);
      return { id, cells: row.cells.map((cell, cellIndex) => {
        const cellAt = `${at}.cells[${cellIndex}]`;
        dataTableObject(cell, cellAt, ['id', 'value', 'key', 'align', 'colspan', 'rowspan', 'is_header', 'nowrap']);
        return { id: dataTableId(cell, 'cell', cellAt), value: limited(cell.value, `${cellAt}.value`, DATA_TABLE_LIMITS.value),
          ...(cell.key !== undefined ? { key: limited(cell.key, `${cellAt}.key`, DATA_TABLE_LIMITS.key) } : {}), ...dataTableSettings(cell, cellAt, 'cell') };
      }) };
    })
  };
}
function tableImageIds(value, field) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 12 || new Set(value).size !== value.length || value.some(item => !validId(item))) throw new Error(`Некорректное поле ${field}`);
  return [...value];
}
function tableCellSetting(key, value, field) {
  if (key === 'colspan' && (!Number.isInteger(value) || value < 1 || value > 12)
    || key === 'rowspan' && (!Number.isInteger(value) || value < 1 || value > 100)
    || key === 'is_header' && typeof value !== 'boolean'
    || key === 'media_width' && (!Number.isInteger(value) || value < 48 || value > 1600)
    || TABLE_CELL_META[key] && !TABLE_CELL_META[key].includes(value)) throw new Error(`Некорректное поле ${field}`);
  return value;
}
function tableCell(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Некорректная ячейка ${field}`);
  const allowed = new Set(['id', 'title', 'text', 'link', 'image_asset_id', 'image_asset_ids', 'meta', ...TABLE_CELL_SETTINGS]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(`Неизвестное поле ячейки ${field}`);
  const id = value.id === undefined ? legacyTableId('cell', field) : value.id;
  if (!validId(id)) throw new Error(`Некорректная ячейка ${field}`);
  const rawMeta = value.meta === undefined ? {} : value.meta;
  if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) throw new Error(`Некорректное поле ${field}.meta`);
  if (Object.keys(rawMeta).some(key => ![...TABLE_CELL_SETTINGS, 'image_asset_ids'].includes(key))) throw new Error(`Неизвестное поле ${field}.meta`);
  const directSingle = value.image_asset_id !== undefined;
  const directMultiple = value.image_asset_ids !== undefined;
  const metaMultiple = rawMeta.image_asset_ids !== undefined;
  if (Number(directSingle) + Number(directMultiple) + Number(metaMultiple) > 1) throw new Error(`Конфликт изображений ${field}`);
  let imageIds = [];
  if (directSingle) {
    if (!validId(value.image_asset_id)) throw new Error(`Некорректное поле ${field}.image_asset_id`);
    imageIds = [value.image_asset_id];
  } else if (directMultiple) imageIds = tableImageIds(value.image_asset_ids, `${field}.image_asset_ids`);
  else if (metaMultiple) imageIds = tableImageIds(rawMeta.image_asset_ids, `${field}.meta.image_asset_ids`);
  const meta = {};
  for (const key of TABLE_CELL_SETTINGS) {
    const direct = value[key], nested = rawMeta[key];
    if (direct !== undefined && nested !== undefined && direct !== nested) throw new Error(`Конфликт настроек ${field}.${key}`);
    const setting = direct ?? nested;
    if (setting !== undefined) meta[key] = tableCellSetting(key, setting, `${field}.meta.${key}`);
  }
  return { id, title: limited(value.title ?? '', `${field}.title`, 500), text: limited(value.text ?? '', `${field}.text`, 12000),
    link: safeUrl(value.link, `${field}.link`, { link: true }),
    ...(imageIds.length === 1 ? { image_asset_id: imageIds[0] } : imageIds.length > 1 ? { image_asset_ids: imageIds } : {}), meta };
}
function tableRow(value, field, count) {
  const legacy = Array.isArray(value), row = legacy ? { cells: value } : value;
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['id', 'cells'].includes(key))) throw new Error(`Некорректная строка ${field}`);
  const id = row.id === undefined ? legacyTableId('row', field) : row.id;
  if (!validId(id) || !Array.isArray(row.cells) || !row.cells.length || row.cells.length > 100 || count.value + row.cells.length > 100) throw new Error(`Некорректная строка ${field}`);
  count.value += row.cells.length;
  return { id, cells: row.cells.map((cell, index) => tableCell(cell, `${field}.cells[${index}]`)) };
}
function gridItem(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)) throw new Error(`Некорректный элемент ${field}`);
  if (Object.keys(value).some(key => !['id', 'title', 'text', 'link', 'link_text', 'image_asset_id', 'badge', 'date', 'meta'].includes(key))) throw new Error(`Неизвестное поле элемента ${field}`);
  const meta = value.meta === undefined ? {} : value.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`Некорректное поле ${field}.meta`);
  const normalized = {};
  for (const [key, entry] of Object.entries(meta)) {
    if (['badge', 'date'].includes(key)) normalized[key] = limited(entry, `${field}.meta.${key}`, 500);
    else if (key === 'date_iso') { if (typeof entry !== 'string' || entry && !/^\d{4}-\d{2}-\d{2}$/.test(entry)) throw new Error(`Некорректное поле ${field}.meta.${key}`); normalized[key] = entry; }
    else if (key === 'action_style') { if (!['link', 'primary'].includes(entry)) throw new Error(`Некорректное поле ${field}.meta.${key}`); normalized[key] = entry; }
    else if (key === 'media_width') { if (!Number.isInteger(entry) || entry < 48 || entry > 1600) throw new Error(`Некорректное поле ${field}.meta.${key}`); normalized[key] = entry; }
    else if (['media_mode', 'media_align'].includes(key) && GRID_META[key].includes(entry)) normalized[key] = entry;
    else throw new Error(`Некорректное поле ${field}.meta.${key}`);
  }
  return { id: value.id, title: limited(value.title ?? '', `${field}.title`, 500), text: limited(value.text ?? '', `${field}.text`, 12000),
    link: safeUrl(value.link, `${field}.link`, { link: true }), link_text: limited(value.link_text ?? '', `${field}.link_text`, 500),
    image_asset_id: limited(value.image_asset_id ?? '', `${field}.image_asset_id`, 64), badge: limited(value.badge ?? '', `${field}.badge`, 500),
    date: limited(value.date ?? '', `${field}.date`, 500), meta: normalized };
}
const EMBED_META = { map_height: true };
function linkMeta(value, field, item = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Некорректное поле ${field}`);
  const allowed = item ? ['kind', 'target', 'file_id', 'file_type', 'size', 'download'] : ['columns', 'compact'];
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key)) throw new Error(`Неизвестное поле ${field}.${key}`);
    if (key === 'columns' && (!Number.isInteger(entry) || entry < 1 || entry > 3)
      || key === 'file_id' && (!Number.isSafeInteger(entry) || entry < 1)
      || ['compact', 'download'].includes(key) && typeof entry !== 'boolean'
      || key === 'kind' && !['link', 'document'].includes(entry)
      || key === 'target' && !['self', 'blank', '_self', '_blank'].includes(entry)) throw new Error(`Некорректное поле ${field}.${key}`);
    result[key] = ['file_type', 'size'].includes(key) ? limited(entry, `${field}.${key}`, key === 'file_type' ? 10 : 100) : entry;
  }
  return result;
}
function linkItem(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)) throw new Error(`Некорректный элемент ${field}`);
  if (Object.keys(value).some(key => !['id', 'title', 'text', 'link', 'link_text', 'meta', 'sourceDocument'].includes(key))) throw new Error(`Неизвестное поле элемента ${field}`);
  const result = { id: value.id, title: limited(value.title ?? '', `${field}.title`, 500), text: limited(value.text ?? '', `${field}.text`, 12000),
    link: safeUrl(value.link, `${field}.link`, { link: true }), link_text: limited(value.link_text ?? '', `${field}.link_text`, 500), meta: linkMeta(value.meta === undefined ? {} : value.meta, `${field}.meta`, true) };
  if (value.sourceDocument !== undefined) result.sourceDocument = documentProvenance(value.sourceDocument);
  return result;
}
function sectionsMeta(value, field, item = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Некорректное поле ${field}`);
  const result = {}, allowed = item ? ['kind', 'target'] : ['columns', 'compact', 'show_icons'];
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key)) throw new Error(`Неизвестное поле ${field}.${key}`);
    if (key === 'columns' && (!Number.isInteger(entry) || entry < 1 || entry > 4)
      || ['compact', 'show_icons'].includes(key) && typeof entry !== 'boolean'
      || key === 'kind' && !['section', 'item', 'address', 'phone', 'email', 'hours'].includes(entry)
      || key === 'target' && !['self', 'blank', '_self', '_blank'].includes(entry)) throw new Error(`Некорректное поле ${field}.${key}`);
    result[key] = entry;
  }
  return result;
}
function sectionsItem(value, field, depth, ids, count) {
  if (depth > 6 || !value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)) throw new Error(`Некорректный элемент ${field}`);
  if (ids.has(value.id)) throw new Error('Дублирующийся id медиа или элемента');
  ids.add(value.id);
  if (++count.value > 100) throw new Error(`Слишком много элементов ${field}`);
  if (Object.keys(value).some(key => !['id', 'title', 'text', 'link', 'link_text', 'meta', 'children'].includes(key))) throw new Error(`Неизвестное поле элемента ${field}`);
  const children = value.children === undefined ? [] : value.children;
  if (!Array.isArray(children)) throw new Error(`Некорректные элементы ${field}.children`);
  return { id: value.id, title: limited(value.title ?? '', `${field}.title`, 500), text: limited(value.text ?? '', `${field}.text`, 12000),
    link: safeUrl(value.link, `${field}.link`, { link: true }), link_text: limited(value.link_text ?? '', `${field}.link_text`, 500),
    meta: sectionsMeta(value.meta === undefined ? {} : value.meta, `${field}.meta`, true),
    children: children.map((child, index) => sectionsItem(child, `${field}.children[${index}]`, depth + 1, ids, count)) };
}
function blockMeta(value, field, type) {
  if (type === 'links') return linkMeta(value, field);
  if (type === 'sections') return sectionsMeta(value, field);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Некорректное поле ${field}`);
  if (type === 'table') {
    if (Object.keys(value).length) throw new Error(`Некорректное поле ${field}`);
    return {};
  }
  const allowed = type === 'service' ? SERVICE_META : type === 'content' ? CONTENT_META : type === 'embed' ? EMBED_META : type === 'grid' ? GRID_META : BANNER_META;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (type === 'embed' && key === 'map_height') {
      if (!Number.isInteger(item) || item < 280 || item > 720) throw new Error(`Некорректное поле ${field}.${key}`);
    } else if (key === 'columns' && type === 'grid') {
      if (!Number.isInteger(item) || item < 1 || item > 6) throw new Error(`Некорректное поле ${field}.${key}`);
    } else if (key === 'item_max_width' && type === 'grid') {
      if (!Number.isInteger(item) || item < 48 || item > 1600) throw new Error(`Некорректное поле ${field}.${key}`);
    } else if (key === 'show_border' && type === 'grid') {
      if (typeof item !== 'boolean') throw new Error(`Некорректное поле ${field}.${key}`);
    } else if (key === 'media_width' && type !== 'embed') {
      if (!Number.isInteger(item) || item < 48 || item > 1600) throw new Error(`Некорректное поле ${field}.${key}`);
    } else if (!Array.isArray(allowed[key]) || !allowed[key].includes(item)) throw new Error(`Некорректное поле ${field}.${key}`);
    result[key] = item;
  }
  return result;
}
function block(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)) throw new Error(`Некорректный блок ${field}`);
  const legacy = LEGACY_TYPES[value.type], type = BLOCK_TYPES.find(item => item.name === (legacy?.[0] || value.type));
  if (!type) throw new Error(`Некорректный блок ${field}`);
  const view = value.view ?? legacy?.[1] ?? type.default_view;
  if (!type.views.includes(view)) throw new Error(`Некорректный вид отображения ${field}.view`);
  const allowed = new Set(['id', 'type', 'view', 'title', 'text', 'description', 'content', 'settings', 'media', 'review', 'reviewedRevision', ...(['big-media', 'table', 'data-table', 'service', 'content', 'embed', 'links', 'sections', 'grid'].includes(type.name) ? ['meta'] : []), ...(type.name === 'embed' ? ['sourceFrame'] : []), ...(['links', 'sections', 'grid'].includes(type.name) ? ['items'] : []), ...(type.name === 'table' ? ['rows'] : type.name === 'data-table' ? ['rows', 'columns'] : []), ...type.fields.map(item => item.name)]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(`Неизвестное поле блока ${field}`);
  if (value.reviewedRevision !== undefined && (!Number.isSafeInteger(value.reviewedRevision) || value.reviewedRevision < 1)) throw new Error(`Некорректная reviewedRevision ${field}`);
  // Grid items and their images are shared across views. Keep the same limit
  // when a populated gallery changes to a view without an item editor.
  if (!Array.isArray(value.media) || value.media.length > (type.name === 'table' ? 1200 : type.name === 'grid' ? 112 : 12)) throw new Error(`Некорректные медиа ${field}`);
  if (type.name === 'data-table' && value.media.length) throw new Error(`Таблица данных не поддерживает медиа (${field}.media)`);
  // Accept the retired description field in old documents, but omit it from
  // the normalized model and subsequent saves. Reading never rewrites disk.
  const result = { id: value.id, type: type.name, view, title: limited(value.title ?? '', `${field}.title`, 200), text: limited(value.text ?? value.content ?? '', `${field}.text`, 12000),
    content: limited(value.content || '', `${field}.content`, 12000),
    settings: limited(value.settings || '', `${field}.settings`, 4000), review: review(value.review, `${field}.review`), media: value.media.map((item, index) => media(item, `${field}.media[${index}]`)) };
  if (value.sourceFrame !== undefined) result.sourceFrame = frameProvenance(value.sourceFrame);
  if (type.name === 'data-table') Object.assign(result, dataTable(value, field));
  else if (value.meta !== undefined) result.meta = blockMeta(value.meta, `${field}.meta`, type.name);
  if (type.name === 'links') {
    const items = value.items === undefined ? [] : value.items;
    if (!Array.isArray(items) || items.length > 100) throw new Error(`Некорректные элементы ${field}.items`);
    result.items = items.map((item, index) => linkItem(item, `${field}.items[${index}]`));
    result.meta ??= {};
  }
  if (type.name === 'sections') {
    const items = value.items === undefined ? [] : value.items;
    if (!Array.isArray(items)) throw new Error(`Некорректные элементы ${field}.items`);
    const ids = new Set(), count = { value: 0 };
    result.items = items.map((item, index) => sectionsItem(item, `${field}.items[${index}]`, 1, ids, count));
    result.meta ??= {};
  }
  if (type.name === 'grid') {
    const items = value.items === undefined ? [] : value.items;
    if (!Array.isArray(items) || items.length > 100) throw new Error(`Некорректные элементы ${field}.items`);
    result.items = items.map((item, index) => gridItem(item, `${field}.items[${index}]`));
    const ids = new Set(result.media.map(asset => asset.id));
    for (const item of result.items) if (item.image_asset_id && !ids.has(item.image_asset_id)) throw new Error(`Неизвестное изображение ${field}.items`);
    result.meta ??= {};
  }
  if (type.name === 'table') {
    const rows = value.rows === undefined ? [] : value.rows;
    if (!Array.isArray(rows) || rows.length > 100) throw new Error(`Некорректные строки ${field}.rows`);
    const count = { value: 0 };
    result.rows = rows.map((row, index) => tableRow(row, `${field}.rows[${index}]`, count));
    const mediaIds = new Set(result.media.map(asset => asset.id));
    for (const cell of result.rows.flatMap(row => row.cells)) {
      const imageIds = cell.image_asset_ids || (cell.image_asset_id ? [cell.image_asset_id] : []);
      if (imageIds.some(id => !mediaIds.has(id))) throw new Error(`Неизвестное изображение ${field}.rows`);
    }
    result.meta ??= {};
  }
  for (const spec of type.fields) {
    const item = value[spec.name]; if (item === undefined || item === '') continue;
    if (spec.kind === 'boolean') { if (typeof item !== 'boolean') throw new Error(`Некорректное поле ${field}.${spec.name}`); result[spec.name] = item; }
    else if (spec.kind === 'select') { if (!spec.values.includes(item)) throw new Error(`Некорректное поле ${field}.${spec.name}`); result[spec.name] = item; }
    else result[spec.name] = ['url', 'link'].includes(spec.kind) ? safeUrl(item, `${field}.${spec.name}`, { link: spec.kind === 'link' }) : limited(item, `${field}.${spec.name}`, 1000);
  }
  return result;
}
function derivedReview(blocks) {
  const failed = blocks.filter(item => item.review.status === 'failed');
  if (failed.length) return { status: 'failed', reason: failed.map(item => item.review.reason).filter(Boolean).join(' ').slice(0, 1000) };
  return { status: blocks.length && blocks.every(item => item.review.status === 'passed') ? 'passed' : 'unreviewed', reason: '' };
}
function section(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id) || !Array.isArray(value.blocks) || value.blocks.length > 40) throw new Error(`Некорректный раздел ${field}`);
  // Version 1 files contain a section review. Validate it for compatibility, but
  // never let a stale manual value override the reviews of the section blocks.
  review(value.review, `${field}.review`);
  const blocks = value.blocks.map((item, index) => block(item, `${field}.blocks[${index}]`));
  return { id: value.id, title: limited(value.title, `${field}.title`, 200, { required: true }), review: derivedReview(blocks), blocks };
}
function validateDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION || !value.source || !Array.isArray(value.tabs) || value.tabs.length > 12) throw new Error('Некорректный JSON шага 3');
  const document = { version: VERSION, source: { hostname: limited(value.source.hostname, 'source.hostname', 255, { required: true }), htmlSha256: limited(value.source.htmlSha256, 'source.htmlSha256', 64, { required: true }) },
    common: section(value.common, 'common'), tabs: value.tabs.map((item, index) => section(item, `tabs[${index}]`)) };
  const ids = new Set();
  if (!/^[a-f0-9]{64}$/.test(document.source.htmlSha256)) throw new Error('Некорректный source.htmlSha256');
  for (const item of [document.common, ...document.tabs]) {
    if (ids.has(item.id)) throw new Error('Дублирующийся id раздела'); ids.add(item.id);
    for (const child of item.blocks) {
      if (ids.has(child.id)) throw new Error('Дублирующийся id блока'); ids.add(child.id);
      const visit = item => { if (ids.has(item.id)) throw new Error('Дублирующийся id медиа или элемента'); ids.add(item.id); for (const nested of item.children || []) visit(nested); };
      for (const asset of [...child.media, ...(child.items || []), ...(child.columns || [])]) visit(asset);
      for (const row of child.rows || []) { visit(row); for (const cell of row.cells || []) visit(cell); }
    }
  }
  return document;
}
function statusSummary(document) {
  const reviews = [document.common, ...document.tabs].flatMap(item => item.blocks.map(child => child.review));
  const failed = reviews.filter(item => item.status === 'failed').length, passed = reviews.filter(item => item.status === 'passed').length;
  const unreviewed = reviews.length - failed - passed;
  return { status: failed ? 'failed' : unreviewed || !reviews.length ? 'unreviewed' : 'passed', total: reviews.length, passed, failed, unreviewed };
}
function emptyDocument(job) {
  const hostname = new URL(job.url).hostname;
  return validateDocument({ version: VERSION, source: { hostname, htmlSha256: '0'.repeat(64) },
    common: { id: 'common', title: 'Общая часть', review: { status: 'unreviewed', reason: '' }, blocks: [] }, tabs: [] });
}
// A pristine document carries no content and no source.html binding: it is the
// only state where the builder may attach the page to a step 2 HTML revision.
function isPristine(document) {
  return Boolean(document) && document.source?.htmlSha256 === '0'.repeat(64)
    && document.tabs.length === 0 && document.common?.blocks?.length === 0;
}
class PageBuilderStore {
  constructor(root, resolveJob) { this.root = path.join(root, 'page-builder'); fs.mkdirSync(this.root, { recursive: true }); this.resolveJob = resolveJob; }
  legacyFile(jobId) { if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error('Некорректный ID задания'); return path.join(this.root, `${jobId}.json`); }
  attempt(jobId, number) {
    const job = this.resolveJob?.(jobId);
    number ??= job?.attempts.at(-1)?.number;
    if (!Number.isSafeInteger(number) || number < 1 || (job && !job.attempts.some(item => item.number === number))) throw Object.assign(new Error('Попытка шага 3 не найдена'), { statusCode: 409 });
    return number;
  }
  file(jobId, attempt) { this.legacyFile(jobId); return path.join(this.root, jobId, `attempt-${String(this.attempt(jobId, attempt)).padStart(3, '0')}.json`); }
  migrateLegacy(jobId) {
    const legacy = this.legacyFile(jobId), marker = path.join(this.root, jobId, 'legacy-binding.json');
    if (!fs.existsSync(legacy) && !fs.existsSync(marker)) return;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    let binding;
    if (fs.existsSync(marker)) binding = JSON.parse(fs.readFileSync(marker, 'utf8'));
    else {
      // Fix the owner durably before publishing. Recovery must never reassign
      // a legacy document to a retry created after an interrupted migration.
      binding = { attempt: this.attempt(jobId), sha256: crypto.createHash('sha256').update(fs.readFileSync(legacy)).digest('hex'), complete: false };
      atomicJson(marker, binding);
    }
    const target = this.file(jobId, binding.attempt);
    if (binding.complete === true) {
      if (!fs.existsSync(target)) throw new Error('Утрачен документ перенесённой попытки шага 3');
      return;
    }
    const bytes = fs.readFileSync(legacy);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== binding.sha256) throw new Error('Исходный документ шага 3 изменился во время переноса');
    const stored = JSON.parse(bytes); this.validateStored(stored);
    if (!fs.existsSync(target)) atomicJson(target, stored);
    if (JSON.stringify(JSON.parse(fs.readFileSync(target, 'utf8'))) !== JSON.stringify(stored)) throw new Error('Конфликт переноса документа шага 3');
    atomicJson(marker, { ...binding, complete: true });
    // Keep the original job-level JSON as a recovery copy, including after success.
  }
  validateStored(stored) {
    if (!Number.isSafeInteger(stored.revision) || stored.revision < 1) throw new Error('Некорректная revision шага 3');
    return { revision: stored.revision, updatedAt: limited(stored.updatedAt, 'updatedAt', 64, { required: true }), document: validateDocument(stored.document), blockTypes: BLOCK_TYPES,
      ...(stored.syncRequested === true ? { syncRequested: true } : {}) };
  }
  read(jobId, { create = true, attempt } = {}) {
    attempt = this.attempt(jobId, attempt); this.migrateLegacy(jobId);
    const file = this.file(jobId, attempt);
    if (create) fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) { if (!create) return null; if (!this.resolveJob) throw new Error('Для новой страницы требуется задание'); atomicJson(file, { revision: 1, updatedAt: new Date().toISOString(), document: emptyDocument(this.resolveJob(jobId)) }); }
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = { ...this.validateStored(stored), attempt };
    if (this.sync) result.sync = this.sync.projection(jobId, attempt, result.document);
    return result;
  }
  // A forced rebuild restarts from the default page. The reset must not go
  // through write(): no syncRequested and no enqueue, so the site keeps the
  // previous published version until the fresh assembly saves its first tab.
  reset(jobId, attempt) {
    attempt = this.attempt(jobId, attempt); this.migrateLegacy(jobId);
    const file = this.file(jobId, attempt);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicJson(file, { revision: 1, updatedAt: new Date().toISOString(), document: emptyDocument(this.resolveJob(jobId)) });
    return this.read(jobId, { attempt });
  }
  write(jobId, expectedRevision, document, attempt, options = {}) {
    this.assertWritable?.(jobId);
    const prepared = this.prepareWrite(jobId, expectedRevision, document, attempt, options);
    atomicJson(this.file(jobId, prepared.attempt), { revision: prepared.revision, updatedAt: prepared.updatedAt, document: prepared.document,
      ...(prepared.syncRequested ? { syncRequested: true } : {}) });
    // The document is the recovery source if a process dies between these two
    // atomic writes. Every normal save also durably coalesces the object outbox.
    if (prepared.syncRequested) this.sync?.enqueue(jobId, prepared.attempt, prepared.document, prepared.revision);
    this.sync?.wake();
    return this.read(jobId, { attempt: prepared.attempt });
  }
  prepareWrite(jobId, expectedRevision, document, attempt, options = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw Object.assign(new Error('Требуется revision'), { statusCode: 409 });
    const current = this.read(jobId, { attempt }); attempt = current.attempt;
    if (current.revision !== expectedRevision) throw Object.assign(new Error('Данные шага 3 уже изменены; обновите страницу'), { statusCode: 409 });
    const validated = validateDocument(document);
    if (options.sourceBinding !== undefined) {
      // Only the builder attaches a page to its step 2 HTML, and only while the
      // document is still pristine; the submitted htmlSha256 value is ignored.
      if (!/^[a-f0-9]{64}$/.test(options.sourceBinding) || options.sourceBinding === '0'.repeat(64)) throw new Error('Некорректная привязка source.html');
      if (!isPristine(current.document)) throw new Error('Привязка source.html доступна только для пустого документа');
      if (validated.source.hostname !== current.document.source.hostname) throw new Error('Происхождение исходного HTML неизменяемо');
      validated.source.htmlSha256 = options.sourceBinding;
    } else if (validated.source.hostname !== current.document.source.hostname || validated.source.htmlSha256 !== current.document.source.htmlSha256) throw new Error('Происхождение исходного HTML неизменяемо');
    // Old drafts may contain empty rich-content blocks. Keep them readable and
    // let unrelated writes pass, but require both fields when that block is edited.
    const existingBlocks = new Map([current.document.common, ...current.document.tabs].flatMap(section => section.blocks.map(block => [block.id, block])));
    for (const block of [validated.common, ...validated.tabs].flatMap(section => section.blocks)) {
      if (block.type !== 'rich-content' || JSON.stringify(block) === JSON.stringify(existingBlocks.get(block.id))) continue;
      if (!block.text.trim()) throw new Error('Для HTML-фрагмента заполните HTML');
      if (!block.reason?.trim()) throw new Error('Для HTML-фрагмента заполните обоснование');
    }
    // The site renders pooled media only through the wire contract fields, so a
    // pool without rendering references never reaches the page. Old documents
    // stay readable and untouched blocks keep saving; an edited (or new) block
    // must already follow the image mechanics of its type. The builder writes
    // into a pristine document, so every assembled block is checked. Reviews
    // and key order are ignored by the comparison: a review-only change of an
    // old block is not a media edit.
    const mechanics = value => Array.isArray(value) ? `[${value.map(mechanics).join(',')}]`
      : value && typeof value === 'object' ? `{${Object.keys(value).filter(key => !['review', 'reviewedRevision'].includes(key)).sort().map(key => `${JSON.stringify(key)}:${mechanics(value[key])}`).join(',')}}`
        : JSON.stringify(value);
    for (const block of [validated.common, ...validated.tabs].flatMap(section => section.blocks)) {
      const existing = existingBlocks.get(block.id);
      if (!block.media.length || existing && mechanics(block) === mechanics(existing)) continue;
      if (block.type === 'grid' || block.type === 'table') {
        const referenced = new Set();
        if (block.type === 'grid') {
          for (const item of block.items || []) if (item.image_asset_id) referenced.add(item.image_asset_id);
        } else {
          for (const row of block.rows || []) for (const cell of row.cells || []) for (const id of cell.image_asset_ids || (cell.image_asset_id ? [cell.image_asset_id] : [])) referenced.add(id);
        }
        const unused = block.media.map(asset => asset.id).filter(id => !referenced.has(id));
        if (unused.length) throw new Error(block.type === 'grid'
          ? `Изображения блока ${block.id} без элемента не отображаются: ${unused.join(', ')} (grid рендерит картинки только через item.image_asset_id)`
          : `Изображения блока ${block.id} без ячейки не отображаются: ${unused.join(', ')} (table рендерит картинки только в ячейках)`);
      } else if (block.type === 'content' || block.type === 'service') {
        if (block.media.length > 2) throw new Error(`Блок ${block.id} отображает не более двух изображений (media[0] слева, media[1] справа)`);
      } else if (block.type === 'big-media') {
        if (block.media.length > 1) throw new Error(`Блок ${block.id} отображает не более одного изображения (media[0])`);
      } else if (block.type === 'links' || block.type === 'sections' || block.type === 'embed' || block.type === 'rich-content') throw new Error(`Блок ${block.id} не отображает изображения`);
    }
    this.validateMedia?.(jobId, validated, current.document, attempt);
    const previous = new Map([current.document.common, ...current.document.tabs].flatMap(section => section.blocks.map(block => [block.id, { sectionId: section.id, block }])));
    const submitted = new Map([document.common, ...document.tabs].flatMap(section => section.blocks.map(block => [block.id, block])));
    const content = block => { const { review, ...fields } = block; return JSON.stringify(fields); };
    for (const section of [validated.common, ...validated.tabs]) {
      // A new block or a different placement requires a fresh visual review.
      // Reordering within the same section preserves the block's own review.
      for (const block of section.blocks) {
        const old = previous.get(block.id);
        if (!old || old.sectionId !== section.id || (content(old.block) !== content(block) && submitted.get(block.id).reviewedRevision !== expectedRevision)) block.review = { status: 'unreviewed', reason: '' };
      }
      section.review = derivedReview(section.blocks);
    }
    this.sync?.enforceReview(jobId, attempt, current.document, validated);
    for (const section of [validated.common, ...validated.tabs]) section.review = derivedReview(section.blocks);
    const job = this.resolveJob?.(jobId), eligible = this.sync && job?.attempts.at(-1)?.number === attempt
      && ['complete', 'ready_with_issues'].includes(job.attempts.at(-1).htmlMedia?.status);
    const next = { revision: current.revision + 1, updatedAt: new Date().toISOString(), document: validated,
      ...(current.syncRequested || eligible ? { syncRequested: true } : {}) };
    return { ...next, attempt, blockTypes: BLOCK_TYPES };
  }
  summary(jobId, attempt) {
    let company = {};
    try {
      if (this.sync) company = { companyId: this.sync.companyId(jobId, attempt) };
      const stored = this.read(jobId, { create: false, attempt });
      return stored ? { ...statusSummary(stored.document), revision: stored.revision, ...company,
        ...(stored.sync ? { syncVersion: stored.sync.version, pending: stored.sync.pendingCount } : {}) }
        : { status: 'unreviewed', total: 0, passed: 0, failed: 0, unreviewed: 0, revision: 0, ...company };
    }
    catch (error) { return { status: 'system_error', error: error.message, total: 0, passed: 0, failed: 0, unreviewed: 0, revision: 0, ...company }; }
  }
  media(jobId, mediaId, attempt) {
    const stored = this.read(jobId, { attempt }), assets = [];
    for (const item of [stored.document.common, ...stored.document.tabs]) for (const child of item.blocks) assets.push(...child.media);
    return assets.find(item => item.id === mediaId) || null;
  }
}
module.exports = { PageBuilderStore, validateDocument, statusSummary, derivedReview, BLOCK_TYPES, DATA_TABLE_LIMITS, isPristine };
