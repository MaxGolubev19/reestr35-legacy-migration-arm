(() => {
  'use strict';
  const states = new Map();
  function icon(action) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    for (const [key, value] of Object.entries({ class: 'icon', width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    const path = document.createElementNS(ns, 'path'); path.setAttribute('d', action === 'copy' ? 'M9 9h11v11H9zM5 15H4V4h11v1' : action === 'external' ? 'M14 3h7v7m0-7L10 14M10 3H4v17h17v-6' : action === 'delete' ? 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6' : 'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4'); svg.append(path); return svg;
  }
  function setExternal(state, value) {
    if (!state.external) return;
    const url = value && window.ArmEmbedPolicy?.inspect(value, location.origin).url;
    state.external.classList.toggle('d-none', !url);
    if (url) state.external.href = url;
    else { state.external.removeAttribute('href'); window.tabler.Tooltip.getInstance(state.external)?.hide(); }
  }
  function targetUrl(value) {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || !/^\/api\/(?:files|html-media)\//.test(url.pathname)) throw new Error('Файл недоступен');
    return url.href;
  }
  async function fileBlob(url) { const response = await fetch(targetUrl(url), { cache: 'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.blob(); }
  async function pngBlob(url) {
    const blob = await fileBlob(url); if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob);
    try { const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); return await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Не удалось скопировать изображение')), 'image/png')); }
    finally { bitmap.close(); }
  }
  for (const id of ['png-modal','json-modal','media-modal']) {
    const modal = document.getElementById(id), header = modal.querySelector('.modal-header'), close = header.querySelector('.btn-close'), actions = document.createElement('div'), feedback = document.createElement('div');
    const live = document.createElement('span'); live.className = 'visually-hidden'; live.setAttribute('role', 'status'); live.id = id.replace('-modal', '-action-status'); modal.append(live);
    const state = { generation: 0, payload: null, feedback, live, buttons: [] }; states.set(id, state);
    actions.className = 'modal-actions'; feedback.className = 'modal-action-feedback alert alert-danger d-none'; feedback.setAttribute('role', 'alert'); feedback.id = id.replace('-modal', '-action-error');
    header.insertBefore(actions, close); header.after(feedback);
    for (const action of ['copy','download']) {
      const button = document.createElement('button'), label = action === 'copy' ? 'Копировать' : 'Скачать'; button.type = 'button'; button.dataset.modalAction = action; button.id = id.replace('-modal', '-' + action); button.className = 'btn btn-outline-secondary btn-icon btn-sm'; button.title = label; button.setAttribute('aria-label', label); button.disabled = true; button.append(icon(action)); actions.append(button); state.buttons.push(button);
      new window.tabler.Tooltip(button, { title: label, trigger: 'hover focus', html: false });
      button.addEventListener('click', async () => {
        const payload = state.payload, generation = state.generation; if (!payload || state.busy || payload[action] === false) return;
        state.busy = true; live.textContent = '';
        state.buttons.forEach(value => { value.setAttribute('aria-disabled', 'true'); value.dataset.state = ''; }); feedback.classList.add('d-none'); button.setAttribute('aria-busy', 'true');
        try {
          if (action === 'copy') {
            if (payload.image) { if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('Копирование изображения не поддерживается браузером'); await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(payload.url) })]); }
            else { if (!navigator.clipboard?.writeText) throw new Error('Буфер обмена недоступен'); await navigator.clipboard.writeText(payload.text()); }
          } else {
            const blob = await fileBlob(payload.url), href = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = href; anchor.download = payload.name || 'download'; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(href), 30000);
          }
          if (generation === state.generation) live.textContent = action === 'copy' ? 'Скопировано' : 'Скачано';
        } catch (error) { if (generation === state.generation) { button.dataset.state = 'error'; feedback.textContent = `${label}: ${error.message}`; feedback.classList.remove('d-none'); } }
        finally { button.removeAttribute('aria-busy'); if (generation === state.generation) { state.busy = false; state.buttons.forEach(value => { value.disabled = !state.payload || state.payload[value.dataset.modalAction] === false; value.setAttribute('aria-disabled', String(value.disabled)); }); } }
      });
    }
    if (id === 'media-modal') {
      const external = document.createElement('a'), label = 'Открыть у источника';
      external.id = 'media-external'; external.className = 'btn btn-outline-secondary btn-icon btn-sm d-none'; external.target = '_blank'; external.rel = 'noopener noreferrer'; external.title = label; external.setAttribute('aria-label', label); external.append(icon('external'));
      actions.insertBefore(external, state.buttons[1]); state.external = external;
      new window.tabler.Tooltip(external, { title: label, trigger: 'hover focus', html: false });
      const remove = document.createElement('button'); remove.type = 'button'; remove.id = 'media-delete'; remove.className = 'btn btn-outline-secondary btn-icon btn-sm modal-delete d-none';
      remove.title = 'Удалить'; remove.setAttribute('aria-label', 'Удалить ресурс'); remove.append(icon('delete')); actions.append(remove); state.deleteButton = remove;
      new window.tabler.Tooltip(remove, { title: 'Удалить', trigger: 'hover focus', html: false });
      remove.addEventListener('click', () => { if (typeof state.payload?.delete === 'function') state.payload.delete(remove); });
    }
    modal.addEventListener('hidden.bs.modal', () => { state.generation++; state.payload = null; setExternal(state, null); state.buttons.forEach(button => { button.disabled = true; window.tabler.Tooltip.getInstance(button)?.hide(); }); if (state.deleteButton) { state.deleteButton.classList.add('d-none'); window.tabler.Tooltip.getInstance(state.deleteButton)?.hide(); } });
  }
  window.ModalActions = { set(id, payload) {
    const state = states.get(id); state.generation++; state.busy = false; state.payload = payload; state.feedback.classList.add('d-none'); state.feedback.textContent = ''; state.live.textContent = '';
    setExternal(state, payload?.externalUrl);
    if (state.deleteButton) { state.deleteButton.classList.toggle('d-none', typeof payload?.delete !== 'function'); state.deleteButton.disabled = typeof payload?.delete !== 'function'; if (state.deleteButton.disabled) window.tabler.Tooltip.getInstance(state.deleteButton)?.hide(); }
    state.buttons.forEach(button => { const hidden = button.dataset.modalAction === 'download' && payload?.download === false; button.classList.toggle('d-none', hidden); if (hidden) window.tabler.Tooltip.getInstance(button)?.hide(); button.disabled = !payload || payload[button.dataset.modalAction] === false; button.setAttribute('aria-disabled', String(button.disabled)); button.dataset.state = ''; button.dataset.sourceUrl = payload?.url || ''; button.removeAttribute('aria-busy'); });
  }, clearExternal(id) { setExternal(states.get(id), null); } };
})();
