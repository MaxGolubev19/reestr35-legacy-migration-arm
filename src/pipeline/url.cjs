'use strict';
function normalizeUrl(input) {
  if (typeof input !== 'string' || input.length > 4096 || /[\u0000-\u0020\\]/.test(input)) throw new Error('Нужен абсолютный HTTPS URL без пробелов');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+reestr35\.ru$/i.test(url.hostname)) {
    throw new Error('Разрешены только HTTPS URL поддоменов *.reestr35.ru без логина и нестандартного порта');
  }
  url.hash = '';
  return url.href;
}

module.exports = { normalizeUrl };
