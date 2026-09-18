'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { APP_ROOT } = require('../../data-dir.cjs');
const { atomicJson } = require('../../infrastructure/files.cjs');

const VERSION = 1;
const STATUSES = new Set(['unreviewed', 'passed', 'failed']);
const TYPES = new Set(['hero', 'text', 'buttons', 'image', 'gallery', 'table', 'video']);
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const cleanText = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&quot;/gi, '"').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
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
function media(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !idPattern.test(value.id || '')) throw new Error(`Некорректное медиа ${field}`);
  const originalUrl = limited(value.originalUrl || '', `${field}.originalUrl`, 4096, { required: true });
  let parsed; try { parsed = new URL(originalUrl); } catch { throw new Error(`Некорректный URL ${field}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(`Некорректный URL ${field}`);
  return { id: value.id, alt: limited(value.alt || '', `${field}.alt`, 500), originalUrl: parsed.href };
}
function block(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !idPattern.test(value.id || '') || !TYPES.has(value.type)) throw new Error(`Некорректный блок ${field}`);
  if (!Array.isArray(value.media) || value.media.length > 12) throw new Error(`Некорректные медиа ${field}`);
  return { id: value.id, type: value.type, title: limited(value.title, `${field}.title`, 200, { required: true }),
    description: limited(value.description || '', `${field}.description`, 500), content: limited(value.content || '', `${field}.content`, 12000),
    settings: limited(value.settings || '', `${field}.settings`, 4000), review: review(value.review, `${field}.review`), media: value.media.map((item, index) => media(item, `${field}.media[${index}]`)) };
}
function derivedReview(blocks) {
  const failed = blocks.filter(item => item.review.status === 'failed');
  if (failed.length) return { status: 'failed', reason: failed.map(item => item.review.reason).filter(Boolean).join(' ').slice(0, 1000) };
  return { status: blocks.length && blocks.every(item => item.review.status === 'passed') ? 'passed' : 'unreviewed', reason: '' };
}
function section(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !idPattern.test(value.id || '') || !Array.isArray(value.blocks) || value.blocks.length > 40) throw new Error(`Некорректный раздел ${field}`);
  // Version 1 files contain a section review. Validate it for compatibility, but
  // never let a stale manual value override the reviews of the section blocks.
  review(value.review, `${field}.review`);
  const blocks = value.blocks.map((item, index) => block(item, `${field}.blocks[${index}]`));
  return { id: value.id, title: limited(value.title, `${field}.title`, 200, { required: true }), review: derivedReview(blocks), blocks };
}
function validateDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION || !value.source || !Array.isArray(value.tabs) || value.tabs.length < 1 || value.tabs.length > 12) throw new Error('Некорректный JSON шага 3');
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
function sourceData() {
  const file = path.join(APP_ROOT, 'src', 'resources', 'html', 'mori-cinema.reestr35.ru.html');
  const html = fs.readFileSync(file, 'utf8'), sha256 = crypto.createHash('sha256').update(html).digest('hex');
  const images = [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match, index) => {
    const tag = match[0], alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || '';
    return { id: `mori-media-${index + 1}`, alt: cleanText(alt), originalUrl: new URL(match[1], 'https://mori-cinema.reestr35.ru/').href };
  });
  const embeds = [...html.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match, index) => ({ id: `mori-video-${index + 1}`, alt: `Rutube видео ${index + 1}`, originalUrl: new URL(match[1], 'https://mori-cinema.reestr35.ru/').href }));
  const take = (...indexes) => indexes.map(index => images[index]).filter(Boolean);
  const r = (status = 'unreviewed', reason = '') => ({ status, reason });
  const b = (id, type, title, description, content, settings, mediaItems, status = 'unreviewed', reason = '') => ({ id, type, title, description, content, settings, media: mediaItems, review: r(status, reason) });
  const document = { version: VERSION, source: { hostname: 'mori-cinema.reestr35.ru', htmlSha256: sha256 },
    common: { id: 'common', title: 'Общая часть', review: r('unreviewed'), blocks: [
      b('common-hero', 'hero', 'MORI CINEMA', 'Главный баннер и адрес', 'Череповец, ул. Годовикова, 37', 'Широкий баннер · текст по центру', take(0), 'passed'),
      b('common-actions', 'buttons', 'Быстрые действия', 'Кнопки перехода к расписанию', 'Расписание сеансов\nКупить билет', 'Две кнопки в ряд, ссылки открываются в новой вкладке', take(1, 2)) ] },
    tabs: [
      { id: 'news', title: 'Акции/новости', review: r('failed', 'Нужно проверить порядок старых акций.'), blocks: [
        b('news-lead', 'image', 'Комбосреда', 'Акционный баннер со ссылкой', 'Акция кинотеатра', 'Изображение 600×338, центр', take(3), 'passed'),
        b('news-vacancy', 'text', 'Вакансии', 'Текст с маркированными списками', 'В кинотеатр MORI CINEMA ТРЦ «ИЮНЬ» требуются: бармен-кассир.', 'Обычный текст · красный акцент', take(4), 'failed', 'Длинный текст нужно сверить с источником.'),
        b('news-promos', 'gallery', 'Архив акций', 'Галерея акционных карточек', 'Детский билет, подарочный билет и другие акции', 'Сетка 3 колонки', take(5, 6, 7, 8)) ] },
      { id: 'posters', title: 'Афиша', review: r('passed'), blocks: [ b('posters-gallery', 'gallery', 'Афиша', 'Постеры фильмов из legacy HTML', 'Актуальные на момент снимка афиши', 'Сетка 2 колонки · полная ширина', take(21, 22, 23, 24), 'passed') ] },
      { id: 'prices', title: 'Цены', review: r('unreviewed'), blocks: [ b('prices-table', 'table', 'Цены на билеты', 'Табличный блок и два прайса', 'Сеанс; 2D; 3D\nБудни; по расписанию; по расписанию', 'Таблица с горизонтальным скроллом на мобильном', take(25, 26)) ] },
      { id: 'about', title: 'О нас', review: r('unreviewed'), blocks: [
        b('about-text', 'text', 'О кинотеатре', 'Описание залов и оборудования', 'Все залы кинотеатра оборудованы системой многоканального звука Dolby Digital Surround EX.', 'Максимальная ширина текста 760 px', take()),
        b('about-gallery', 'gallery', 'Фотогалерея', 'Интерьеры MORI CINEMA', 'Фотографии кинозалов', 'Сетка 3 колонки', take(27, 28, 29, 30, 31, 32)),
        b('about-video', 'video', 'Видео', 'Внешние Rutube embed из legacy HTML', '18 видео со старой страницы', 'Внешние embed показаны как метаданные и не загружаются из сети', embeds.slice(0, 6)) ] }
    ] };
  return validateDocument(document);
}
class PageBuilderStore {
  constructor(root) { this.root = path.join(root, 'page-builder'); fs.mkdirSync(this.root, { recursive: true }); this.template = sourceData(); }
  file(jobId) { if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error('Некорректный ID задания'); return path.join(this.root, `${jobId}.json`); }
  read(jobId, { create = true } = {}) {
    const file = this.file(jobId);
    if (!fs.existsSync(file)) { if (!create) return null; atomicJson(file, { revision: 1, updatedAt: new Date().toISOString(), document: this.template }); }
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(stored.revision) || stored.revision < 1) throw new Error('Некорректная revision шага 3');
    return { revision: stored.revision, updatedAt: limited(stored.updatedAt, 'updatedAt', 64, { required: true }), document: validateDocument(stored.document) };
  }
  write(jobId, expectedRevision, document) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw Object.assign(new Error('Требуется revision'), { statusCode: 409 });
    const current = this.read(jobId);
    if (current.revision !== expectedRevision) throw Object.assign(new Error('Данные шага 3 уже изменены; обновите страницу'), { statusCode: 409 });
    const validated = validateDocument(document);
    if (validated.source.hostname !== current.document.source.hostname || validated.source.htmlSha256 !== current.document.source.htmlSha256) throw new Error('Происхождение исходного HTML неизменяемо');
    const next = { revision: current.revision + 1, updatedAt: new Date().toISOString(), document: validated };
    atomicJson(this.file(jobId), next); return next;
  }
  summary(jobId) {
    try { const stored = this.read(jobId, { create: false }); return stored ? { ...statusSummary(stored.document), revision: stored.revision } : { status: 'unreviewed', total: 0, passed: 0, failed: 0, unreviewed: 0, revision: 0 }; }
    catch (error) { return { status: 'system_error', error: error.message, total: 0, passed: 0, failed: 0, unreviewed: 0, revision: 0 }; }
  }
  media(jobId, mediaId) {
    const stored = this.read(jobId), assets = [];
    for (const item of [stored.document.common, ...stored.document.tabs]) for (const child of item.blocks) assets.push(...child.media);
    return assets.find(item => item.id === mediaId) || null;
  }
}
module.exports = { PageBuilderStore, validateDocument, statusSummary, derivedReview };
