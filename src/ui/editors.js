import { EditorView, drawSelection, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { html } from '@codemirror/lang-html';
import { bracketMatching, defaultHighlightStyle, foldGutter, syntaxHighlighting } from '@codemirror/language';
import { format } from 'prettier/standalone';
import htmlPlugin from 'prettier/plugins/html';
import { createJSONEditor, Mode } from 'vanilla-jsoneditor';

const viewers = new Map();
export function destroy(id) {
  const viewer = viewers.get(id); viewers.delete(id);
  if (viewer) { viewer.cancelled = true; Promise.resolve(viewer.destroy?.()).catch(() => {}); }
}
export function text(id) { return viewers.get(id)?.text || ''; }
export async function showHtml(id, source) {
  destroy(id);
  const target = document.getElementById(id), viewer = { text: source }; viewers.set(id, viewer);
  let warning = '';
  try { viewer.text = await format(source, { parser: 'html', plugins: [htmlPlugin], embeddedLanguageFormatting: 'off', printWidth: 90 }); }
  catch { warning = 'Prettier не смог форматировать HTML. Показан исходный текст; файл не изменён.'; }
  if (viewer.cancelled) return false;
  target.replaceChildren();
  if (warning) { const note = document.createElement('div'); note.className = 'alert alert-warning'; note.setAttribute('role', 'status'); note.textContent = warning; target.append(note); }
  const host = document.createElement('div'); host.className = 'editor-host'; target.append(host);
  const view = new EditorView({ parent: host, doc: viewer.text, extensions: [lineNumbers(), foldGutter(), highlightSpecialChars(), drawSelection(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), bracketMatching(), html(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': 'HTML только для чтения' }), EditorView.lineWrapping,
    EditorView.theme({ '&': { color: '#182433', backgroundColor: '#fff', fontSize: '13px' }, '.cm-gutters': { backgroundColor: '#f6f8fb', color: '#626976', borderColor: '#e6e7e9' }, '.cm-content': { fontFamily: 'Consolas, monospace' } })] });
  viewer.destroy = () => { view.destroy(); target.replaceChildren(); delete target.dataset.viewer; }; target.dataset.viewer = 'codemirror6';
  return true;
}
export function showJson(id, json) {
  destroy(id); const target = document.getElementById(id); target.replaceChildren();
  const viewer = { text: JSON.stringify(json, null, 2) }; viewers.set(id, viewer);
  const blockSearchShortcuts = event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ['f', 'h'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  target.addEventListener('keydown', blockSearchShortcuts, true);
  const editor = createJSONEditor({ target, props: { content: { json }, mode: Mode.tree, readOnly: true, indentation: 2, askToFormat: false, mainMenuBar: false, navigationBar: false, statusBar: false, ariaLabel: 'JSON только для чтения' } });
  viewer.destroy = () => { target.removeEventListener('keydown', blockSearchShortcuts, true); editor.destroy(); delete target.dataset.viewer; }; target.dataset.viewer = 'vanilla-jsoneditor';
}
