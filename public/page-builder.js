(() => {
  'use strict';
  const STATUS = {
    unreviewed: { label: 'Не проверено', className: 'review-unreviewed' },
    passed: { label: 'Пройдено', className: 'review-passed' },
    failed: { label: 'Не пройдено', className: 'review-failed' },
    system_error: { label: 'Системная ошибка', className: 'review-system-error' }
  };
  const TYPE = {};
  const VIEW = {
    'big-media': { default: 'Обычное изображение', hero: 'Крупный баннер', compact: 'Компактное изображение' },
    table: { default: 'Таблица с ячейками' },
    service: { default: 'Карточка услуги', 'media-left': 'Изображение слева', 'media-right': 'Изображение справа', plain: 'Без фона' },
    content: { default: 'Обычный текст', narrow: 'Узкая колонка', note: 'Выделенная заметка' },
    grid: { default: 'Сетка карточек', gallery: 'Галерея изображений', catalog: 'Каталог товаров', compact: 'Компактные карточки', promo: 'Карточки акций', news: 'Карточки новостей', services: 'Карточки услуг', list: 'Карточки списком' },
    'data-table': { default: 'Обычная таблица', compact: 'Компактная таблица' },
    links: { links: 'Список ссылок', documents: 'Список документов' },
    sections: { list: 'Разделы списком', columns: 'Разделы в колонках', contacts: 'Контактные данные' },
    embed: { default: 'Обычная вставка', wide: 'Широкая вставка', map: 'Карта' },
    'rich-content': { default: 'Обычная ширина', wide: 'Широкий фрагмент', compact: 'Компактный фрагмент' }
  };
  const STRUCTURED_TYPES = new Set(['table', 'grid', 'data-table', 'links', 'sections']);
  const PROVIDER = { iframe: 'Виджет (iframe)', map: 'Карта', video: 'Видео', unknown: 'Другой источник' };
  const state = { jobId: null, attempt: null, revision: 0, document: null, activeTab: null, request: 0, api: null, refresh: null,
    target: null, trigger: null, draft: null, saving: null, pendingJob: null, pendingSaved: null, mutation: null, drag: null, mutationError: '' };
  const root = document.getElementById('page-builder-content'), loading = document.getElementById('page-builder-loading'), errorBox = document.getElementById('page-builder-error');
  const modalElement = document.getElementById('page-builder-modal'), form = document.getElementById('page-builder-form'), fields = document.getElementById('page-builder-fields');
  const formError = document.getElementById('page-builder-form-error'), save = document.getElementById('page-builder-save');
  const reviewFooter = document.createElement('div'); reviewFooter.className = 'builder-review-footer'; reviewFooter.hidden = true; modalElement.querySelector('.modal-footer').prepend(reviewFooter);
  const progressCount = document.getElementById('builder-progress-count'), progressBar = document.getElementById('builder-progress-bar');
  const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const clear = item => item.replaceChildren();
  const live = node('div', 'visually-hidden'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); root.after(live);
  const sections = (doc = state.document) => [doc.common, ...doc.tabs];
  const busy = () => Boolean(state.draft || state.saving || state.mutation);
  const samePage = job => state.jobId === job.id && state.attempt === job.builderAttempt;
  const pageUrl = (jobId, attempt) => `/api/page-builder/${encodeURIComponent(jobId)}?attempt=${attempt}`;
  function focusBlock(id, sectionId) {
    const section = sections().find(item => item.blocks.some(block => block.id === id)) || sections().find(item => item.id === sectionId) || state.document.common;
    if (section.id !== state.document.common.id && state.activeTab !== section.id) { state.activeTab = section.id; render(); }
    const opener = root.querySelector(`[data-builder-id="${CSS.escape(id || '')}"]`);
    (opener || root.querySelector(`[data-add-section="${CSS.escape(section.id)}"]`))?.focus({ preventScroll: true });
  }
  function focusTab(id) {
    const tab = state.document.tabs.find(item => item.id === id) || state.document.tabs[0];
    if (tab && state.activeTab !== tab.id) { state.activeTab = tab.id; render(); }
    (tab ? root.querySelector(`[data-tab-id="${CSS.escape(tab.id)}"]`) : root.querySelector('[data-tab-add]'))?.focus({ preventScroll: true });
  }
  function renderMutationError() {
    errorBox.textContent = state.mutationError; errorBox.classList.toggle('d-none', !state.mutationError);
  }
  function action(label, handler, className = '') {
    const button = node('button', `btn btn-sm ${className}`, label); button.type = 'button'; button.addEventListener('click', handler); return button;
  }
  function trashIcon() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) icon.setAttribute(name, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6'); icon.append(path); return icon;
  }
  function lineIcon(paths, className = '') {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: className })) if (value) icon.setAttribute(name, value);
    for (const d of paths) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); icon.append(path); }
    return icon;
  }
  function blockTypeIcon(type) {
    const paths = {
      'big-media': ['M4 5h16v14H4z', 'm4 15 3.5-4 3 3 2.5-3 4 5', 'M15.5 8.5h.01'],
      table: ['M4 5h16v14H4z', 'M4 10h16M4 15h16M10 5v14'],
      service: ['M5 8h14v11H5z', 'M9 8V5h6v3', 'M9 13h6'],
      content: ['M6 6h12M6 10h12M6 14h9M6 18h7'],
      grid: ['M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z'],
      'data-table': ['M4 5h16v14H4z', 'M4 10h16M9 10v9M15 10v9'],
      links: ['M10 13a5 5 0 0 0 7.5.5l1-1a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7.5-.5l-1 1a5 5 0 0 0 7 7l1-1'],
      sections: ['M5 6h3v3H5zM11 7.5h8M5 11h3v3H5zM11 12.5h8M5 16h3v3H5zM11 17.5h8'],
      embed: ['M4 5h16v14H4z', 'm10 9 4 3-4 3z'],
      'rich-content': ['M5 6h14M5 10h14M5 14h8', 'M16 14v5M13.5 16.5h5']
    };
    const holder = node('span', `builder-type-icon builder-type-${type}`); holder.title = TYPE[type] || type; holder.setAttribute('aria-hidden', 'true'); holder.append(lineIcon(paths[type] || paths.content)); return holder;
  }
  function dragIcon() {
    return lineIcon(['M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01'], 'builder-drag-icon');
  }
  async function mutate(next, { id, sectionId, message, focusTabId = null }) {
    if (busy()) return;
    const operation = { jobId: state.jobId, attempt: state.attempt, revision: state.revision, originSectionId: sections().find(section => section.blocks.some(block => block.id === id))?.id || sectionId }; state.mutation = operation; ++state.request;
    state.mutationError = ''; root.inert = true; root.setAttribute('aria-busy', 'true'); renderMutationError(); live.textContent = 'Сохранение…';
    try {
      const stored = await state.api(pageUrl(operation.jobId, operation.attempt), { method: 'POST', body: JSON.stringify({ revision: operation.revision, document: next }) });
      state.revision = stored.revision; state.document = stored.document;
      if (sectionId !== stored.document.common.id) state.activeTab = sectionId;
      render(); live.textContent = message;
    } catch (error) {
      state.mutationError = `Не удалось сохранить: ${error.message}`; renderMutationError(); live.textContent = state.mutationError;
      // Keep polling and new edits fenced until the rejected mutation has been
      // reconciled. The visible error belongs to this job, not to one DOM render.
      try {
        const stored = await state.api(pageUrl(operation.jobId, operation.attempt));
        state.revision = stored.revision; state.document = stored.document; render();
      } catch (syncError) {
        state.mutationError += ` Не удалось обновить данные: ${syncError.message}`; renderMutationError(); live.textContent = state.mutationError;
      }
    } finally {
      state.mutation = null; root.inert = false; root.removeAttribute('aria-busy');
      if (focusTabId) focusTab(focusTabId); else focusBlock(id, state.mutationError ? operation.originSectionId : sectionId);
      const pending = state.pendingJob; state.pendingJob = null;
      if (pending && !samePage(pending)) await fetchAndRender(pending, Number(pending.pageBuilder?.revision || 0));
      await state.refresh?.();
    }
  }
  function moveBlock(id, sectionId, beforeId = null) {
    if (busy()) return;
    const next = structuredClone(state.document), from = sections(next).find(section => section.blocks.some(block => block.id === id)), to = sections(next).find(section => section.id === sectionId);
    if (!from || !to || beforeId === id) return;
    if (from !== to && to.blocks.length >= 40) { live.textContent = 'В разделе уже 40 блоков.'; return; }
    const block = from.blocks.splice(from.blocks.findIndex(block => block.id === id), 1)[0];
    const index = beforeId ? to.blocks.findIndex(block => block.id === beforeId) : to.blocks.length;
    if (index < 0) return;
    to.blocks.splice(index, 0, block);
    if (JSON.stringify(next) === JSON.stringify(state.document)) return;
    void mutate(next, { id, sectionId, message: `Блок «${block.title}» перемещён: ${to.title}, позиция ${index + 1}.` });
  }
  function moveTab(id, targetId, after = false) {
    if (busy() || id === targetId) return;
    const next = structuredClone(state.document), from = next.tabs.findIndex(tab => tab.id === id);
    if (from < 0) return;
    const [tab] = next.tabs.splice(from, 1), target = next.tabs.findIndex(item => item.id === targetId);
    if (target < 0) return;
    next.tabs.splice(target + Number(after), 0, tab);
    if (JSON.stringify(next) !== JSON.stringify(state.document)) void mutate(next, { id, sectionId: id, focusTabId: id, message: `Вкладка «${tab.title}» перемещена.` });
  }
  function clearDrag() {
    state.drag = null; root.classList.remove('builder-dragging');
    root.querySelectorAll('.builder-drop-before, .builder-drop-after, .builder-drop-active, .builder-drag-source, .builder-tab-drop-before, .builder-tab-drop-after').forEach(item => item.classList.remove('builder-drop-before', 'builder-drop-after', 'builder-drop-active', 'builder-drag-source', 'builder-tab-drop-before', 'builder-tab-drop-after'));
  }
  function dropTarget(element, sectionId, blockId = null) {
    const position = event => blockId && event.clientY < element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2 ? 'before' : 'after';
    element.addEventListener('dragover', event => {
      if (state.drag?.kind !== 'block' || busy()) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
      root.querySelectorAll('.builder-drop-before, .builder-drop-after, .builder-drop-active').forEach(item => item.classList.remove('builder-drop-before', 'builder-drop-after', 'builder-drop-active'));
      element.classList.add(blockId ? `builder-drop-${position(event)}` : 'builder-drop-active');
    });
    element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('builder-drop-before', 'builder-drop-after', 'builder-drop-active'); });
    element.addEventListener('drop', event => {
      if (state.drag?.kind !== 'block' || busy()) return;
      event.preventDefault(); event.stopPropagation();
      const id = state.drag.id, section = sections().find(item => item.id === sectionId);
      const beforeId = blockId && position(event) === 'before' ? blockId : blockId ? section.blocks[section.blocks.findIndex(block => block.id === blockId) + 1]?.id || null : null;
      clearDrag(); moveBlock(id, sectionId, beforeId);
    });
  }
  function sectionControls(section, container) {
    const add = action('', () => createBlock(section.id, add), 'builder-add builder-section-drop'); add.dataset.addSection = section.id; add.disabled = section.blocks.length >= 40;
    add.setAttribute('aria-label', `Добавить блок: ${section.title}`);
    add.title = `Добавить блок: ${section.title}`;
    const plus = node('span', 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true');
    add.append(plus);
    add.dataset.dropSection = section.id; dropTarget(add, section.id); container.append(add);
  }
  function mediaUrl(asset, kind = asset.originalUrl ? 'original' : 'big') { return `/api/page-builder/${encodeURIComponent(state.jobId)}/media/${encodeURIComponent(asset.id)}?kind=${kind}&revision=${state.revision}&attempt=${state.attempt}`; }
  function mediaFilename(asset, kind) {
    if (asset[`${kind}Media`]) return asset[`${kind}Media`].filename;
    let name;
    try { name = new URL(asset[`${kind}Url`]).pathname.split('/').at(-1); } catch { return ''; }
    try { name = decodeURIComponent(name); } catch {}
    return name.replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  }
  function summary() {
    const reviews = [state.document.common, ...state.document.tabs].flatMap(section => section.blocks.map(block => block.review));
    const failed = reviews.filter(item => item.status === 'failed').length, passed = reviews.filter(item => item.status === 'passed').length, unreviewed = reviews.length - failed - passed;
    return { status: failed ? 'failed' : unreviewed || !reviews.length ? 'unreviewed' : 'passed', passed, failed, unreviewed, reviewed: passed + failed, total: reviews.length, reviews };
  }
  function sectionReview(section) {
    const failed = section.blocks.find(block => block.review.status === 'failed');
    return failed ? { status: 'failed', reason: failed.review.reason } : { status: section.blocks.length && section.blocks.every(block => block.review.status === 'passed') ? 'passed' : 'unreviewed', reason: '' };
  }
  function renderProgress(totals = { reviewed: 0, total: 0, passed: 0, failed: 0, unreviewed: 0, reviews: [] }) {
    progressCount.textContent = `${totals.reviewed}/${totals.total}`; clear(progressBar);
    const classes = { passed: 'bg-green', failed: 'bg-yellow', unreviewed: 'bg-secondary' }, labels = { passed: 'Пройдено', failed: 'Не пройдено', unreviewed: 'Не проверено' };
    totals.reviews.forEach(review => { const segment = node('span', `progress-bar qa-progress-segment ${classes[review.status] || classes.unreviewed}`); segment.title = labels[review.status] || labels.unreviewed; segment.setAttribute('aria-hidden', 'true'); progressBar.append(segment); });
    const percent = totals.total ? Math.round((totals.reviewed / totals.total) * 100) : 0;
    progressBar.setAttribute('aria-valuenow', String(percent));
    progressBar.setAttribute('aria-label', `Проверено ${totals.reviewed} из ${totals.total} блоков: пройдено ${totals.passed}, не пройдено ${totals.failed}, не проверено ${totals.unreviewed}`);
  }
  function blockCard(block, sectionId) {
    const title = block.title.trim() || 'Без заголовка';
    const column = node('div', 'col-12'), card = node('div', `card builder-block ${STATUS[block.review.status].className}`), button = node('button', 'builder-block-open'); button.type = 'button';
    button.setAttribute('aria-label', `${title}. ${TYPE[block.type]}. ${STATUS[block.review.status].label}. Открыть настройки`);
    Object.assign(button.dataset, { builderKind: 'block', builderSectionId: sectionId, builderId: block.id });
    const body = node('span', 'card-body builder-block-body text-start'), copy = node('span', 'builder-block-copy');
    copy.append(node('strong', 'builder-block-title', title));
    const preview = window.BuilderMarkdown.plainText(block.text, block.type === 'rich-content');
    if (preview) copy.append(node('span', 'text-secondary builder-text-preview', preview.length > 300 ? `${preview.slice(0, 300)}…` : preview));
    if (block.review.reason) copy.append(node('span', 'builder-failure-reason', block.review.reason));
    body.append(blockTypeIcon(block.type), copy);
    const visibleMedia = block.media.filter(asset => asset.originalUrl || asset.bigUrl);
    if (visibleMedia.length) {
      const gallery = node('span', 'builder-media-preview');
      for (const asset of visibleMedia.slice(0, 2)) { const img = node('img'); img.src = mediaUrl(asset); img.alt = asset.alt || ''; img.loading = 'lazy'; gallery.append(img); }
      if (visibleMedia.length > 2) gallery.append(node('span', 'builder-media-more', `+${visibleMedia.length - 2}`)); body.append(gallery);
    }
    button.append(body); button.addEventListener('click', () => open(block, 'block', sectionId, button)); card.append(button); column.append(card);
    column.dataset.blockId = block.id; dropTarget(column, sectionId, block.id);
    const controls = node('div', 'builder-card-tools'); controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', `Действия: ${block.title}`);
    const handle = action('', () => { const expanded = panel.hidden; closeActionPanels(); panel.hidden = !expanded; handle.setAttribute('aria-expanded', String(expanded)); live.textContent = expanded ? 'Выберите «Выше», «Ниже» или раздел для переноса. Escape закрывает действия.' : ''; }, 'builder-drag-handle'); handle.append(dragIcon()); handle.draggable = true;
    handle.setAttribute('aria-label', `Перетащить блок: ${block.title}`); handle.title = 'Перетащить блок; нажмите для выбора порядка и раздела';
    // Protect the source as soon as the pointer is pressed: a pending poll can
    // otherwise replace this node before the browser emits native dragstart.
    // Fence polling before the browser's drag threshold: detaching the pressed
    // node between pointerdown and dragstart silently cancels native dragging.
    handle.addEventListener('pointerdown', event => { if (event.button === 0 && !busy()) { state.drag = { kind: 'block', id: block.id, started: false }; ++state.request; } });
    handle.addEventListener('dragstart', event => { if (busy()) { event.preventDefault(); return; } closeActionPanels(); state.drag = { kind: 'block', id: block.id, started: true }; ++state.request; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', block.id); column.classList.add('builder-drag-source'); root.classList.add('builder-dragging'); live.textContent = `Перемещение: ${block.title}. Отпустите над блоком, вкладкой или зоной раздела.`; });
    handle.addEventListener('dragend', () => { clearDrag(); const pending = state.pendingJob; if (pending && !busy()) { state.pendingJob = null; void fetchAndRender(pending, Number(pending.pageBuilder?.revision || 0)); } });
    const section = sections().find(item => item.id === sectionId), index = section.blocks.findIndex(item => item.id === block.id);
    const up = action('↑ Выше', () => moveBlock(block.id, sectionId, section.blocks[index - 1]?.id)); up.disabled = index === 0; up.setAttribute('aria-label', `Выше: ${block.title}`);
    const down = action('↓ Ниже', () => moveBlock(block.id, sectionId, section.blocks[index + 2]?.id)); down.disabled = index === section.blocks.length - 1; down.setAttribute('aria-label', `Ниже: ${block.title}`);
    const destination = node('select', 'form-select form-select-sm builder-move'); destination.setAttribute('aria-label', `Перенести блок: ${block.title}`);
    destination.append(new Option('Перенести в…', ''));
    sections().filter(item => item.id !== sectionId).forEach(item => { const option = new Option(item.title, item.id); option.disabled = item.blocks.length >= 40; destination.append(option); });
    destination.addEventListener('change', () => { const id = destination.value; destination.value = ''; if (id) moveBlock(block.id, id); });
    const disclosure = node('div', 'builder-actions-disclosure'), panel = node('div', 'builder-action-panel'); panel.id = `builder-actions-${block.id}`; panel.hidden = true; panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', `Порядок и раздел: ${block.title}`);
    handle.setAttribute('aria-expanded', 'false'); handle.setAttribute('aria-controls', panel.id);
    handle.addEventListener('keydown', event => { if (panel.hidden || !['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); if (event.key === 'ArrowUp' && !up.disabled) up.click(); if (event.key === 'ArrowDown' && !down.disabled) down.click(); });
    disclosure.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopPropagation(); panel.hidden = true; handle.setAttribute('aria-expanded', 'false'); handle.focus(); } });
    panel.append(up, down, destination); disclosure.append(handle, panel);
    const remove = action('', () => open(block, 'block', sectionId, remove, 'delete'), 'builder-delete'); remove.setAttribute('aria-label', `Удалить блок: ${block.title}`); remove.title = 'Удалить блок';
    remove.append(trashIcon());
    controls.append(disclosure, remove); card.append(controls); return column;
  }
  function closeActionPanels() {
    root.querySelectorAll('.builder-action-panel:not([hidden])').forEach(panel => { panel.hidden = true; panel.parentElement.querySelector('.builder-drag-handle').setAttribute('aria-expanded', 'false'); });
  }
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.builder-actions-disclosure')) closeActionPanels(); });
  for (const eventName of ['pointerup', 'pointercancel']) document.addEventListener(eventName, () => {
    if (!state.drag || state.drag.started) return; clearDrag();
    window.setTimeout(() => { const pending = state.pendingJob; if (pending && !busy() && !state.drag) { state.pendingJob = null; void fetchAndRender(pending, Number(pending.pageBuilder?.revision || 0)); } }, 0);
  });
  function activateTab(id, focus = false) {
    state.activeTab = id; render();
    if (focus) root.querySelector(`.builder-tab[data-tab-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }
  function closeTabMenu() {
    root.querySelector('.builder-tab-menu-panel')?.remove();
    root.querySelectorAll('.builder-tab-menu-button[aria-expanded="true"]').forEach(button => { button.setAttribute('aria-expanded', 'false'); button.removeAttribute('aria-controls'); });
  }
  function tabMenu(tab, trigger, container, focusAction = 'rename') {
    const expanded = trigger.getAttribute('aria-expanded') === 'true'; closeTabMenu(); if (expanded) return;
    const panel = node('div', 'builder-tab-menu-panel'); panel.id = `builder-tab-menu-${tab.id}`; panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', `Действия вкладки «${tab.title}»`);
    const rename = action('Переименовать', () => { closeTabMenu(); open(tab, 'tab', tab.id, trigger); }, 'builder-tab-menu-action');
    const remove = action('Удалить', () => { closeTabMenu(); open(tab, 'tab', tab.id, trigger, 'delete'); }, 'builder-tab-menu-action text-danger');
    rename.dataset.tabMenuAction = 'rename'; remove.dataset.tabMenuAction = 'remove';
    panel.append(rename, remove); container.append(panel); trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', panel.id);
    const box = trigger.getBoundingClientRect(), parent = container.getBoundingClientRect();
    panel.style.top = `${box.bottom - parent.top + 4}px`;
    panel.style.left = `${Math.max(0, Math.min(box.left - parent.left, parent.width - panel.offsetWidth))}px`;
    if (focusAction === 'remove') remove.focus({ preventScroll: true });
    else if (focusAction === 'rename') rename.focus({ preventScroll: true });
    else if (focusAction === 'trigger') trigger.focus({ preventScroll: true });
  }
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.builder-tab-menu-panel, .builder-tab-menu-button')) closeTabMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && root.querySelector('.builder-tab-menu-panel')) { const trigger = root.querySelector('.builder-tab-menu-button[aria-expanded="true"]'); closeTabMenu(); trigger?.focus({ preventScroll: true }); } });
  function render() {
    const active = document.activeElement, focused = root.contains(active) && (active.dataset.builderId || active.dataset.addSection) ? { id: active.dataset.builderId, sectionId: active.dataset.builderSectionId || active.dataset.addSection } : null;
    const focusedTab = root.contains(active) && !focused && (active.dataset.tabId || active.dataset.tabHandleId || active.dataset.tabMenuId || active.dataset.tabAdd) ? { id: active.dataset.tabId || active.dataset.tabHandleId || active.dataset.tabMenuId, kind: active.dataset.tabHandleId ? 'handle' : active.dataset.tabMenuId ? 'menu' : active.dataset.tabAdd ? 'add' : 'tab' } : null;
    const openMenuTrigger = root.querySelector('.builder-tab-menu-button[aria-expanded="true"]');
    const openMenu = openMenuTrigger && { id: openMenuTrigger.dataset.tabMenuId, focus: active?.dataset.tabMenuAction || (active === openMenuTrigger ? 'trigger' : 'none') };
    const tabScroll = root.querySelector('.builder-tabs')?.scrollLeft || 0;
    clear(root); const doc = state.document, totals = summary(); renderProgress(totals);
    const common = node('section', 'builder-section'); common.setAttribute('aria-label', 'Общая часть');
    const commonGrid = node('div', 'row g-2'); doc.common.blocks.forEach(block => commonGrid.append(blockCard(block, doc.common.id))); common.append(commonGrid); sectionControls(doc.common, common); root.append(common);
    const tabs = node('section', 'builder-section builder-tabs-section'), row = node('div', 'builder-tabs-row');
    const nav = node('div', 'builder-tabs'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', 'Вкладки новой страницы');
    if (!doc.tabs.some(tab => tab.id === state.activeTab)) state.activeTab = doc.tabs[0]?.id || null;
    doc.tabs.forEach((tab, tabIndex) => {
      const selected = state.activeTab === tab.id, derived = sectionReview(tab), item = node('div', 'builder-tab-item'), button = node('button', `builder-tab ${selected ? 'active' : ''}`), dot = node('span', `builder-status-dot ${STATUS[derived.status].className}`);
      item.setAttribute('role', 'presentation'); item.dataset.tabItem = tab.id;
      button.type = 'button'; button.role = 'tab'; button.id = `builder-tab-${tab.id}`; button.tabIndex = selected ? 0 : -1;
      button.setAttribute('aria-selected', String(selected)); button.setAttribute('aria-controls', `builder-panel-${tab.id}`); button.setAttribute('aria-label', `${tab.title}: ${STATUS[derived.status].label}`);
      dot.setAttribute('aria-hidden', 'true'); button.append(dot, node('span', '', tab.title)); button.dataset.tabId = tab.id;
      button.addEventListener('click', () => activateTab(tab.id, true));
      dropTarget(button, tab.id);
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? doc.tabs.length - 1 : (tabIndex + (event.key === 'ArrowRight' ? 1 : -1) + doc.tabs.length) % doc.tabs.length;
        event.preventDefault(); activateTab(doc.tabs[index].id, true);
      });
      const handle = action('', () => { live.textContent = 'Перетащите вкладку или используйте стрелки влево и вправо для изменения порядка.'; }, 'builder-tab-handle'); handle.append(dragIcon()); handle.draggable = true; handle.dataset.tabHandleId = tab.id;
      handle.setAttribute('aria-label', `Перетащить вкладку: ${tab.title}`); handle.title = 'Перетащить вкладку; стрелки меняют порядок';
      handle.addEventListener('pointerdown', event => { if (event.button === 0 && !busy()) { state.drag = { kind: 'tab', id: tab.id, started: false }; ++state.request; } });
      handle.addEventListener('dragstart', event => { if (busy()) { event.preventDefault(); return; } closeTabMenu(); state.drag = { kind: 'tab', id: tab.id, started: true }; ++state.request; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', tab.id); item.classList.add('builder-drag-source'); live.textContent = `Перемещение вкладки «${tab.title}».`; });
      handle.addEventListener('dragend', () => { clearDrag(); const pending = state.pendingJob; if (pending && !busy()) { state.pendingJob = null; void fetchAndRender(pending, Number(pending.pageBuilder?.revision || 0)); } });
      handle.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const target = doc.tabs[tabIndex + (event.key === 'ArrowLeft' ? -1 : 1)]; if (target) moveTab(tab.id, target.id, event.key === 'ArrowRight'); });
      item.addEventListener('dragover', event => { if (state.drag?.kind !== 'tab' || busy()) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; nav.querySelectorAll('.builder-tab-drop-before,.builder-tab-drop-after').forEach(node => node.classList.remove('builder-tab-drop-before', 'builder-tab-drop-after')); item.classList.add(event.clientX < item.getBoundingClientRect().left + item.getBoundingClientRect().width / 2 ? 'builder-tab-drop-before' : 'builder-tab-drop-after'); });
      item.addEventListener('drop', event => { if (state.drag?.kind !== 'tab' || busy()) return; event.preventDefault(); event.stopPropagation(); const id = state.drag.id, after = event.clientX >= item.getBoundingClientRect().left + item.getBoundingClientRect().width / 2; clearDrag(); moveTab(id, tab.id, after); });
      const menu = action('⋯', () => tabMenu(tab, menu, tabs), 'builder-tab-menu-button'); menu.dataset.tabMenuId = tab.id; menu.setAttribute('aria-label', `Действия вкладки: ${tab.title}`); menu.setAttribute('aria-expanded', 'false');
      item.append(handle, button, menu); nav.append(item);
    });
    const addTab = action('', () => createTab(addTab), doc.tabs.length ? 'builder-tab-add' : 'builder-add builder-tab-empty-add');
    const plus = node('span', doc.tabs.length ? '' : 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true'); addTab.append(plus);
    addTab.dataset.tabAdd = 'true'; addTab.setAttribute('aria-label', 'Добавить вкладку'); addTab.title = 'Добавить вкладку'; addTab.disabled = doc.tabs.length >= 12;
    if (doc.tabs.length) { row.append(nav, addTab); tabs.append(row); }
    else tabs.append(addTab);
    doc.tabs.forEach(tab => {
      const selected = state.activeTab === tab.id, panel = node('div', 'builder-tab-panel'); panel.id = `builder-panel-${tab.id}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `builder-tab-${tab.id}`); panel.tabIndex = selected ? 0 : -1; panel.hidden = !selected;
      const grid = node('div', 'row g-2'); tab.blocks.forEach(block => grid.append(blockCard(block, tab.id))); panel.append(grid); sectionControls(tab, panel); tabs.append(panel);
    }); root.append(tabs); nav.scrollLeft = tabScroll;
    loading.classList.add('d-none'); renderMutationError(); root.classList.remove('d-none');
    if (openMenu) {
      const tab = doc.tabs.find(item => item.id === openMenu.id), trigger = root.querySelector(`[data-tab-menu-id="${CSS.escape(openMenu.id)}"]`);
      if (tab && trigger) tabMenu(tab, trigger, tabs, openMenu.focus);
      else if (openMenu.focus !== 'none') focusTab(openMenu.id);
    }
    if (focused) focusBlock(focused.id, focused.sectionId);
    else if (focusedTab) {
      const selector = focusedTab.kind === 'add' ? '[data-tab-add]' : `[data-${focusedTab.kind === 'handle' ? 'tab-handle-id' : focusedTab.kind === 'menu' ? 'tab-menu-id' : 'tab-id'}="${CSS.escape(focusedTab.id || '')}"]`;
      root.querySelector(selector)?.focus({ preventScroll: true });
    }
  }
  const field = (label, control) => { const group = node('div', 'mb-3'), caption = node('label', 'form-label', label); caption.htmlFor = control.id; group.append(caption, control); return group; };
  const input = (id, value) => { const control = node('input', 'form-control'); Object.assign(control, { id, value: value || '', type: 'text' }); return control; };
  const textarea = (id, value, rows = 4) => { const control = node('textarea', 'form-control'); Object.assign(control, { id, value: value || '', rows }); return control; };
  function reviewFields(entity) {
    const status = node('select', 'form-select'); status.id = 'builder-review-status';
    for (const value of ['unreviewed', 'passed', 'failed']) { const option = node('option', '', STATUS[value].label); option.value = value; option.selected = entity.review.status === value; status.append(option); }
    const reason = textarea('builder-review-reason', entity.review.reason || '', 3); reason.placeholder = 'Что не так с блоком или какие правки нужны?'; reason.maxLength = 1000;
    const update = () => { const failed = status.value === 'failed'; reason.required = failed; reason.closest('.mb-3').classList.toggle('d-none', !failed); if (!failed) reason.value = ''; };
    reviewFooter.hidden = false; reviewFooter.append(field('Визуальная проверка', status));
    fields.append(field('Причина непройденной визуальной проверки', reason)); status.addEventListener('change', () => { update(); state.draft.reviewConfirmed = true; if (status.value === 'failed') reason.scrollIntoView({ block: 'nearest' }); }); update();
  }
  function resetReview() {
    if (!state.draft) return; state.draft.reviewConfirmed = false;
    const status = document.getElementById('builder-review-status'), reason = document.getElementById('builder-review-reason');
    if (status) status.value = 'unreviewed';
    if (reason) { reason.value = ''; reason.required = false; reason.closest('.mb-3').classList.add('d-none'); }
  }
  function bind(control, object, key) {
    control.addEventListener(control.tagName === 'SELECT' || control.type === 'checkbox' ? 'change' : 'input', () => { object[key] = control.type === 'checkbox' ? control.checked : control.value; resetReview(); }); return control;
  }
  function blockFields(entity) {
    const type = node('select', 'form-select'), view = node('select', 'form-select'); type.id = 'builder-type'; view.id = 'builder-view';
    state.blockTypes.forEach(item => type.append(new Option(item.label, item.name, false, entity.type === item.name)));
    const definition = () => state.blockTypes.find(item => item.name === entity.type);
    const updateViews = () => { clear(view); definition().views.forEach(value => view.append(new Option(VIEW[entity.type][value], value, false, value === entity.view))); };
    const selectors = node('div', 'builder-type-view'); selectors.append(field('Тип блока', type), field('Вид отображения', view));
    updateViews(); fields.append(selectors);
    const title = bind(input('builder-title', entity.title), entity, 'title'); title.maxLength = 200; title.placeholder = 'Заголовок';
    fields.append(field('Заголовок', title));
    const content = node('div', 'builder-content-fields'); fields.append(content);
    // Keep fields that belong to another type in this modal's draft only, so a
    // round trip through the selector does not discard the user's input.
    const typeDrafts = new Map();
    const renderContent = () => {
      clear(content);
      const structured = STRUCTURED_TYPES.has(entity.type), rich = entity.type === 'rich-content';
      const text = bind(textarea('builder-content', entity.text, 6), entity, 'text'); text.maxLength = 12000;
      let textField;
      if (!rich) {
        textField = node('fieldset', 'builder-text-fields');
        textField.append(node('legend', 'form-label', 'Текст'), window.BuilderMarkdown.editor(text));
        text.setAttribute('aria-label', 'Текст в Markdown');
      } else {
        textField = field('HTML-код', text);
        text.placeholder = 'Необязательный HTML-фрагмент'; text.classList.add('builder-html-source');
      }
      content.append(textField);
      if (rich) content.append(node('p', 'text-secondary small', 'HTML-код сохраняется как введён и не исполняется в редакторе. Обоснование использования HTML необязательно.'));
      let linkGroup;
      if (definition().fields.some(spec => spec.name === 'link')) { linkGroup = node('fieldset', 'builder-link-fields'); linkGroup.append(node('legend', 'form-label', 'Ссылка')); content.append(linkGroup); }
      definition().fields.filter(spec => !(entity.type === 'embed' && entity.view === 'map' && spec.name === 'ratio')).forEach(spec => {
        let control;
        if (spec.kind === 'select') { control = node('select', 'form-select'); control.id = `builder-${spec.name}`; control.append(new Option('Не задано', '')); spec.values.forEach(value => control.append(new Option(spec.name === 'provider' ? PROVIDER[value] : value, value, false, value === entity[spec.name]))); }
        else { control = input(`builder-${spec.name}`, entity[spec.name]); if (spec.kind === 'boolean') { control.type = 'checkbox'; control.className = 'form-check-input'; control.checked = Boolean(entity[spec.name]); } if (spec.kind === 'url') control.type = 'url'; }
        if (spec.name === 'link') { control.placeholder = 'URL'; control.setAttribute('aria-label', 'URL'); }
        if (spec.name === 'link_text') { control.placeholder = 'Текст ссылки'; control.setAttribute('aria-label', 'Текст ссылки'); }
        if (spec.name === 'reason') control.placeholder = 'Почему выбран HTML-фрагмент (необязательно)';
        const target = ['link', 'link_text'].includes(spec.name) ? linkGroup : content;
        if (target === linkGroup) { const wrapper = node('div', 'mb-3'); wrapper.append(bind(control, entity, spec.name)); target.append(wrapper); }
        else target.append(field(entity.type === 'embed' && entity.view === 'map' && spec.name === 'source_url' ? 'URL карты' : spec.name === 'reason' ? 'Обоснование использования HTML' : spec.label, bind(control, entity, spec.name)));
      });
      if (structured) {
        const placeholder = node('section', 'builder-editor-placeholder'); placeholder.setAttribute('role', 'note');
        const astronaut = node('img'); astronaut.src = '/assets/astronaut.png'; astronaut.alt = ''; astronaut.width = 144; astronaut.height = 144;
        const contents = { table: 'строк и ячеек', 'data-table': 'колонок, строк и ячеек', grid: entity.view === 'gallery' ? 'элементов галереи' : 'карточек', links: entity.view === 'documents' ? 'списка документов' : 'списка ссылок', sections: entity.view === 'contacts' ? 'контактных данных' : 'списка разделов' };
        placeholder.append(astronaut, node('h4', '', 'Редактор содержимого в разработке'), node('p', 'text-secondary', `«${VIEW[entity.type][entity.view]}»: редактирование ${contents[entity.type]} пока недоступно.`));
        content.append(placeholder);
      } else if (['big-media', 'service', 'content'].includes(entity.type)) {
        const label = entity.type === 'service' && ['media-left', 'media-right'].includes(entity.view) ? `Изображения ${entity.view === 'media-left' ? 'слева' : 'справа'}` : 'Изображения';
        mediaFields(entity, content, label);
      }
    };
    view.addEventListener('change', () => { entity.view = view.value; renderContent(); resetReview(); });
    type.addEventListener('change', () => {
      if (entity.type === type.value) return;
      typeDrafts.set(entity.type, Object.fromEntries(definition().fields.filter(spec => Object.hasOwn(entity, spec.name)).map(spec => [spec.name, entity[spec.name]])));
      entity.type = type.value; entity.view = definition().default_view;
      const allowed = new Set(definition().fields.map(item => item.name));
      state.blockTypes.flatMap(item => item.fields).forEach(spec => { if (!allowed.has(spec.name)) delete entity[spec.name]; });
      Object.assign(entity, typeDrafts.get(entity.type));
      updateViews(); renderContent(); resetReview();
    }); renderContent();
  }
  function mediaFields(entity, container = fields, label = 'Изображения') {
    const section = node('section', 'builder-images-section'); section.setAttribute('aria-labelledby', 'builder-images-title');
    const heading = node('h4', '', label); heading.id = 'builder-images-title';
    const draft = state.draft;
    const list = node('div', 'builder-images'), add = action('', () => { if (state.saving || entity.media.length >= 12) return; const asset = { id: `media-${crypto.randomUUID()}`, originalUrl: '', bigUrl: '', href: '', alt: '', caption: '' }; entity.media.push(asset); resetReview(); renderMedia(); document.getElementById(`builder-media-${asset.id}-originalUrl-choose`).focus(); }, 'builder-add builder-image-add');
    add.id = 'builder-add-image'; add.setAttribute('aria-label', 'Добавить изображение'); add.title = 'Добавить изображение';
    const plus = node('span', 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true'); add.append(plus);
    section.append(heading, list, add); container.append(section);
    let dragged = null;
    const move = (id, beforeId) => {
      if (state.saving || id === beforeId) return;
      const index = entity.media.findIndex(item => item.id === id); if (index < 0) return;
      const asset = entity.media.splice(index, 1)[0], destination = beforeId ? entity.media.findIndex(item => item.id === beforeId) : entity.media.length;
      entity.media.splice(destination, 0, asset); resetReview(); renderMedia(); list.querySelector(`[data-media-id="${id}"] .builder-media-drag`)?.focus();
    };
    const renderMedia = () => {
      clear(list); add.disabled = entity.media.length >= 12;
      entity.media.forEach((asset, index) => {
        const row = node('div', 'builder-image-row'); row.dataset.mediaId = asset.id;
        const controls = node('div', 'builder-image-tools'), handle = action('⠿', () => { live.textContent = 'Используйте стрелки вверх и вниз для изменения порядка или перетащите изображение.'; }, 'builder-media-drag'); handle.draggable = true; handle.title = 'Перетащить изображение; стрелки вверх и вниз меняют порядок'; handle.setAttribute('aria-label', `Перетащить изображение ${index + 1}`);
        controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', `Действия с изображением ${index + 1}`);
        handle.addEventListener('dragstart', event => { if (state.saving) { event.preventDefault(); return; } dragged = asset.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', asset.id); });
        handle.addEventListener('dragend', () => { dragged = null; list.querySelectorAll('.builder-drop-before,.builder-drop-after').forEach(item => item.classList.remove('builder-drop-before', 'builder-drop-after')); });
        handle.addEventListener('keydown', event => {
          if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'ArrowUp' && index > 0) move(asset.id, entity.media[index - 1].id);
          if (event.key === 'ArrowDown' && index < entity.media.length - 1) move(asset.id, entity.media[index + 2]?.id);
        });
        const remove = action('', () => { if (state.saving) return; entity.media.splice(index, 1); resetReview(); renderMedia(); add.focus(); }, 'builder-delete text-danger'); remove.setAttribute('aria-label', `Удалить изображение ${index + 1}`); remove.title = 'Удалить изображение'; remove.append(trashIcon());
        controls.append(handle, remove);
        const body = node('div', 'builder-media-form'), saved = sections().flatMap(section => section.blocks).flatMap(block => block.media).find(item => item.id === asset.id);
        const previews = node('div', 'builder-image-previews'), inputs = node('div', 'builder-media-fields');
        const draft = state.draft;
        for (const [kind, caption] of [['original', 'Основная картинка'], ['big', 'Большая картинка']]) {
          const figure = node('figure'), selectedPreview = draft.previews[`${asset.id}-${kind}`];
          const src = selectedPreview || (saved?.[`${kind}Url`] && saved[`${kind}Url`] === asset[`${kind}Url`] ? mediaUrl(saved, kind) : '');
          const preview = node(src ? 'img' : 'div', src ? '' : 'builder-media-placeholder');
          if (src) { preview.src = src; preview.alt = asset.alt || caption; }
          else preview.textContent = caption;
          figure.append(preview); previews.append(figure);
          for (const type of ['dragover', 'drop']) figure.addEventListener(type, event => {
            if (!event.dataTransfer?.types?.includes('Files')) return;
            event.preventDefault(); event.stopPropagation();
          });
        }
        body.append(previews);
        for (const [key, label] of [['originalUrl', 'URL изображения'], ['bigUrl', 'URL крупной версии'], ['href', 'Ссылка изображения'], ['alt', 'Альтернативный текст'], ['caption', 'Подпись']]) {
          const kind = key === 'originalUrl' ? 'original' : key === 'bigUrl' ? 'big' : null;
          const control = input(`builder-media-${asset.id}-${key}`, kind ? mediaFilename(asset, kind) : asset[key]);
          control.placeholder = { originalUrl: 'Основная картинка', bigUrl: 'Большая картинка', href: 'Ссылка', alt: 'Альтернативный текст', caption: 'Подпись' }[key];
          control.setAttribute('aria-label', label);
          const wrapper = node('div', kind ? 'builder-image-picker' : 'builder-image-text'); wrapper.dataset.field = key;
          wrapper.append(control);
          if (kind) {
            control.readOnly = true; control.disabled = true; control.title = control.value;
            const feedback = node('div', 'builder-picker-feedback small'); feedback.hidden = true;
            const choose = action('', async () => {
              if (state.picking || state.saving || state.draft !== draft) return;
              const controller = new AbortController(); state.picking = controller;
              choose.disabled = true; save.disabled = true; formError.classList.add('d-none');
              feedback.classList.remove('text-danger'); feedback.classList.add('text-secondary'); feedback.removeAttribute('role');
              feedback.textContent = ''; feedback.hidden = true;
              try {
                const selected = await state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}/pick-prepared-media`, { method: 'POST', timeoutMs: 3600000, signal: controller.signal, body: JSON.stringify({ revision: draft.revision, ...draft.mediaContext }) });
                feedback.hidden = true;
                if (selected.cancelled) return;
                if (state.draft !== draft || !entity.media.includes(asset) || !row.isConnected) return;
                asset[key] = selected.url; asset[`${kind}Media`] = selected.media; draft.previews[`${asset.id}-${kind}`] = selected.preview;
                resetReview(); renderMedia(); document.getElementById(`builder-media-${asset.id}-${key}-choose`)?.focus();
              } catch (error) {
                if (state.draft === draft && !controller.signal.aborted) {
                  feedback.classList.remove('text-secondary'); feedback.classList.add('text-danger'); feedback.setAttribute('role', 'alert');
                  feedback.textContent = error.message; feedback.hidden = false;
                }
              } finally { if (state.picking === controller) state.picking = null; if (state.draft === draft) { choose.disabled = false; save.disabled = false; } }
            }, 'btn-outline-secondary builder-native-media-picker');
            choose.id = `builder-media-${asset.id}-${key}-choose`; choose.title = `Выбрать ${kind === 'original' ? 'основную' : 'большую'} картинку из шага 2`; choose.setAttribute('aria-label', choose.title);
            choose.append(lineIcon(['M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 9h18'], 'builder-picker-icon'));
            wrapper.append(choose);
            inputs.append(wrapper, feedback);
          } else bind(control, asset, key);
          if (!kind) inputs.append(wrapper);
        }
        body.append(inputs); row.append(body, controls);
        const before = event => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
        row.addEventListener('dragover', event => { if (!dragged || state.saving) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; row.classList.toggle('builder-drop-before', before(event)); row.classList.toggle('builder-drop-after', !before(event)); });
        row.addEventListener('dragleave', () => row.classList.remove('builder-drop-before', 'builder-drop-after'));
        row.addEventListener('drop', event => { if (!dragged || state.saving) return; event.preventDefault(); const id = dragged; dragged = null; move(id, before(event) ? asset.id : entity.media[index + 1]?.id); });
        list.append(row);
      });
    }; renderMedia();
  }
  function createBlock(sectionId, trigger) {
    if (busy() || sections().find(section => section.id === sectionId).blocks.length >= 40) return;
    const entity = { id: `block-${crypto.randomUUID()}`, type: 'content', view: 'default', title: '', text: '', content: '', settings: '', media: [], review: { status: 'unreviewed', reason: '' } };
    open(entity, 'block', sectionId, trigger, 'create');
  }
  function createTab(trigger) {
    if (busy() || state.document.tabs.length >= 12) return;
    const entity = { id: `tab-${crypto.randomUUID()}`, title: 'Новая вкладка', review: { status: 'unreviewed', reason: '' }, blocks: [] };
    open(entity, 'tab', entity.id, trigger, 'create');
  }
  function open(entity, kind, sectionId, trigger, mode = 'edit') {
    if (busy()) return;
    ++state.request;
    const target = { kind, sectionId, id: entity.id }, draft = { jobId: state.jobId, attempt: state.attempt, revision: state.revision, mediaContext: { ...state.mediaContext }, previews: {}, document: structuredClone(state.document), originalEntity: structuredClone(entity), target: structuredClone(target), mode };
    if (mode === 'create') {
      if (kind === 'tab') draft.document.tabs.push(structuredClone(entity));
      else sections(draft.document).find(section => section.id === sectionId).blocks.push(structuredClone(entity));
    }
    const draftEntity = locate(draft.target, draft.document); if (!draftEntity) return;
    state.target = target; state.trigger = trigger; state.draft = draft; state.modalShown = false;
    clear(fields); clear(reviewFooter); reviewFooter.hidden = true; formError.classList.add('d-none'); save.textContent = mode === 'delete' ? `Удалить ${kind === 'tab' ? 'вкладку' : 'блок'}` : 'Сохранить'; save.classList.toggle('btn-danger', mode === 'delete');
    document.getElementById('page-builder-modal-title').textContent = mode === 'create' ? `Добавить ${kind === 'tab' ? 'вкладку' : 'блок'}` : `Редактировать ${kind === 'tab' ? 'вкладку' : 'блок'}`; document.getElementById('page-builder-modal-kind').textContent = kind === 'tab' ? 'Вкладка страницы' : 'Блок страницы';
    if (mode === 'delete') {
      document.getElementById('page-builder-modal-title').textContent = `Удалить ${kind === 'tab' ? 'вкладку' : 'блок'}?`;
      fields.append(node('p', '', kind === 'tab' ? `Вкладка «${draftEntity.title}» будет удалена вместе с ${draftEntity.blocks.length} блоками, изображениями и проверками.` : `Блок «${draftEntity.title}» будет удалён из раздела вместе с изображениями и проверкой.`));
      window.tabler.Modal.getOrCreateInstance(modalElement).show(trigger); return;
    }
    if (kind === 'tab') { fields.append(field('Название вкладки', input('builder-title', draftEntity.title))); window.tabler.Modal.getOrCreateInstance(modalElement).show(trigger); return; }
    blockFields(draftEntity);
    if (mode !== 'create') reviewFields(draftEntity);
    else fields.append(node('p', 'text-secondary small', 'Новый блок сохраняется со статусом «Не проверено».'));
    window.tabler.Modal.getOrCreateInstance(modalElement).show(trigger);
  }
  function locate(target, document) {
    const section = target.kind === 'section' ? document.common : [document.common, ...document.tabs].find(item => item.id === target.sectionId);
    return target.kind === 'block' ? section?.blocks.find(item => item.id === target.id) : section;
  }
  function savingUi(busy) {
    save.disabled = busy; save.classList.toggle('btn-loading', busy); modalElement.toggleAttribute('aria-busy', busy);
    modalElement.querySelectorAll('[data-bs-dismiss="modal"]').forEach(control => { control.disabled = busy; control.setAttribute('aria-disabled', String(busy)); });
  }
  modalElement.addEventListener('hide.bs.modal', event => { if (state.saving) event.preventDefault(); else state.picking?.abort(); });
  modalElement.addEventListener('shown.bs.modal', () => {
    state.modalShown = true;
    if (state.pendingSaved || state.draft?.closeWhenShown) { if (state.draft) state.draft.closeWhenShown = false; window.tabler.Modal.getInstance(modalElement).hide(); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (state.saving || state.pendingSaved || state.picking) return;
    formError.classList.add('d-none'); const draft = state.draft, target = draft && locate(draft.target, draft.document); if (!target) return;
    const advertised = state.pendingJob, currentJobId = advertised?.id || state.jobId, currentRevision = advertised ? Number(advertised.pageBuilder?.revision || 0) : state.revision;
    if (draft.jobId !== currentJobId || draft.attempt !== (advertised?.builderAttempt ?? state.attempt) || draft.revision !== currentRevision) { formError.textContent = 'Страница обновилась. Закройте редактор и откройте блок снова.'; formError.classList.remove('d-none'); return; }
    if (draft.mode === 'delete') {
      const next = structuredClone(draft.document);
      if (draft.target.kind === 'tab') next.tabs = next.tabs.filter(tab => tab.id !== draft.target.id);
      else { const section = sections(next).find(section => section.id === draft.target.sectionId); section.blocks = section.blocks.filter(block => block.id !== draft.target.id); }
      await persistDraft(draft, next); return;
    }
    if (draft.target.kind === 'tab') {
      const title = document.getElementById('builder-title').value.trim();
      if (!title) { formError.textContent = 'Название не может быть пустым.'; formError.classList.remove('d-none'); return; }
      if (title.length > 200) { formError.textContent = 'Название не может быть длиннее 200 символов.'; formError.classList.remove('d-none'); return; }
      const next = structuredClone(draft.document); locate(draft.target, next).title = title;
      if (draft.mode === 'edit' && title === draft.originalEntity.title) { if (state.modalShown) window.tabler.Modal.getInstance(modalElement).hide(); else draft.closeWhenShown = true; return; }
      await persistDraft(draft, next); return;
    }
    const status = document.getElementById('builder-review-status')?.value || 'unreviewed', reason = document.getElementById('builder-review-reason')?.value.trim() || '';
    if (status === 'failed' && !reason) { formError.textContent = 'Укажите причину непройденной проверки.'; formError.classList.remove('d-none'); document.getElementById('builder-review-reason').focus(); return; }
    const next = structuredClone(draft.document), edited = locate(draft.target, next); edited.title = document.getElementById('builder-title').value.trim(); edited.review = { status, reason: status === 'failed' ? reason : '' };
    if (draft.reviewConfirmed && status !== 'unreviewed') edited.reviewedRevision = draft.revision;
    if (draft.mode === 'edit' && !draft.reviewConfirmed && JSON.stringify(edited) === JSON.stringify(draft.originalEntity)) {
      if (state.modalShown) window.tabler.Modal.getInstance(modalElement).hide(); else draft.closeWhenShown = true;
      return;
    }
    await persistDraft(draft, next);
  });
  async function persistDraft(draft, next) {
    state.saving = draft; savingUi(true);
    try {
      const stored = await state.api(pageUrl(draft.jobId, draft.attempt), { method: 'POST', body: JSON.stringify({ revision: draft.revision, document: next }) });
      if (state.draft !== draft || state.saving !== draft) return;
      state.pendingSaved = stored; state.saving = null; state.mutationError = '';
      if (state.modalShown) window.tabler.Modal.getInstance(modalElement).hide();
    } catch (error) {
      if (state.draft === draft && state.saving === draft) { formError.textContent = `Не удалось сохранить: ${error.message}`; formError.classList.remove('d-none'); }
    } finally {
      if (state.saving === draft) state.saving = null;
      if (state.draft === draft && !state.pendingSaved) savingUi(false);
    }
  }
  async function fetchAndRender(job, advertisedRevision) {
    if (busy() || state.drag) { state.pendingJob = job; return; }
    const switching = !samePage(job);
    if (switching) { state.jobId = job.id; state.attempt = job.builderAttempt; state.revision = 0; state.document = null; state.activeTab = null; state.mutationError = ''; renderProgress(); root.classList.add('d-none'); errorBox.classList.add('d-none'); loading.classList.remove('d-none'); }
    const request = ++state.request;
    try {
      const stored = await state.api(pageUrl(job.id, job.builderAttempt)); if (request !== state.request) return;
      if (busy() || state.drag) { state.pendingJob = job; return; }
      state.mediaContext = stored.mediaContext;
      if (samePage(job) && state.document && state.revision === stored.revision) { loading.classList.add('d-none'); renderMutationError(); root.classList.remove('d-none'); return; }
      state.jobId = job.id; state.attempt = job.builderAttempt; state.revision = stored.revision; state.document = stored.document; state.blockTypes = stored.blockTypes;
      state.blockTypes.forEach(type => { TYPE[type.name] = type.label; }); render();
      if (!advertisedRevision) await state.refresh?.();
    } catch (error) {
      if (request !== state.request || busy() || state.drag) return;
      loading.classList.add('d-none'); errorBox.textContent = [state.mutationError, `Системная ошибка шага 3: ${error.message}`].filter(Boolean).join(' '); errorBox.classList.remove('d-none');
    }
  }
  modalElement.addEventListener('hidden.bs.modal', () => {
    const trigger = state.trigger, target = state.target, saved = state.pendingSaved, pendingJob = state.pendingJob;
    state.target = null; state.trigger = null; state.draft = null; state.saving = null; state.pendingSaved = null; state.pendingJob = null; savingUi(false); clear(fields); clear(reviewFooter); reviewFooter.hidden = true;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    window.setTimeout(async () => {
      if (pendingJob && !samePage(pendingJob)) { await fetchAndRender(pendingJob, Number(pendingJob.pageBuilder?.revision || 0)); await state.refresh?.(); return; }
      if (saved) { state.revision = saved.revision; state.document = saved.document; if (target?.kind === 'tab') state.activeTab = target.id; render(); if (target?.kind === 'tab') focusTab(target.id); else focusBlock(target?.id, target?.sectionId); await state.refresh?.(); return; }
      if (pendingJob) { await fetchAndRender(pendingJob, Number(pendingJob.pageBuilder?.revision || 0)); if (target?.kind === 'tab') focusTab(target.id); else focusBlock(target?.id, target?.sectionId); }
    }, 0);
  });
  async function load(job, options) {
    const attempt = options.attempt || job.attempts.at(-1);
    job = { ...job, builderAttempt: attempt.number, pageBuilder: attempt.pageBuilder, mediaContext: { attempt: attempt.number, htmlRevision: attempt.htmlMedia?.revision || 0 } };
    state.api = options.api; state.refresh = options.refresh; const revision = Number(job.pageBuilder?.revision || 0);
    if (samePage(job) && state.document && revision === state.revision) { state.mediaContext = job.mediaContext; if (state.pendingJob && !samePage(state.pendingJob)) { root.classList.remove('d-none'); renderProgress(summary()); } state.pendingJob = null; return; }
    if (busy() || state.drag) { state.pendingJob = job; if (!samePage(job)) { ++state.request; root.classList.add('d-none'); renderProgress(); } return; }
    await fetchAndRender(job, revision);
  }
  window.PageBuilder = { render: load };
})();
