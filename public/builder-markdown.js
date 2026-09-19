(() => {
  'use strict';
  // A deliberately small, offline Markdown renderer. Every source string is
  // inserted as a text node; images are labels, never network resources.
  const element = (tag, text) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; };
  function destination(value) {
    if (/[\u0000-\u0020\u007f\\]/.test(value)) return null;
    if (/^\/(?!\/)/.test(value) || /^#[^\s]*$/.test(value)) return value;
    try { const url = new URL(value); return ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  function inline(source, target, depth = 0) {
    if (depth > 12) { target.append(document.createTextNode(source)); return; }
    const tokens = /\\([\\`*_{}\[\]()#+.!>~-])|`([^`\n]+)`|(!?)\[([^\]\n]*)\]\(([^\s)]*)(?:\s+"[^"]*")?\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
    let start = 0;
    for (const match of source.matchAll(tokens)) {
      target.append(document.createTextNode(source.slice(start, match.index))); start = match.index + match[0].length;
      if (match[1]) { target.append(document.createTextNode(match[1])); continue; }
      if (match[2]) { target.append(element('code', match[2])); continue; }
      if (match[4] !== undefined) {
        const href = !match[3] && destination(match[5]), label = element(href ? 'a' : 'span');
        if (href) { label.href = href; label.target = '_blank'; label.rel = 'noopener noreferrer'; }
        inline(match[4] || (match[3] ? 'Изображение' : match[5]), label, depth + 1); target.append(label); continue;
      }
      const text = match[6] || match[7] || match[8] || match[9] || match[10], mark = element(match[6] || match[7] ? 'strong' : match[8] ? 'del' : 'em');
      inline(text, mark, depth + 1); target.append(mark);
    }
    target.append(document.createTextNode(source.slice(start)));
  }
  function render(source) {
    const fragment = document.createDocumentFragment(), lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    let list = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        const code = [], close = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
        while (++i < lines.length && !close.test(lines[i])) code.push(lines[i]);
        const pre = element('pre'); pre.append(element('code', code.join('\n'))); fragment.append(pre, '\n'); list = null; continue;
      }
      if (!line.trim()) { list = null; continue; }
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/), bullet = line.match(/^\s*(?:([-+*])|\d+[.)])\s+(.+)$/), quote = line.match(/^\s{0,3}>\s?(.*)$/);
      if (bullet) {
        const tag = bullet[1] ? 'ul' : 'ol'; if (!list || list.localName !== tag) { list = element(tag); fragment.append(list, '\n'); }
        const item = element('li'); inline(bullet[2], item); list.append(item, '\n'); continue;
      }
      list = null;
      if (/^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/.test(line)) { fragment.append(element('hr'), '\n'); continue; }
      const item = element(heading ? `h${heading[1].length}` : quote ? 'blockquote' : 'p');
      inline(heading ? heading[2] : quote ? quote[1] : line, item); fragment.append(item, '\n');
    }
    return fragment;
  }
  function plainText(source, html = false) {
    // Strip tags before rendering. No HTML parser or resource-bearing DOM nodes
    // are created even for legacy HTML fragments.
    const clean = String(source || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&');
    return (html ? clean : render(clean).textContent).replace(/\s+/g, ' ').trim();
  }
  function editor(control) {
    const wrap = element('div'), toolbar = element('div'), preview = element('div');
    wrap.className = 'builder-markdown'; toolbar.className = 'builder-markdown-tools'; toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', 'Форматирование Markdown');
    control.classList.add('builder-markdown-source'); control.placeholder = 'Текст в Markdown';
    control.maxLength = 12000;
    const update = () => { preview.replaceChildren(render(control.value)); if (!control.value.trim()) preview.append(element('span', 'Предпросмотр появится после ввода текста.')); };
    const format = (before, after, fallback, line = false) => {
      const start = control.selectionStart, end = control.selectionEnd, selected = control.value.slice(start, end) || fallback;
      const prefix = line && start > 0 && control.value[start - 1] !== '\n' ? '\n' + before : before;
      if (control.value.length - (end - start) + prefix.length + selected.length + after.length > control.maxLength) return;
      control.setRangeText(prefix + selected + after, start, end, 'select'); control.focus(); control.setSelectionRange(start + prefix.length, start + prefix.length + selected.length); control.dispatchEvent(new Event('input', { bubbles: true }));
    };
    for (const [name, before, after, fallback, line] of [['Жирный', '**', '**', 'текст'], ['Курсив', '*', '*', 'текст'], ['Заголовок', '## ', '', 'Заголовок', true], ['Маркированный список', '- ', '', 'Пункт', true], ['Нумерованный список', '1. ', '', 'Пункт', true], ['Ссылка', '[', '](https://example.org)', 'Текст ссылки']]) {
      const button = element('button', name); button.type = 'button'; button.className = 'btn btn-sm btn-outline-secondary'; button.addEventListener('click', () => format(before, after, fallback, line)); toolbar.append(button);
    }
    control.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && ['b', 'i'].includes(event.key.toLowerCase())) { event.preventDefault(); const mark = event.key.toLowerCase() === 'b' ? '**' : '*'; format(mark, mark, 'текст'); } });
    control.addEventListener('input', update); preview.id = 'builder-markdown-preview'; preview.className = 'builder-markdown-preview'; preview.setAttribute('role', 'region'); preview.setAttribute('aria-label', 'Предпросмотр Markdown');
    wrap.append(toolbar, control, preview); update(); return wrap;
  }
  window.BuilderMarkdown = { render, plainText, editor };
})();
