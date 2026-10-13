'use strict';

// The public Bitrix components decode property text twice after GetProperties
// has HTML-escaped it once. Escape source text twice so the final browser
// receives entities, while the small set of generated Markdown tags survives.
const escapeText = value => String(value).replace(/&/g, '&amp;amp;').replace(/</g, '&amp;lt;')
  .replace(/>/g, '&amp;gt;').replace(/"/g, '&amp;quot;').replace(/'/g, '&amp;#39;');
function destination(value) {
  if (/[\u0000-\u0020\u007f\\"'<>]/.test(value)) return null;
  if (/^\/(?!\/)/.test(value) || /^#[^\s]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function inline(source, depth = 0) {
  if (depth > 12) return escapeText(source);
  const tokens = /\\([\\`*_{}\[\]()#+.!>~-])|`([^`\n]+)`|(!?)\[([^\]\n]*)\]\(([^\s)]*)(?:\s+"[^"]*")?\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let html = '', start = 0;
  for (const match of source.matchAll(tokens)) {
    html += escapeText(source.slice(start, match.index)); start = match.index + match[0].length;
    if (match[1]) { html += escapeText(match[1]); continue; }
    if (match[2]) { html += `<code>${escapeText(match[2])}</code>`; continue; }
    if (match[4] !== undefined) {
      const href = !match[3] && destination(match[5]);
      const label = inline(match[4] || (match[3] ? 'Изображение' : match[5]), depth + 1);
      html += href ? `<a href="${escapeText(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<span>${label}</span>`;
      continue;
    }
    const content = inline(match[6] || match[7] || match[8] || match[9] || match[10], depth + 1);
    const tag = match[6] || match[7] ? 'strong' : match[8] ? 'del' : 'em';
    html += `<${tag}>${content}</${tag}>`;
  }
  return html + escapeText(source.slice(start));
}
function render(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '', list = null;
  const closeList = () => { if (list) { html += `</${list}>\n`; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      closeList(); const code = [], close = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++i < lines.length && !close.test(lines[i])) code.push(lines[i]);
      html += `<pre><code>${escapeText(code.join('\n'))}</code></pre>\n`; continue;
    }
    if (!line.trim()) { closeList(); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    const bullet = line.match(/^\s*(?:([-+*])|\d+[.)])\s+(.+)$/);
    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (bullet) {
      const tag = bullet[1] ? 'ul' : 'ol';
      if (list !== tag) { closeList(); html += `<${tag}>\n`; list = tag; }
      html += `<li>${inline(bullet[2])}</li>\n`; continue;
    }
    closeList();
    if (/^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/.test(line)) { html += '<hr>\n'; continue; }
    const tag = heading ? `h${heading[1].length}` : quote ? 'blockquote' : 'p';
    html += `<${tag}>${inline(heading ? heading[2] : quote ? quote[1] : line)}</${tag}>\n`;
  }
  closeList(); return html.trimEnd();
}
module.exports = { render };
