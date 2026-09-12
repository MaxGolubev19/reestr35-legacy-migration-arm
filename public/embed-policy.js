(function (root) {
  'use strict';
  // Exact provider origins only: no suffix matching, wildcard subdomains or
  // arbitrary ports. CSP enforces the same boundary on frame redirects.
  const origins = Object.freeze(['https://rutube.ru', 'https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://vk.com', 'https://vkvideo.ru', 'https://www.dailymotion.com', 'https://geo.dailymotion.com']);
  function inspect(input, appOrigin) {
    try {
      const url = new URL(input), host = url.hostname.toLowerCase();
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === appOrigin || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || /^[\d.]+$/.test(host) || host.includes(':')) return { allowed: false, reason: 'Небезопасный адрес iframe' };
      if (url.protocol === 'http:' && origins.includes(`https://${url.host}`)) url.protocol = 'https:';
      if (!origins.includes(url.origin)) return { allowed: false, url: url.href, reason: 'Провайдер вне списка безопасных встраиваний' };
      return { allowed: true, url: url.href };
    } catch { return { allowed: false, reason: 'Некорректный адрес iframe' }; }
  }
  const policy = Object.freeze({ origins, inspect });
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.ArmEmbedPolicy = policy;
})(globalThis);
