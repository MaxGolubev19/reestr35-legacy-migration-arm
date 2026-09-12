'use strict';
const { parse } = require('parse5');
const cssValue = require('postcss-value-parser');
const ASSET = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|tiff?|pdf|docx?|xlsx?|pptx?|odt|ods|rtf|txt|csv|zip|rar|7z|gz|tar|mp4|webm|mov|mp3|wav|ogg|m4a)(?:$|[?#])/i;
const FLASH = /\.(?:swf|flv)(?:$|[?#])/i;
function inventory(html, baseUrl, maxResources = 3000) {
  const document = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false }), entries = [];
  function add(node, attribute, originalUrl, kind = 'asset') {
    if (entries.length >= maxResources) throw new Error(`Лимит ресурсов: ${maxResources}`);
    const item = { id: entries.length + 1, kind, originalUrl, occurrence: { tag: node.tagName, attribute, line: node.sourceCodeLocation?.startLine || null, column: node.sourceCodeLocation?.startCol || null }, status: kind === 'asset' ? 'pending' : kind };
    try {
      const url = new URL(originalUrl, baseUrl); url.hash = '';
      item.resolvedUrl = url.href;
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { item.status = 'unsupported'; item.error = 'Разрешены только HTTP(S) без credentials'; }
      if (FLASH.test(url.pathname)) { item.status = 'unsupported'; item.error = 'Flash не поддерживается'; }
    } catch { item.status = 'unsupported'; item.error = 'Некорректный URL'; }
    entries.push(item); return item;
  }
  function css(node, attribute, value) {
    cssValue(value).walk(token => { if (token.type === 'function' && token.value.toLowerCase() === 'url') {
      const raw = cssValue.stringify(token.nodes).trim().replace(/^(['"])(.*)\1$/s, '$2');
      // CSS escaped identifiers/URLs cannot be guessed safely.
      add(node, attribute, raw, raw.includes('\\') ? 'unsupported' : 'asset'); return false;
    } });
  }
  function visit(node) {
    const attrs = Object.fromEntries((node.attrs || []).map(a => [a.name, a.value])), tag = node.tagName;
    if (tag === 'script') add(node, 'src', attrs.src || '[inline script]', 'unsupported');
    for (const [name, value] of Object.entries(attrs)) if (/^on/i.test(name) || name.startsWith('data-src') || name === 'data-lazy') add(node, name, value, 'unsupported');
    if (tag === 'img' && attrs.src) add(node, 'src', attrs.src);
    if (['img', 'source'].includes(tag) && attrs.srcset) {
      // HTML srcset tokenization preserves commas within data URLs.
      let rest = attrs.srcset;
      while ((rest = rest.replace(/^[\s,]+/, ''))) {
        const token = rest.match(/^\S+/)[0]; rest = rest.slice(token.length);
        add(node, 'srcset', token.replace(/,+$/, ''));
        if (!token.endsWith(',')) { const separator = rest.indexOf(','); rest = separator < 0 ? '' : rest.slice(separator + 1); }
      }
    }
    if (tag === 'a' && attrs.href && (ASSET.test(attrs.href) || ASSET.test(attrs.download || ''))) {
      const item = add(node, 'href', attrs.href);
      if (Object.hasOwn(attrs, 'download')) item.occurrence.downloadFilename = attrs.download;
    }
    if (['video', 'audio', 'source'].includes(tag) && attrs.src) add(node, 'src', attrs.src);
    if (attrs.poster) add(node, 'poster', attrs.poster);
    if (tag === 'iframe' && attrs.src) add(node, 'src', attrs.src, 'external');
    if (tag === 'iframe' && attrs.srcdoc) add(node, 'srcdoc', '[inline iframe]', 'unsupported');
    if (['embed', 'object'].includes(tag)) {
      const value = attrs.src || attrs.data;
      if (value) add(node, attrs.src ? 'src' : 'data', value, FLASH.test(value) || /shockwave|flash/i.test(attrs.type || '') ? 'unsupported' : ASSET.test(value) ? 'asset' : 'external');
      else add(node, 'object', attrs.classid || '[object without static URL]', 'unsupported');
    }
    if (tag === 'param' && /^(?:movie|src)$/i.test(attrs.name || '') && attrs.value) add(node, 'value', attrs.value, 'unsupported');
    if (attrs.style) css(node, 'style', attrs.style);
    if (tag === 'style') css(node, 'style-block', (node.childNodes || []).map(child => child.value || '').join(''));
    if (tag === 'base' && attrs.href) add(node, 'href', attrs.href, 'unsupported');
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(document);
  return entries;
}
module.exports = { inventory };
