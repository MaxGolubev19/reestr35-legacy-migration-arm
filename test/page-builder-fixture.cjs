'use strict';
const fs = require('node:fs');
const path = require('node:path'), crypto = require('node:crypto');
const { APP_ROOT } = require('../src/data-dir.cjs');
const { validateDocument } = require('../src/stages/page-builder/store.cjs');
const VERSION = 1;
const cleanText = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&quot;/gi, '"').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();

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


function seedMoriPage(queue, job) {
  queue.pageBuilder.read(job.id);
  fs.writeFileSync(queue.pageBuilder.file(job.id), JSON.stringify({
    revision: 1, updatedAt: new Date().toISOString(), document: sourceData()
  }));
}

module.exports = { seedMoriPage, sourceData };
