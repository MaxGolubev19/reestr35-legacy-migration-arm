(function (root) {
  'use strict';
  // Exact provider origins only: no suffix matching, wildcard subdomains or
  // arbitrary ports. CSP enforces the same boundary on frame redirects.
  const origins = Object.freeze(['https://rutube.ru', 'https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://vk.com', 'https://vkvideo.ru', 'https://www.dailymotion.com', 'https://geo.dailymotion.com']);
  function inspectSource(input, appOrigin) {
    try {
      if (typeof input !== 'string' || !input || input.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(input)) throw new Error('URL');
      const url = new URL(input), host = url.hostname.toLowerCase().replace(/\.$/, '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin === appOrigin || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || /^[\d.]+$/.test(host) || host.includes(':')) return { allowed: false, reason: 'Небезопасный адрес iframe' };
      return { allowed: true, url: url.href };
    } catch { return { allowed: false, reason: 'Некорректный адрес iframe' }; }
  }
  function inspect(input, appOrigin) {
    const source = inspectSource(input, appOrigin);
    if (!source.allowed) return source;
    const url = new URL(source.url);
    if (url.protocol === 'http:' && origins.includes(`https://${url.host}`)) url.protocol = 'https:';
    if (!origins.includes(url.origin)) return { allowed: false, url: url.href, reason: 'Провайдер вне списка безопасных встраиваний' };
    return { allowed: true, url: url.href };
  }
  function createFrame(item, { preview = false } = {}) {
    const frame = root.document.createElement('iframe');
    const policy = inspect(item?.resolvedUrl, root.location.origin);
    if (item?.reason || !policy.allowed || !('credentialless' in frame)) {
      const fallback = root.document.createElement('span');
      fallback.className = 'media-frame-unavailable'; fallback.setAttribute('role', 'status');
      fallback.textContent = item?.reason || (policy.allowed ? 'Браузер не поддерживает изолированное встраивание' : policy.reason);
      return fallback;
    }
    frame.title = `${preview ? 'Превью' : 'Встраивание'} ${item.originalUrl || item.resolvedUrl}`;
    frame.credentialless = true;
    frame.setAttribute('sandbox', 'allow-scripts allow-presentation allow-same-origin');
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.className = preview ? 'media-frame-preview' : 'media-full-frame';
    if (preview) { frame.loading = 'lazy'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true'); }
    else frame.allowFullscreen = true;
    frame.src = policy.url;
    return frame;
  }
  const policy = Object.freeze({ origins, inspectSource, inspect, createFrame });
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.ArmEmbedPolicy = policy;
})(globalThis);
