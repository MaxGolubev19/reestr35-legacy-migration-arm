'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicJson } = require('../../infrastructure/files.cjs');
const { provenance } = require('../../infrastructure/media.cjs');

const VERSION = 1;
const STATUSES = new Set(['unreviewed', 'passed', 'failed']);
// Portable projection of company-block-contract.v1.json (1.0): only root scalar
// payload fields. Nested rows/items/meta are intentionally outside this editor.
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
  return { id: value.id, originalUrl: safeUrl(value.originalUrl, `${field}.originalUrl`), bigUrl: safeUrl(value.bigUrl, `${field}.bigUrl`), href: safeUrl(value.href, `${field}.href`, { link: true }), alt: limited(value.alt ?? '', `${field}.alt`, 500), caption: limited(value.caption ?? '', `${field}.caption`, 1000),
    ...(value.originalMedia ? { originalMedia: provenance(value.originalMedia) } : {}), ...(value.bigMedia ? { bigMedia: provenance(value.bigMedia) } : {}) };
}
function block(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)) throw new Error(`Некорректный блок ${field}`);
  const legacy = LEGACY_TYPES[value.type], type = BLOCK_TYPES.find(item => item.name === (legacy?.[0] || value.type));
  if (!type) throw new Error(`Некорректный блок ${field}`);
  const view = value.view ?? legacy?.[1] ?? type.default_view;
  if (!type.views.includes(view)) throw new Error(`Некорректный вид отображения ${field}.view`);
  const allowed = new Set(['id', 'type', 'view', 'title', 'text', 'description', 'content', 'settings', 'media', 'review', 'reviewedRevision', ...type.fields.map(item => item.name)]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(`Неизвестное поле блока ${field}`);
  if (value.reviewedRevision !== undefined && (!Number.isSafeInteger(value.reviewedRevision) || value.reviewedRevision < 1)) throw new Error(`Некорректная reviewedRevision ${field}`);
  if (!Array.isArray(value.media) || value.media.length > 12) throw new Error(`Некорректные медиа ${field}`);
  // Accept the retired description field in old documents, but omit it from
  // the normalized model and subsequent saves. Reading never rewrites disk.
  const result = { id: value.id, type: type.name, view, title: limited(value.title ?? '', `${field}.title`, 200), text: limited(value.text ?? value.content ?? '', `${field}.text`, 12000),
    content: limited(value.content || '', `${field}.content`, 12000),
    settings: limited(value.settings || '', `${field}.settings`, 4000), review: review(value.review, `${field}.review`), media: value.media.map((item, index) => media(item, `${field}.media[${index}]`)) };
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
    for (const child of item.blocks) { if (ids.has(child.id)) throw new Error('Дублирующийся id блока'); ids.add(child.id); for (const asset of child.media) { if (ids.has(asset.id)) throw new Error('Дублирующийся id медиа'); ids.add(asset.id); } }
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
    return { revision: stored.revision, updatedAt: limited(stored.updatedAt, 'updatedAt', 64, { required: true }), document: validateDocument(stored.document), blockTypes: BLOCK_TYPES };
  }
  read(jobId, { create = true, attempt } = {}) {
    attempt = this.attempt(jobId, attempt); this.migrateLegacy(jobId);
    const file = this.file(jobId, attempt);
    if (create) fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) { if (!create) return null; if (!this.resolveJob) throw new Error('Для новой страницы требуется задание'); atomicJson(file, { revision: 1, updatedAt: new Date().toISOString(), document: emptyDocument(this.resolveJob(jobId)) }); }
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...this.validateStored(stored), attempt };
  }
  write(jobId, expectedRevision, document, attempt) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw Object.assign(new Error('Требуется revision'), { statusCode: 409 });
    const current = this.read(jobId, { attempt }); attempt = current.attempt;
    if (current.revision !== expectedRevision) throw Object.assign(new Error('Данные шага 3 уже изменены; обновите страницу'), { statusCode: 409 });
    const validated = validateDocument(document);
    if (validated.source.hostname !== current.document.source.hostname || validated.source.htmlSha256 !== current.document.source.htmlSha256) throw new Error('Происхождение исходного HTML неизменяемо');
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
    const next = { revision: current.revision + 1, updatedAt: new Date().toISOString(), document: validated };
    atomicJson(this.file(jobId, attempt), next); return { ...next, attempt, blockTypes: BLOCK_TYPES };
  }
  summary(jobId, attempt) {
    try { const stored = this.read(jobId, { create: false, attempt }); return stored ? { ...statusSummary(stored.document), revision: stored.revision } : { status: 'unreviewed', total: 0, passed: 0, failed: 0, unreviewed: 0, revision: 0 }; }
    catch (error) { return { status: 'system_error', error: error.message, total: 0, passed: 0, failed: 0, unreviewed: 0, revision: 0 }; }
  }
  media(jobId, mediaId, attempt) {
    const stored = this.read(jobId, { attempt }), assets = [];
    for (const item of [stored.document.common, ...stored.document.tabs]) for (const child of item.blocks) assets.push(...child.media);
    return assets.find(item => item.id === mediaId) || null;
  }
}
module.exports = { PageBuilderStore, validateDocument, statusSummary, derivedReview, BLOCK_TYPES };
