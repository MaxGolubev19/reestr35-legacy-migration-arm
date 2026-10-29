(() => {
  'use strict';
  const STATUS = {
    pending: { label: 'Ожидает отправки', className: 'review-pending' },
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
  const STRUCTURED_TYPES = new Set(['table', 'grid', 'data-table']);
  const PROVIDER = { iframe: 'Виджет (iframe)', map: 'Карта', video: 'Видео', unknown: 'Другой источник' };
  const ASSEMBLY_HINT = 'Идёт сборка страницы агентом';
  const state = { jobId: null, attempt: null, revision: 0, document: null, activeTab: null, request: 0, api: null, refresh: null,
    target: null, trigger: null, draft: null, saving: null, pendingJob: null, pendingSaved: null, mutation: null, drag: null, mutationError: '', assembling: false };
  const root = document.getElementById('page-builder-content'), loading = document.getElementById('page-builder-loading'), errorBox = document.getElementById('page-builder-error');
  const modalElement = document.getElementById('page-builder-modal'), form = document.getElementById('page-builder-form'), fields = document.getElementById('page-builder-fields');
  const formError = document.getElementById('page-builder-form-error'), save = document.getElementById('page-builder-save');
  const mediaPreviewObservers = new Set();
  let mediaRevisions = new Map();
  // Каким статусом сборки отрисован текущий DOM: load синхронизирует блокировку
  // даже когда ревизия не изменилась и ранний выход не вызывает render.
  let renderedAssemblyLock = false;
  function clearMediaPreviewObservers() { mediaPreviewObservers.forEach(observer => observer.disconnect()); mediaPreviewObservers.clear(); }
  const reviewFooter = document.createElement('div'); reviewFooter.className = 'builder-review-footer'; reviewFooter.hidden = true; modalElement.querySelector('.modal-footer').prepend(reviewFooter);
  const progressCount = document.getElementById('builder-progress-count'), progressBar = document.getElementById('builder-progress-bar');
  const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const clear = item => item.replaceChildren();
  const live = node('div', 'visually-hidden'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); root.after(live);
  const syncNotice = node('div', 'alert alert-warning d-none'); syncNotice.id = 'page-builder-sync-notice'; syncNotice.setAttribute('role', 'status'); root.before(syncNotice);
  const sections = (doc = state.document) => [doc.common, ...doc.tabs];
  const busy = () => Boolean(state.draft || state.saving || state.mutation);
  const samePage = job => state.jobId === job.id && state.attempt === job.builderAttempt;
  const pageUrl = (jobId, attempt) => `/api/page-builder/${encodeURIComponent(jobId)}?attempt=${attempt}`;
  function syncAssemblyLock(attempt) {
    const locked = attempt?.builder?.status === 'running';
    if (state.assembling === locked) return;
    state.assembling = locked;
    if (locked) { save.disabled = true; save.title = ASSEMBLY_HINT; }
    else { save.title = ''; if (state.draft && !state.saving && !state.picking) save.disabled = false; }
    if (state.draft) updateReviewAvailability();
  }
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
    if (busy() || state.assembling) return;
    const operation = { jobId: state.jobId, attempt: state.attempt, revision: state.revision, originSectionId: sections().find(section => section.blocks.some(block => block.id === id))?.id || sectionId }; state.mutation = operation; ++state.request;
    state.mutationError = ''; root.inert = true; root.setAttribute('aria-busy', 'true'); renderMutationError(); live.textContent = 'Сохранение…';
    try {
      const stored = await state.api(pageUrl(operation.jobId, operation.attempt), { method: 'POST', body: JSON.stringify({ revision: operation.revision, document: next }) });
      acceptDocument(stored, null);
      if (sectionId !== stored.document.common.id) state.activeTab = sectionId;
      render(); live.textContent = message;
    } catch (error) {
      state.mutationError = `Не удалось сохранить: ${error.message}`; renderMutationError(); live.textContent = state.mutationError;
      // Keep polling and new edits fenced until the rejected mutation has been
      // reconciled. The visible error belongs to this job, not to one DOM render.
      try {
        const stored = await state.api(pageUrl(operation.jobId, operation.attempt));
        acceptDocument(stored); render();
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
    if (busy() || state.assembling) return;
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
    if (busy() || state.assembling || id === targetId) return;
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
      if (state.drag?.kind !== 'block' || busy() || state.assembling) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
      root.querySelectorAll('.builder-drop-before, .builder-drop-after, .builder-drop-active').forEach(item => item.classList.remove('builder-drop-before', 'builder-drop-after', 'builder-drop-active'));
      element.classList.add(blockId ? `builder-drop-${position(event)}` : 'builder-drop-active');
    });
    element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('builder-drop-before', 'builder-drop-after', 'builder-drop-active'); });
    element.addEventListener('drop', event => {
      if (state.drag?.kind !== 'block' || busy() || state.assembling) return;
      event.preventDefault(); event.stopPropagation();
      const id = state.drag.id, section = sections().find(item => item.id === sectionId);
      const beforeId = blockId && position(event) === 'before' ? blockId : blockId ? section.blocks[section.blocks.findIndex(block => block.id === blockId) + 1]?.id || null : null;
      clearDrag(); moveBlock(id, sectionId, beforeId);
    });
  }
  function sectionControls(section, container) {
    const add = action('', () => createBlock(section.id, add), 'builder-add builder-section-drop'); add.dataset.addSection = section.id; add.disabled = section.blocks.length >= 40 || Boolean(state.assembling);
    add.setAttribute('aria-label', `Добавить блок: ${section.title}`);
    add.title = state.assembling ? ASSEMBLY_HINT : `Добавить блок: ${section.title}`;
    const plus = node('span', 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true');
    add.append(plus);
    add.dataset.dropSection = section.id; dropTarget(add, section.id); container.append(add);
  }
  function acceptDocument(stored, refreshBlockId) {
    // Local saves know which block can have new image bytes. External revisions
    // must invalidate all media because their URLs can stay unchanged.
    const previous = mediaRevisions;
    mediaRevisions = new Map(sections(stored.document).flatMap(section => section.blocks.flatMap(block => block.media.map(asset => [asset.id,
      refreshBlockId === undefined || block.id === refreshBlockId ? stored.revision : previous.get(asset.id) ?? stored.revision]))));
    state.revision = stored.revision; state.document = stored.document; state.frames = stored.frames || {}; state.mediaContext = stored.mediaContext || state.mediaContext; state.sync = stored.sync || null;
  }
  function blockReview(block) {
    const sync = state.sync?.blocks?.[block.id];
    return sync?.status === 'synced' ? block.review : { status: 'pending', reason: sync?.error || '' };
  }
  function blockLabel(block, review) {
    const count = block.type === 'links' && block.view === 'documents' ? (block.items || []).filter(item => item.link && (item.sourceDocument || item.meta?.kind === 'document')).length : 0;
    return `${block.title.trim() || 'Без заголовка'}. ${TYPE[block.type]}. ${STATUS[review.status].label}.${review.reason ? ` Ошибка отправки: ${review.reason}.` : ''}${count ? ` Документов: ${count}.` : ''} Открыть настройки`;
  }
  function renderSyncNotice() {
    const message = state.sync?.lastError || '';
    syncNotice.textContent = message ? `Синхронизация с Beget: ${message}` : '';
    syncNotice.classList.toggle('d-none', !message);
  }
  function updateSync(sync, force = false) {
    if (!force && JSON.stringify(sync) === JSON.stringify(state.sync)) return;
    state.sync = sync || null;
    if (!state.document) return;
    for (const block of sections().flatMap(section => section.blocks)) {
      const button = root.querySelector(`[data-builder-id="${CSS.escape(block.id)}"]`), card = button?.closest('.builder-block');
      if (!card) continue;
      const review = blockReview(block);
      Object.values(STATUS).forEach(status => card.classList.remove(status.className)); card.classList.add(STATUS[review.status].className);
      button.setAttribute('aria-label', blockLabel(block, review));
      card.querySelector('.builder-failure-reason')?.classList.toggle('d-none', review.status === 'pending');
      const syncError = card.querySelector('.builder-sync-error'); if (syncError) { syncError.textContent = review.status === 'pending' ? review.reason : ''; syncError.classList.toggle('d-none', !syncError.textContent); }
    }
    for (const tab of state.document.tabs) {
      const button = root.querySelector(`[data-tab-id="${CSS.escape(tab.id)}"]`), review = sectionReview(tab);
      if (!button) continue;
      button.setAttribute('aria-label', `${tab.title}: ${STATUS[review.status].label}`);
      button.querySelector('.builder-status-dot').className = `builder-status-dot ${STATUS[review.status].className}`;
    }
    renderProgress(summary()); renderSyncNotice(); updateReviewAvailability();
  }
  function mediaUrl(asset, kind = asset.originalUrl ? 'original' : 'big') { return `/api/page-builder/${encodeURIComponent(state.jobId)}/media/${encodeURIComponent(asset.id)}?kind=${kind}&revision=${mediaRevisions.get(asset.id) ?? state.revision}&attempt=${state.attempt}`; }
  function framePreview(entity, frames) {
    if (!entity.source_url) {
      const placeholder = node('span', 'builder-media-placeholder builder-frame-placeholder');
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.append(lineIcon(['M3 5h18v14H3z', 'm10 9 5 3-5 3z']));
      return placeholder;
    }
    const item = frames?.[entity.id] || { reason: 'Источник не найден среди фреймов шага 2' };
    const viewport = node('span', 'media-frame-viewport');
    viewport.append(window.ArmEmbedPolicy.createFrame(item, { preview: true }));
    return viewport;
  }
  function summary() {
    const reviews = [state.document.common, ...state.document.tabs].flatMap(section => section.blocks.map(blockReview));
    const failed = reviews.filter(item => item.status === 'failed').length, passed = reviews.filter(item => item.status === 'passed').length, unreviewed = reviews.length - failed - passed;
    return { status: failed ? 'failed' : unreviewed || !reviews.length ? 'unreviewed' : 'passed', passed, failed, unreviewed, reviewed: passed + failed, total: reviews.length, reviews };
  }
  function sectionReview(section) {
    if (state.sync?.tabs?.[section.id]?.status !== 'synced' || section.blocks.some(block => blockReview(block).status === 'pending')) return { status: 'pending', reason: '' };
    const failed = section.blocks.find(block => block.review.status === 'failed');
    return failed ? { status: 'failed', reason: failed.review.reason } : { status: section.blocks.length && section.blocks.every(block => block.review.status === 'passed') ? 'passed' : 'unreviewed', reason: '' };
  }
  function renderProgress(totals = { reviewed: 0, total: 0, passed: 0, failed: 0, unreviewed: 0, reviews: [] }) {
    progressCount.textContent = `${totals.reviewed}/${totals.total}`; clear(progressBar);
    const classes = { passed: 'bg-green', failed: 'bg-yellow', unreviewed: 'bg-blue', pending: 'bg-secondary' }, labels = { passed: 'Пройдено', failed: 'Не пройдено', unreviewed: 'Не проверено', pending: 'Ожидает отправки' };
    totals.reviews.forEach(review => { const segment = node('span', `progress-bar qa-progress-segment ${classes[review.status] || classes.unreviewed}`); segment.title = labels[review.status] || labels.unreviewed; segment.setAttribute('aria-hidden', 'true'); progressBar.append(segment); });
    const percent = totals.total ? Math.round((totals.reviewed / totals.total) * 100) : 0;
    progressBar.setAttribute('aria-valuenow', String(percent));
    const pending = totals.reviews.filter(review => review.status === 'pending').length;
    progressBar.setAttribute('aria-label', `Проверено ${totals.reviewed} из ${totals.total} блоков: пройдено ${totals.passed}, не пройдено ${totals.failed}, не проверено ${totals.unreviewed - pending}${pending ? `, ожидает отправки ${pending}` : ''}`);
  }
  function blockCard(block, sectionId) {
    const review = blockReview(block);
    const title = block.title.trim() || 'Без заголовка';
    const documents = block.type === 'links' && block.view === 'documents' ? (block.items || []).filter(item => item.link && (item.sourceDocument || item.meta?.kind === 'document')) : [];
    const cardKind = block.type === 'embed' ? 'builder-embed-block ' : block.type === 'links' && block.view === 'documents' ? 'builder-document-block ' : '';
    const column = node('div', 'col-12'), card = node('div', `card builder-block ${cardKind}${STATUS[review.status].className}`), button = node('button', 'builder-block-open'); button.type = 'button';
    button.setAttribute('aria-label', blockLabel(block, review));
    Object.assign(button.dataset, { builderKind: 'block', builderSectionId: sectionId, builderId: block.id });
    const body = node('span', 'card-body builder-block-body text-start'), copy = node('span', 'builder-block-copy');
    copy.append(node('strong', 'builder-block-title', title));
    const preview = window.BuilderMarkdown.plainText(block.text, block.type === 'rich-content');
    if (preview) copy.append(node('span', 'text-secondary builder-text-preview', preview.length > 300 ? `${preview.slice(0, 300)}…` : preview));
    if (block.review.reason) { const reason = node('span', 'builder-failure-reason', block.review.reason); reason.classList.toggle('d-none', review.status === 'pending'); copy.append(reason); }
    const syncError = node('span', 'builder-sync-error', review.status === 'pending' ? review.reason : ''); syncError.classList.toggle('d-none', !syncError.textContent); copy.append(syncError);
    body.append(blockTypeIcon(block.type), copy);
    const visibleMedia = block.media.filter(asset => asset.originalUrl || asset.bigUrl);
    if (block.type === 'embed') {
      const frame = state.frames[block.id];
      if (block.source_url && (block.sourceFrame || frame?.selectable && frame.resolvedUrl === block.source_url)) {
        const gallery = node('span', 'builder-media-preview builder-embed-media-preview');
        gallery.append(framePreview(block, state.frames)); body.append(gallery);
      }
    } else if (documents.length) {
      const gallery = node('span', 'builder-media-preview builder-document-media-preview');
      for (const item of documents.slice(0, 2)) {
        const name = String(item.link_text || item.title || 'Документ').trim() || 'Документ';
        const appearance = documentAppearance(item), chip = node('span', `builder-card-document media-document-icon media-document-${appearance.category}`);
        chip.title = name; chip.append(appearance.icon); gallery.append(chip);
      }
      if (documents.length > 2) gallery.append(node('span', 'builder-media-more builder-document-more-desktop', `+${documents.length - 2}`));
      if (documents.length > 1) gallery.append(node('span', 'builder-media-more builder-document-more-mobile', `+${documents.length - 1}`));
      body.append(gallery);
    } else if (visibleMedia.length) {
      const gallery = node('span', 'builder-media-preview');
      for (const asset of visibleMedia.slice(0, 2)) { const img = node('img'); img.src = mediaUrl(asset); img.alt = asset.alt || ''; img.loading = 'lazy'; gallery.append(img); }
      if (visibleMedia.length > 2) gallery.append(node('span', 'builder-media-more', `+${visibleMedia.length - 2}`)); body.append(gallery);
    }
    button.append(body); button.addEventListener('click', () => open(block, 'block', sectionId, button)); card.append(button); column.append(card);
    column.dataset.blockId = block.id; dropTarget(column, sectionId, block.id);
    blockControls(block, sectionId, column); return column;
  }
  function blockControls(block, sectionId, column) {
    const card = column.querySelector('.builder-block'); card.querySelector('.builder-card-tools')?.remove();
    const controls = node('div', 'builder-card-tools'); controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', `Действия: ${block.title}`);
    const handle = action('', () => { const expanded = panel.hidden; closeActionPanels(); panel.hidden = !expanded; handle.setAttribute('aria-expanded', String(expanded)); live.textContent = expanded ? 'Выберите «Выше», «Ниже» или раздел для переноса. Escape закрывает действия.' : ''; }, 'builder-drag-handle'); handle.append(dragIcon()); handle.draggable = true;
    handle.setAttribute('aria-label', `Перетащить блок: ${block.title}`); handle.title = 'Перетащить блок; нажмите для выбора порядка и раздела';
    // Protect the source as soon as the pointer is pressed: a pending poll can
    // otherwise replace this node before the browser emits native dragstart.
    // Fence polling before the browser's drag threshold: detaching the pressed
    // node between pointerdown and dragstart silently cancels native dragging.
    handle.addEventListener('pointerdown', event => { if (event.button === 0 && !busy() && !state.assembling) { state.drag = { kind: 'block', id: block.id, started: false }; ++state.request; } });
    handle.addEventListener('dragstart', event => { if (busy() || state.assembling) { event.preventDefault(); return; } closeActionPanels(); state.drag = { kind: 'block', id: block.id, started: true }; ++state.request; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', block.id); column.classList.add('builder-drag-source'); root.classList.add('builder-dragging'); live.textContent = `Перемещение: ${block.title}. Отпустите над блоком, вкладкой или зоной раздела.`; });
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
    const remove = action('', () => open(block, 'block', sectionId, remove, 'delete'), 'builder-delete'); remove.setAttribute('aria-label', `Удалить блок: ${block.title}`); remove.title = state.assembling ? ASSEMBLY_HINT : 'Удалить блок';
    remove.disabled = Boolean(state.assembling);
    remove.append(trashIcon());
    controls.append(disclosure, remove); card.append(controls);
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
    remove.disabled = Boolean(state.assembling); remove.title = state.assembling ? ASSEMBLY_HINT : '';
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
  function renderSection(section, container, target) {
    const grid = container.querySelector(':scope > .row') || node('div', 'row g-2');
    const columns = new Map([...grid.children].map(column => [column.dataset.blockId, column]));
    for (const [id, column] of columns) if (!section.blocks.some(block => block.id === id)) column.remove();
    for (const block of section.blocks) {
      const column = columns.get(block.id);
      if (!column) grid.append(blockCard(block, section.id));
      else if (target?.kind === 'block' && target.id === block.id) column.replaceWith(blockCard(block, section.id));
      else blockControls(block, section.id, column);
    }
    if (!grid.isConnected) container.append(grid);
    container.querySelector(':scope > [data-add-section]')?.remove(); sectionControls(section, container);
  }
  function render(target = null) {
    const active = document.activeElement, focused = root.contains(active) && (active.dataset.builderId || active.dataset.addSection) ? { id: active.dataset.builderId, sectionId: active.dataset.builderSectionId || active.dataset.addSection } : null;
    const focusedTab = root.contains(active) && !focused && (active.dataset.tabId || active.dataset.tabHandleId || active.dataset.tabMenuId || active.dataset.tabAdd) ? { id: active.dataset.tabId || active.dataset.tabHandleId || active.dataset.tabMenuId, kind: active.dataset.tabHandleId ? 'handle' : active.dataset.tabMenuId ? 'menu' : active.dataset.tabAdd ? 'add' : 'tab' } : null;
    const openMenuTrigger = root.querySelector('.builder-tab-menu-button[aria-expanded="true"]');
    const openMenu = openMenuTrigger && { id: openMenuTrigger.dataset.tabMenuId, focus: active?.dataset.tabMenuAction || (active === openMenuTrigger ? 'trigger' : 'none') };
    const tabScroll = root.querySelector('.builder-tabs')?.scrollLeft || 0;
    // Editor saves retain the connected image subtrees of every other block.
    // Rebuild controls separately so changed section names/counts stay current.
    if (!target) clear(root); const doc = state.document, totals = summary(); renderProgress(totals);
    const common = root.querySelector(':scope > .builder-section') || node('section', 'builder-section'); common.setAttribute('aria-label', 'Общая часть');
    renderSection(doc.common, common, target); if (!common.isConnected) root.append(common);
    const tabs = root.querySelector('.builder-tabs-section') || node('section', 'builder-section builder-tabs-section'), row = node('div', 'builder-tabs-row');
    tabs.querySelector(':scope > .builder-tabs-row')?.remove(); tabs.querySelector(':scope > [data-tab-add]')?.remove(); closeTabMenu();
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
      handle.addEventListener('pointerdown', event => { if (event.button === 0 && !busy() && !state.assembling) { state.drag = { kind: 'tab', id: tab.id, started: false }; ++state.request; } });
      handle.addEventListener('dragstart', event => { if (busy() || state.assembling) { event.preventDefault(); return; } closeTabMenu(); state.drag = { kind: 'tab', id: tab.id, started: true }; ++state.request; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', tab.id); item.classList.add('builder-drag-source'); live.textContent = `Перемещение вкладки «${tab.title}».`; });
      handle.addEventListener('dragend', () => { clearDrag(); const pending = state.pendingJob; if (pending && !busy()) { state.pendingJob = null; void fetchAndRender(pending, Number(pending.pageBuilder?.revision || 0)); } });
      handle.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const target = doc.tabs[tabIndex + (event.key === 'ArrowLeft' ? -1 : 1)]; if (target) moveTab(tab.id, target.id, event.key === 'ArrowRight'); });
      item.addEventListener('dragover', event => { if (state.drag?.kind !== 'tab' || busy() || state.assembling) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; nav.querySelectorAll('.builder-tab-drop-before,.builder-tab-drop-after').forEach(node => node.classList.remove('builder-tab-drop-before', 'builder-tab-drop-after')); item.classList.add(event.clientX < item.getBoundingClientRect().left + item.getBoundingClientRect().width / 2 ? 'builder-tab-drop-before' : 'builder-tab-drop-after'); });
      item.addEventListener('drop', event => { if (state.drag?.kind !== 'tab' || busy() || state.assembling) return; event.preventDefault(); event.stopPropagation(); const id = state.drag.id, after = event.clientX >= item.getBoundingClientRect().left + item.getBoundingClientRect().width / 2; clearDrag(); moveTab(id, tab.id, after); });
      const menu = action('⋯', () => tabMenu(tab, menu, tabs), 'builder-tab-menu-button'); menu.dataset.tabMenuId = tab.id; menu.setAttribute('aria-label', `Действия вкладки: ${tab.title}`); menu.setAttribute('aria-expanded', 'false');
      item.append(handle, button, menu); nav.append(item);
    });
    const addTab = action('', () => createTab(addTab), doc.tabs.length ? 'builder-tab-add' : 'builder-add builder-tab-empty-add');
    const plus = node('span', doc.tabs.length ? '' : 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true'); addTab.append(plus);
    addTab.dataset.tabAdd = 'true'; addTab.setAttribute('aria-label', 'Добавить вкладку'); addTab.title = state.assembling ? ASSEMBLY_HINT : 'Добавить вкладку'; addTab.disabled = doc.tabs.length >= 12 || Boolean(state.assembling);
    if (doc.tabs.length) { row.append(nav, addTab); tabs.prepend(row); }
    else tabs.prepend(addTab);
    for (const panel of tabs.querySelectorAll(':scope > .builder-tab-panel')) if (!doc.tabs.some(tab => panel.id === `builder-panel-${tab.id}`)) panel.remove();
    doc.tabs.forEach(tab => {
      const selected = state.activeTab === tab.id, panel = tabs.querySelector(`#builder-panel-${CSS.escape(tab.id)}`) || node('div', 'builder-tab-panel'); panel.id = `builder-panel-${tab.id}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `builder-tab-${tab.id}`); panel.tabIndex = selected ? 0 : -1; panel.hidden = !selected;
      renderSection(tab, panel, target); if (!panel.isConnected) tabs.append(panel);
    }); if (!tabs.isConnected) root.append(tabs); nav.scrollLeft = tabScroll;
    if (target) updateSync(state.sync, true); else renderSyncNotice();
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
    renderedAssemblyLock = Boolean(state.assembling);
  }
  const field = (label, control) => { const group = node('div', 'mb-3'), caption = node('label', 'form-label', label); caption.htmlFor = control.id; group.append(caption, control); return group; };
  const input = (id, value) => { const control = node('input', 'form-control'); Object.assign(control, { id, value: value || '', type: 'text' }); return control; };
  const textarea = (id, value, rows = 4) => { const control = node('textarea', 'form-control'); Object.assign(control, { id, value: value || '', rows }); return control; };
  function growTextarea(control) {
    control.style.height = 'auto';
    control.style.height = `${Math.max(control.scrollHeight + control.offsetHeight - control.clientHeight, parseFloat(getComputedStyle(control).minHeight) || 0)}px`;
  }
  function reviewFields(entity) {
    const status = node('select', 'form-select'); status.id = 'builder-review-status';
    for (const value of ['unreviewed', 'passed', 'failed']) { const option = node('option', '', STATUS[value].label); option.value = value; option.selected = entity.review.status === value; status.append(option); }
    const reason = textarea('builder-review-reason', entity.review.reason || '', 3); reason.placeholder = 'Что не так с блоком или какие правки нужны?'; reason.maxLength = 1000;
    const update = () => { const failed = status.value === 'failed'; reason.required = failed; reason.closest('.mb-3').classList.toggle('d-none', !failed); if (!failed) reason.value = ''; };
    reviewFooter.hidden = false; reviewFooter.append(field('Визуальная проверка', status));
    fields.append(field('Причина непройденной визуальной проверки', reason)); status.addEventListener('change', () => { update(); state.draft.reviewConfirmed = true; scheduleAutosave(false); if (status.value === 'failed') reason.scrollIntoView({ block: 'nearest' }); });
    reason.addEventListener('input', () => { state.draft.reviewConfirmed = true; scheduleAutosave(false); }); update(); updateReviewAvailability();
  }
  function updateReviewAvailability() {
    const status = document.getElementById('builder-review-status'), draft = state.draft;
    if (!status || !draft || state.saving || state.pendingSaved) return;
    const pending = state.assembling || state.sync?.blocks?.[draft.target.id]?.status !== 'synced' || draft.contentChanged || draft.revision !== state.revision;
    status.disabled = Boolean(pending);
    status.title = state.assembling ? ASSEMBLY_HINT : pending ? 'Проверка доступна после отправки текущей версии в Beget' : '';
    status.options[0].textContent = pending ? STATUS.pending.label : STATUS.unreviewed.label;
    if (pending) { status.value = 'unreviewed'; draft.reviewConfirmed = false; }
    const reason = document.getElementById('builder-review-reason');
    if (reason) { reason.disabled = Boolean(pending); if (pending) { reason.required = false; reason.closest('.mb-3').classList.add('d-none'); } }
  }
  function resetReview() {
    if (!state.draft) return; state.draft.reviewConfirmed = false; state.draft.contentChanged = true;
    const status = document.getElementById('builder-review-status'), reason = document.getElementById('builder-review-reason');
    if (status) status.value = 'unreviewed';
    if (reason) { reason.value = ''; reason.required = false; reason.closest('.mb-3').classList.add('d-none'); }
    updateReviewAvailability(); scheduleAutosave(true);
  }
  function bind(control, object, key) {
    control.addEventListener(control.tagName === 'SELECT' || control.type === 'checkbox' ? 'change' : 'input', () => { object[key] = control.type === 'checkbox' ? control.checked : control.value; resetReview(); }); return control;
  }
  function itemMarkdownField(item, id, extraClass = '', valueKey = 'text') {
    const details = node('details', `builder-text-fields builder-item-markdown builder-gallery-collapsible mb-3${extraClass ? ` ${extraClass}` : ''}`);
    const control = bind(textarea(id, item[valueKey], 6), item, valueKey); control.maxLength = 12000; control.setAttribute('aria-label', 'Текст в Markdown');
    details.append(node('summary', '', 'Текст'), window.BuilderMarkdown.editor(control)); return details;
  }
  function itemDetails(body, item, fallback, openItems) {
    const details = node('details', 'builder-item-details'), summary = node('summary', 'builder-item-summary');
    const update = () => { summary.textContent = String(item.title || '').trim() || fallback; };
    details.open = openItems.has(item.id); details.addEventListener('toggle', () => { if (details.open) openItems.add(item.id); else openItems.delete(item.id); });
    details.append(summary, body); update(); return { details, update };
  }
  const emptyMedia = () => ({ id: `media-${crypto.randomUUID()}`, originalUrl: '', bigUrl: '', href: '', alt: '', caption: '' });
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
    const linkViews = new Map();
    if (['links', 'sections'].includes(entity.type)) linkViews.set(`${entity.type}:${entity.view}`, { items: structuredClone(entity.items || []), meta: structuredClone(entity.meta || {}) });
    const renderContent = () => {
      clearMediaPreviewObservers(); window.ArmEditors.destroy('builder-content'); clear(content);
      const rich = entity.type === 'rich-content', banner = entity.type === 'big-media', service = entity.type === 'service', contentBlock = entity.type === 'content', embed = entity.type === 'embed';
      if (banner && !entity.media.length) entity.media.push(emptyMedia());
      if (service || contentBlock) while (entity.media.length < 2) entity.media.push(emptyMedia());
      const advanced = banner || service || contentBlock ? node('details', 'builder-banner-advanced') : null;
      if (advanced) advanced.append(node('summary', '', 'Дополнительные настройки'));
      if (embed) { embedFields(entity, content); return; }
      if (banner) mediaFields(entity, content, 'Изображение', { banner: true, advanced });
      let textField;
      if (!rich) {
        const text = bind(textarea('builder-content', entity.text, 6), entity, 'text'); text.maxLength = 12000;
        textField = node('fieldset', 'builder-text-fields');
        textField.append(node('legend', 'form-label', 'Текст'), window.BuilderMarkdown.editor(text));
        text.setAttribute('aria-label', 'Текст в Markdown');
      } else {
        const host = node('div'); host.id = 'builder-content'; host.className = 'builder-html-source';
        textField = field('HTML', host);
        content.append(textField);
        window.ArmEditors.editHtml('builder-content', entity.text || '', { label: 'HTML', hostClass: 'builder-html-source-editor', focus: false, onChange: value => { entity.text = value; resetReview(); } });
      }
      if (!rich) content.append(textField);
      if (entity.type === 'links') { linkFields(entity, content); return; }
      if (entity.type === 'sections') { sectionsFields(entity, content); return; }
      if (entity.type === 'grid') { gridFields(entity, content); return; }
      if (entity.type === 'table') { tableFields(entity, content); return; }
      if (entity.type === 'data-table') { dataTableFields(entity, content); return; }
      if (service || contentBlock) {
        const label = ['media-left', 'media-right'].includes(entity.view) ? `Изображения ${entity.view === 'media-left' ? 'слева' : 'справа'}` : 'Изображения';
        mediaFields(entity, content, label, { fixedCount: 2 });
      }
      let linkGroup;
      if (definition().fields.some(spec => spec.name === 'link')) { linkGroup = node('fieldset', 'builder-link-fields'); linkGroup.append(node('legend', 'form-label', 'Ссылка')); if (!service && !contentBlock) content.append(linkGroup); }
      definition().fields.filter(spec => !(entity.type === 'embed' && entity.view === 'map' && spec.name === 'ratio')).forEach(spec => {
        let control;
        if (spec.kind === 'select') { control = node('select', 'form-select'); control.id = `builder-${spec.name}`; control.append(new Option('Не задано', '')); spec.values.forEach(value => control.append(new Option(spec.name === 'provider' ? PROVIDER[value] : value, value, false, value === entity[spec.name]))); }
        else { control = input(`builder-${spec.name}`, entity[spec.name]); if (spec.kind === 'boolean') { control.type = 'checkbox'; control.className = 'form-check-input'; control.checked = Boolean(entity[spec.name]); } if (spec.kind === 'url') control.type = 'url'; }
        if (spec.name === 'link') { control.placeholder = 'URL'; control.setAttribute('aria-label', 'URL'); }
        if (spec.name === 'link_text') { control.placeholder = 'Текст ссылки'; control.setAttribute('aria-label', 'Текст ссылки'); }
        if (spec.name === 'reason') { control.placeholder = 'Почему нужен HTML-фрагмент'; control.required = rich; }
        const target = ['link', 'link_text'].includes(spec.name) ? linkGroup : content;
        if (target === linkGroup) { const wrapper = node('div', 'mb-3'); wrapper.append(bind(control, entity, spec.name)); target.append(wrapper); }
        else target.append(field(entity.type === 'embed' && entity.view === 'map' && spec.name === 'source_url' ? 'URL карты' : spec.name === 'reason' ? 'Обоснование' : spec.label, bind(control, entity, spec.name)));
      });
      if (service || contentBlock) content.append(linkGroup);
      if (advanced) { if (banner) bannerSettings(entity, advanced); else if (service) serviceSettings(entity, advanced); else contentSettings(entity, advanced); content.append(advanced); }
    };
    view.addEventListener('change', () => {
      if (entity.type === 'links') {
        linkViews.set(`links:${entity.view}`, { items: structuredClone(entity.items || []), meta: structuredClone(entity.meta || {}) });
        const restored = linkViews.get(`links:${view.value}`);
        entity.items = structuredClone(restored?.items || []);
        entity.meta = structuredClone(restored?.meta || { columns: view.value === 'documents' ? 1 : 2, compact: false });
      }
      entity.view = view.value; renderContent(); resetReview();
    });
    type.addEventListener('change', () => {
      if (entity.type === type.value) return;
      if (entity.type === 'links') linkViews.set(`links:${entity.view}`, { items: structuredClone(entity.items || []), meta: structuredClone(entity.meta || {}) });
      typeDrafts.set(entity.type, { ...(entity.sourceFrame ? { sourceFrame: structuredClone(entity.sourceFrame) } : {}), ...Object.fromEntries(definition().fields.filter(spec => Object.hasOwn(entity, spec.name)).map(spec => [spec.name, entity[spec.name]])), ...(['big-media', 'table', 'data-table', 'service', 'content', 'embed', 'links', 'sections', 'grid'].includes(entity.type) && entity.meta ? { meta: structuredClone(entity.meta) } : {}), ...(['links', 'sections', 'grid'].includes(entity.type) ? { items: structuredClone(entity.items || []), view: entity.view } : {}), ...(['table', 'data-table'].includes(entity.type) ? { rows: structuredClone(entity.rows || []) } : {}), ...(entity.type === 'data-table' ? { columns: structuredClone(entity.columns || []), view: entity.view } : {}), media: structuredClone(entity.media), previews: structuredClone(state.draft.previews) });
      const previousType = entity.type; entity.type = type.value; entity.view = definition().default_view;
      const allowed = new Set(definition().fields.map(item => item.name));
      state.blockTypes.flatMap(item => item.fields).forEach(spec => { if (!allowed.has(spec.name)) delete entity[spec.name]; });
      delete entity.meta; delete entity.sourceFrame; delete entity.items; delete entity.rows; delete entity.columns;
      const restored = typeDrafts.get(entity.type);
      // The site renders pooled media only through the fields of its wire
      // contract, so a type switch never carries media the target type cannot
      // display: links/sections/embed drop the pool, content/service keep the
      // two renderable slots, and grid adopts leftovers as items in gridFields.
      entity.media = restored ? structuredClone(restored.media) : ['table', 'data-table'].includes(previousType) || ['sections', 'table', 'data-table', 'links', 'embed'].includes(entity.type) ? [] : entity.type === 'big-media' ? entity.media.slice(0, 1) : ['content', 'service'].includes(entity.type) ? entity.media.slice(0, 2) : entity.media;
      if (restored) { const { media, previews, ...fields } = restored; state.draft.previews = structuredClone(previews); Object.assign(entity, fields); }
      if (entity.type === 'links' && !restored) { entity.items = []; entity.meta = { columns: 2, compact: false }; }
      if (entity.type === 'sections' && !restored) { entity.items = []; entity.meta = {}; }
      if (entity.type === 'grid' && !restored) { entity.items = []; entity.meta = {}; }
      if (entity.type === 'table' && !restored) { entity.rows = []; entity.meta = {}; }
      if (entity.type === 'data-table' && !restored) { entity.columns = []; entity.rows = []; entity.meta = {}; entity.caption = ''; }
      updateViews(); renderContent(); resetReview();
    }); renderContent();
  }
  function bannerSettings(entity, details) {
    const options = [
      ['ratio', 'Соотношение сторон', ['auto', '16x9', '4x3', '3x2', '1x1', 'poster'], 'auto'],
      ['fit', 'Заполнение изображения', ['cover', 'contain'], 'cover'],
      ['media_mode', 'Режим размера', ['intrinsic', 'fill'], entity.view === 'hero' ? 'fill' : 'intrinsic'],
      ['media_align', 'Выравнивание изображения', ['start', 'center', 'end'], 'start']
    ];
    for (const [key, label, values, fallback] of options) {
      const control = node('select', 'form-select'); control.id = `builder-meta-${key}`;
      for (const value of values) control.append(new Option(value, value, false, (entity.meta?.[key] ?? fallback) === value));
      control.addEventListener('change', () => { (entity.meta ||= {})[key] = control.value; resetReview(); });
      details.append(field(label, control));
    }
    const width = input('builder-meta-media_width', entity.meta?.media_width ?? ''); width.type = 'number'; width.min = '48'; width.max = '1600'; width.step = '1'; width.placeholder = 'Без ограничения';
    width.addEventListener('input', () => { if (width.value) (entity.meta ||= {}).media_width = Number(width.value); else if (entity.meta) delete entity.meta.media_width; resetReview(); });
    details.append(field('Максимальная ширина, px', width));
  }
  function serviceSettings(entity, details) {
    const options = [
      ['image_ratio', 'Соотношение сторон изображения', ['auto', '4x3', '3x2', '1x1'], 'auto'],
      ['image_fit', 'Заполнение изображения', ['cover', 'contain'], 'contain'],
      ['action_style', 'Вид действия', ['link', 'primary'], 'link'],
      ['media_mode', 'Режим размера', ['intrinsic', 'fill'], 'intrinsic'],
      ['media_align', 'Выравнивание изображения', ['start', 'center', 'end'], 'start']
    ];
    for (const [key, label, values, fallback] of options) {
      const control = node('select', 'form-select'); control.id = `builder-meta-${key}`;
      for (const value of values) control.append(new Option(value, value, false, (entity.meta?.[key] ?? fallback) === value));
      control.addEventListener('change', () => { (entity.meta ||= {})[key] = control.value; resetReview(); });
      details.append(field(label, control));
    }
    const width = input('builder-meta-media_width', entity.meta?.media_width ?? ''); width.type = 'number'; width.min = '48'; width.max = '1600'; width.step = '1'; width.placeholder = 'Без ограничения';
    width.addEventListener('input', () => { if (width.value) (entity.meta ||= {}).media_width = Number(width.value); else if (entity.meta) delete entity.meta.media_width; resetReview(); });
    details.append(field('Максимальная ширина, px', width));
  }
  function contentSettings(entity, details) {
    const options = [
      ['image_position', 'Положение изображения', ['left', 'right', 'after'], ''],
      ['image_layout', 'Расположение изображения', ['split', 'flow'], ''],
      ['image_ratio', 'Соотношение сторон изображения', ['auto', '4x3', '3x2', '1x1'], 'auto'],
      ['image_fit', 'Заполнение изображения', ['cover', 'contain'], 'cover'],
      ['media_mode', 'Режим размера', ['intrinsic', 'fill'], 'intrinsic'],
      ['media_align', 'Выравнивание изображения', ['start', 'center', 'end'], 'start']
    ];
    for (const [key, label, values, fallback] of options) {
      const control = node('select', 'form-select'); control.id = `builder-meta-${key}`;
      if (!fallback) control.append(new Option('Не задано', '', false, !entity.meta?.[key]));
      for (const value of values) control.append(new Option(value, value, false, (entity.meta?.[key] ?? fallback) === value));
      control.addEventListener('change', () => {
        if (control.value) (entity.meta ||= {})[key] = control.value;
        else if (entity.meta) delete entity.meta[key];
        resetReview();
      });
      details.append(field(label, control));
    }
    const width = input('builder-meta-media_width', entity.meta?.media_width ?? ''); width.type = 'number'; width.min = '48'; width.max = '1600'; width.step = '1'; width.placeholder = 'Без ограничения';
    width.addEventListener('input', () => { if (width.value) (entity.meta ||= {}).media_width = Number(width.value); else if (entity.meta) delete entity.meta.media_width; resetReview(); });
    details.append(field('Максимальная ширина, px', width));
  }
  function embedFields(entity, container) {
    const draft = state.draft;
    const section = node('section', 'builder-embed-section');
    section.append(node('h4', '', 'Встраивание'));
    const card = node('div', 'builder-embed-card'), slot = node('div', 'builder-image-preview-slot builder-embed-preview-slot');
    const preview = action('', () => openFrameCatalog(draft, entity, preview, updatePreview), 'builder-embed-preview builder-image-preview-button');
    preview.id = 'builder-frame-picker'; preview.setAttribute('aria-label', 'Выбрать фрейм шага 2');
    const updatePreview = () => {
      const overlay = node('span', 'builder-image-preview-hint'); overlay.setAttribute('aria-hidden', 'true');
      overlay.append(node('span', 'builder-image-preview-hint-text', 'Выбрать фрейм'));
      preview.replaceChildren(framePreview(entity, draft.frames), overlay);
      slot.querySelector('.builder-clear-media')?.remove();
      if (entity.source_url || entity.sourceFrame) {
        const clearFrame = action('×', () => {
          if (state.picking || state.saving || state.draft !== draft) return;
          delete entity.source_url; delete entity.sourceFrame; delete draft.frames[entity.id];
          resetReview(); updatePreview(); preview.focus({ preventScroll: true });
        }, 'builder-clear-media');
        clearFrame.id = 'builder-frame-clear'; clearFrame.title = 'Сбросить фрейм'; clearFrame.setAttribute('aria-label', clearFrame.title);
        slot.append(clearFrame);
      }
    };
    const inputs = node('div', 'builder-embed-inputs');
    const link = input('builder-link', entity.link); link.placeholder = 'URL для открытия'; link.setAttribute('aria-label', 'Ссылка');
    const provider = node('select', 'form-select'); provider.id = 'builder-provider'; provider.setAttribute('aria-label', 'Тип источника');
    provider.append(new Option('Не задано', ''));
    for (const value of ['iframe', 'map', 'video', 'unknown']) provider.append(new Option(PROVIDER[value], value, false, value === entity.provider));
    inputs.append(bind(link, entity, 'link'), bind(provider, entity, 'provider'));
    slot.append(preview); card.append(slot, inputs); section.append(card); container.append(section);
    updatePreview();
    const text = bind(textarea('builder-content', entity.text, 6), entity, 'text'); text.maxLength = 12000;
    text.setAttribute('aria-label', 'Текст в Markdown');
    const textField = node('fieldset', 'builder-text-fields');
    textField.append(node('legend', 'form-label', 'Текст'), window.BuilderMarkdown.editor(text)); container.append(textField);
    const advanced = node('details', 'builder-banner-advanced'); advanced.append(node('summary', '', 'Дополнительные настройки'));
    if (entity.view === 'map') {
      const height = input('builder-meta-map_height', entity.meta?.map_height ?? 420);
      height.type = 'number'; height.min = '280'; height.max = '720'; height.step = '1';
      height.addEventListener('input', () => { if (height.value) (entity.meta ||= {}).map_height = Number(height.value); else if (entity.meta) delete entity.meta.map_height; resetReview(); });
      advanced.append(field('Высота карты, px', height));
    } else {
      const ratio = node('select', 'form-select'); ratio.id = 'builder-ratio';
      for (const value of ['16:9', '4:3', '3:2', '1:1', '21:9']) ratio.append(new Option(value, value, false, (entity.ratio || '16:9') === value));
      advanced.append(field('Соотношение сторон', bind(ratio, entity, 'ratio')));
    }
    container.append(advanced);
  }
  async function openFrameCatalog(draft, entity, trigger, updatePreview) {
    if (state.picking || state.saving || state.assembling || state.draft !== draft) return;
    await drainAutosave(draft); if (state.picking || state.saving || state.draft !== draft) return;
    const controller = new AbortController(); state.picking = controller; save.disabled = true;
    const clearFrame = fields.querySelector('#builder-frame-clear'); if (clearFrame) clearFrame.disabled = true;
    const layer = node('div', 'builder-catalog-layer builder-frame-catalog'); layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-modal', 'true'); layer.setAttribute('aria-labelledby', 'builder-frame-catalog-title');
    const panel = node('div', 'builder-catalog-panel'), header = node('div', 'builder-catalog-header'), title = node('h4', '', 'Выбрать фрейм'), closeButton = node('button', 'btn-close');
    title.id = 'builder-frame-catalog-title'; closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Закрыть');
    const message = node('div', 'builder-catalog-message', 'Загрузка фреймов шага 2…'); message.setAttribute('role', 'status');
    const grid = node('div', 'builder-catalog-grid'); header.append(title, closeButton); panel.append(header, message, grid); layer.append(panel); modalElement.append(layer);
    const close = (restoreFocus = true) => {
      controller.abort(); layer.remove();
      if (state.picking === controller) state.picking = null;
      if (state.draft === draft) { save.disabled = Boolean(state.assembling); if (clearFrame?.isConnected) clearFrame.disabled = false; }
      if (state.draft === draft && draft.autosave.savedGeneration < draft.autosave.generation) void drainAutosave(draft);
      if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
    closeButton.addEventListener('click', () => close());
    layer.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...layer.querySelectorAll('button:not(:disabled)')], first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    closeButton.focus();
    if (!draft.mediaContext.htmlRevision) { message.textContent = 'Пока ещё нет HTML шага 2.'; return; }
    const context = { revision: draft.revision, ...draft.mediaContext };
    try {
      const catalog = await state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}/frame-catalog?${new URLSearchParams(context)}`, { signal: controller.signal });
      if (controller.signal.aborted || state.draft !== draft) return;
      message.textContent = '';
      const add = node('button', 'builder-catalog-add builder-catalog-add-frame', '+'); add.type = 'button'; add.title = 'Добавить фрейм'; add.setAttribute('aria-label', add.title);
      add.addEventListener('click', () => {
        const codeLayer = node('div', 'builder-catalog-layer builder-frame-code-layer'); codeLayer.setAttribute('role', 'dialog'); codeLayer.setAttribute('aria-modal', 'true'); codeLayer.setAttribute('aria-labelledby', 'builder-frame-code-title');
        const codePanel = node('form', 'builder-catalog-panel builder-frame-code-panel'), codeHeader = node('div', 'builder-catalog-header'), codeTitle = node('h4', '', 'Добавить фрейм'), cancel = node('button', 'btn-close');
        codeTitle.id = 'builder-frame-code-title'; cancel.type = 'button'; cancel.setAttribute('aria-label', 'Закрыть'); codeHeader.append(codeTitle, cancel);
        const editorId = 'builder-frame-code-editor', codeHost = node('div'); codeHost.id = editorId;
        const codeError = node('div', 'builder-catalog-message'); codeError.setAttribute('role', 'alert');
        const submit = node('button', 'btn btn-primary', 'Добавить'); submit.type = 'submit';
        const dismiss = () => { window.ArmEditors.destroy(editorId); codeLayer.remove(); add.focus({ preventScroll: true }); };
        cancel.addEventListener('click', dismiss);
        codeLayer.addEventListener('keydown', event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
          if (event.key !== 'Tab') return;
          const controls = [...codeLayer.querySelectorAll('button:not(:disabled), .cm-content[contenteditable="true"]')], first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        });
        codePanel.addEventListener('submit', async event => {
          event.preventDefault(); submit.disabled = true; codeError.textContent = '';
          try {
            await state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}/add-frame`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ ...context, code: window.ArmEditors.text(editorId) }) });
            if (!controller.signal.aborted && state.draft === draft) { window.ArmEditors.destroy(editorId); codeLayer.remove(); close(false); openFrameCatalog(draft, entity, trigger, updatePreview); }
          } catch (error) { if (!controller.signal.aborted) { codeError.textContent = error.message; submit.disabled = false; } }
        });
        codePanel.append(codeHeader, codeHost, codeError, submit); codeLayer.append(codePanel); modalElement.append(codeLayer); window.ArmEditors.editHtml(editorId);
      });
      grid.append(add);
      for (const [index, frame] of catalog.frames.entries()) {
        const tile = node('button', 'btn builder-catalog-tile builder-frame-tile'); tile.type = 'button'; tile.disabled = !frame.selectable;
        tile.dataset.resourceId = frame.resourceId; tile.setAttribute('aria-label', `Выбрать фрейм ${index + 1}`);
        const viewport = node('span', 'media-frame-viewport'); viewport.append(window.ArmEmbedPolicy.createFrame(frame, { preview: true }));
        tile.append(viewport);
        tile.addEventListener('click', async () => {
          if (controller.signal.aborted || state.draft !== draft) return;
          grid.querySelectorAll('button').forEach(button => { button.disabled = true; }); closeButton.focus({ preventScroll: true });
          try {
            const selected = await state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}/choose-frame`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ ...context, resourceId: frame.resourceId }) });
            if (controller.signal.aborted || state.draft !== draft) return;
            entity.source_url = selected.source_url; entity.sourceFrame = selected.sourceFrame; draft.frames[entity.id] = selected.frame;
            close(false); resetReview(); updatePreview(); trigger.focus({ preventScroll: true });
          } catch (error) {
            if (!controller.signal.aborted) {
              message.textContent = error.message; message.setAttribute('role', 'alert'); add.disabled = false;
              grid.querySelectorAll('.builder-frame-tile').forEach(button => { button.disabled = !catalog.frames.find(item => item.resourceId === Number(button.dataset.resourceId))?.selectable; });
            }
          }
        });
        grid.append(tile);
      }
    } catch (error) { if (!controller.signal.aborted) { message.textContent = error.message; message.setAttribute('role', 'alert'); } }
  }
  async function openMediaCatalog(draft, entity, asset, kind, key, trigger, renderMedia) {
    if (state.picking || state.saving || state.assembling || state.draft !== draft) return;
    await drainAutosave(draft); if (state.picking || state.saving || state.draft !== draft) return;
    const controller = new AbortController(); state.picking = controller; save.disabled = true;
    const layer = node('div', 'builder-catalog-layer'); layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-modal', 'true'); layer.setAttribute('aria-labelledby', 'builder-catalog-title');
    const panel = node('div', 'builder-catalog-panel'), header = node('div', 'builder-catalog-header'), title = node('h4', '', `Выбор ${kind === 'original' ? 'основной' : 'большой'} картинки`), closeButton = node('button', 'btn-close');
    title.id = 'builder-catalog-title'; closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Закрыть'); closeButton.addEventListener('click', () => close());
    const message = node('div', 'builder-catalog-message'); message.setAttribute('role', 'status'); message.textContent = 'Загрузка изображений шага 2…';
    const grid = node('div', 'builder-catalog-grid'); header.append(title, closeButton); panel.append(header, message, grid); layer.append(panel); modalElement.append(layer);
    const close = (restoreFocus = true) => {
      controller.abort(); layer.remove();
      if (state.picking === controller) state.picking = null;
      if (state.draft === draft) save.disabled = Boolean(state.assembling);
      if (state.draft === draft && draft.autosave.savedGeneration < draft.autosave.generation) void drainAutosave(draft);
      if (restoreFocus) document.getElementById(trigger.id)?.focus({ preventScroll: true });
    };
    layer.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...layer.querySelectorAll('button:not(:disabled)')];
      if (!controls.length) return;
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    closeButton.focus();
    const context = { revision: draft.revision, ...draft.mediaContext };
    try {
      const query = new URLSearchParams(context).toString();
      const catalog = await state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}/media-catalog?${query}`, { signal: controller.signal });
      if (controller.signal.aborted || state.draft !== draft) return;
      message.textContent = '';
      catalogAddFile(grid, layer, 'image', draft, context, message, () => { close(false); openMediaCatalog(draft, entity, asset, kind, key, trigger, renderMedia); }, controller);
      for (const [index, image] of catalog.images.entries()) {
        const card = node('div', 'card image-card builder-catalog-card'), tile = node('button', 'btn w-100 builder-catalog-tile');
        tile.addEventListener('click', async () => {
          if (controller.signal.aborted || state.draft !== draft) return;
          grid.querySelectorAll('button').forEach(button => { button.disabled = true; });
          closeButton.focus({ preventScroll: true });
          try {
            const selected = await state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}/choose-media`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ ...context, name: image.name, resourceId: image.resourceId }) });
            if (controller.signal.aborted || state.draft !== draft || !entity.media.includes(asset)) return;
            asset[key] = selected.url; asset[`${kind}Media`] = selected.media; draft.previews[`${asset.id}-${kind}`] = selected.preview;
            close(false); resetReview(); renderMedia(); document.getElementById(trigger.id)?.focus({ preventScroll: true });
          } catch (error) {
            if (!controller.signal.aborted) { message.textContent = error.message; message.setAttribute('role', 'alert'); grid.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
          }
        });
        tile.type = 'button'; tile.setAttribute('aria-label', `Выбрать изображение ${index + 1}`);
        const thumbnail = node('img'); thumbnail.src = image.preview; thumbnail.alt = '';
        tile.append(thumbnail); card.append(tile); grid.append(card);
      }
    } catch (error) {
      if (!controller.signal.aborted) { message.textContent = error.message; message.setAttribute('role', 'alert'); }
    }
  }
  function documentSize(bytes) {
    return Number.isFinite(bytes) && bytes >= 0 ? bytes > 0 && bytes < 5000 ? '< 0,01 МБ' : `${(bytes / 1000000).toFixed(2).replace('.', ',')} МБ` : '';
  }
  function catalogAddFile(grid, layer, kind, draft, context, message, reopen, controller) {
    const picker = node('input'); picker.type = 'file'; picker.hidden = true;
    picker.accept = kind === 'image' ? '.png,.jpg,.jpeg,.gif,.webp,.avif,.bmp,image/*' : '.pdf,.txt,.csv,.rtf,.doc,.xls,.ppt,.docx,.xlsx,.pptx,.odt,.ods,.zip,.gz,.rar,.7z,.tar,.mp3,.wav,.ogg,.mp4,.m4a,.webm,.mov,.svg,.tif,.tiff,.ico';
    const add = node('button', `builder-catalog-add builder-catalog-add-${kind}`, '+'); add.type = 'button';
    add.setAttribute('aria-label', kind === 'image' ? 'Добавить изображение из проводника' : 'Добавить документ из проводника'); add.title = add.getAttribute('aria-label');
    add.addEventListener('click', () => picker.click());
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0]; if (!file || controller.signal.aborted) return;
      add.disabled = true; message.textContent = `Добавление файла «${file.name}»…`;
      try {
        await state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}/add-${kind}`, { method: 'POST', signal: controller.signal, timeoutMs: 60000, body: file,
          headers: { 'Content-Type': 'application/octet-stream', 'x-attempt': String(context.attempt), 'x-builder-revision': String(context.revision), 'x-html-revision': String(context.htmlRevision), 'x-file-name': encodeURIComponent(file.name) } });
        if (!controller.signal.aborted && state.draft === draft) reopen();
      } catch (error) { if (!controller.signal.aborted) { message.textContent = error.message; message.setAttribute('role', 'alert'); add.disabled = false; picker.value = ''; } }
    });
    layer.append(picker); grid.prepend(add); return add;
  }
  function documentAppearance(item) {
    const type = String(item.meta?.file_type || '').toLowerCase();
    let extension = '';
    try { extension = new URL(item.link || '', location.origin).pathname.match(/\.([a-z\d]{1,10})$/i)?.[1].toLowerCase() || ''; } catch { /* Unknown links use the generic icon. */ }
    const fileType = type || extension;
    const category = /^(zip|rar|7z|tar|gz)$/.test(fileType) ? 'archive'
      : /^(mp3|wav|ogg|m4a|flac)$/.test(fileType) ? 'audio'
        : /^(mp4|webm|mov|avi)$/.test(fileType) ? 'video'
          : /^(svg|tif|tiff|ico)$/.test(fileType) ? 'graphic'
            : 'document';
    const paths = {
      document: ['M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M14 3v6h5', 'M9 13h6', 'M9 17h6'],
      archive: ['M5 3h14v18H5z', 'M10 3v3', 'M14 6v3', 'M10 9v3', 'M14 12v3', 'M10 15v4h4v-4z'],
      audio: ['M9 18V6l11-2v12', 'M9 18a3 2 0 1 1-6 0a3 2 0 0 1 6 0Z', 'M20 16a3 2 0 1 1-6 0a3 2 0 0 1 6 0Z'],
      video: ['M4 5h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'm19 9 3-2v10l-3-2', 'm8 9 5 3-5 3z'],
      graphic: ['M4 4h16v16H4z', 'M8 9a1 1 0 1 0 2 0a1 1 0 0 0-2 0Z', 'm5 17 4-5 5 5']
    };
    return { category, icon: lineIcon(paths[category]) };
  }
  async function openDocumentCatalog(draft, entity, item, trigger, renderItems) {
    if (state.picking || state.saving || state.assembling || state.draft !== draft) return;
    await drainAutosave(draft); if (state.picking || state.saving || state.draft !== draft) return;
    const controller = new AbortController(); state.picking = controller; save.disabled = true;
    const layer = node('div', 'builder-catalog-layer builder-document-catalog'); layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-modal', 'true'); layer.setAttribute('aria-labelledby', 'builder-document-catalog-title');
    const panel = node('div', 'builder-catalog-panel'), header = node('div', 'builder-catalog-header'), title = node('h4', '', 'Выбрать документ'), closeButton = node('button', 'btn-close');
    title.id = 'builder-document-catalog-title'; closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Закрыть');
    const message = node('div', 'builder-catalog-message', 'Загрузка документов шага 2…'); message.setAttribute('role', 'status');
    const grid = node('div', 'builder-catalog-grid builder-document-catalog-grid'); header.append(title, closeButton); panel.append(header, message, grid); layer.append(panel); modalElement.append(layer);
    const close = (restoreFocus = true) => {
      controller.abort(); layer.remove();
      if (state.picking === controller) state.picking = null;
      if (state.draft === draft) save.disabled = Boolean(state.assembling);
      if (state.draft === draft && draft.autosave.savedGeneration < draft.autosave.generation) void drainAutosave(draft);
      if (restoreFocus) document.getElementById(trigger.id)?.focus({ preventScroll: true });
    };
    closeButton.addEventListener('click', () => close());
    layer.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...layer.querySelectorAll('button:not(:disabled)')], first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    closeButton.focus();
    if (!draft.mediaContext.htmlRevision) { message.textContent = 'Пока ещё нет HTML шага 2.'; return; }
    const context = { revision: draft.revision, ...draft.mediaContext };
    try {
      const catalog = await state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}/document-catalog?${new URLSearchParams(context)}`, { signal: controller.signal });
      if (controller.signal.aborted || state.draft !== draft || !entity.items.includes(item)) return;
      message.textContent = '';
      catalogAddFile(grid, layer, 'document', draft, context, message, () => { close(false); openDocumentCatalog(draft, entity, item, trigger, renderItems); }, controller);
      for (const documentItem of catalog.documents) {
        const tile = node('button', 'card media-document-card builder-document-catalog-tile'); tile.type = 'button'; tile.setAttribute('aria-label', `Выбрать документ ${documentItem.name}`);
        const appearance = documentAppearance({ link_text: documentItem.name, meta: { file_type: documentItem.fileType } });
        const icon = node('span', `media-document-icon media-document-${appearance.category}`); icon.append(appearance.icon);
        const details = node('span', 'media-document-details'), name = node('span', 'media-document-name builder-document-catalog-name', documentItem.name);
        name.title = documentItem.name; details.append(name);
        const meta = [documentItem.fileType, documentSize(documentItem.bytes)].filter(Boolean).join(' · ');
        if (meta) details.append(node('small', 'media-document-meta', meta));
        tile.append(icon, details);
        tile.addEventListener('click', async () => {
          if (controller.signal.aborted || state.draft !== draft || !entity.items.includes(item)) return;
          grid.querySelectorAll('button').forEach(button => { button.disabled = true; }); closeButton.focus({ preventScroll: true });
          try {
            const selected = await state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}/choose-document`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ ...context, resourceId: documentItem.resourceId }) });
            if (controller.signal.aborted || state.draft !== draft || !entity.items.includes(item) || entity.type !== 'links' || entity.view !== 'documents') return;
            const oldAutoName = draft.documentAutoNames?.[item.id] || catalog.documents.find(candidate => candidate.resourceId === item.sourceDocument?.resourceId)?.name;
            if (!item.link_text || item.link_text === oldAutoName) item.link_text = selected.name;
            if (!item.title || item.title === oldAutoName) item.title = selected.name;
            item.link = selected.link; item.sourceDocument = selected.sourceDocument;
            item.meta ||= {}; item.meta.kind = 'document'; item.meta.file_type = selected.fileType || ''; item.meta.size = documentSize(selected.bytes);
            item.meta.download ??= true;
            (draft.documentAutoNames ||= {})[item.id] = selected.name;
            close(false); resetReview(); renderItems(); document.getElementById(trigger.id)?.focus({ preventScroll: true });
          } catch (error) {
            if (!controller.signal.aborted) { message.textContent = error.message; message.setAttribute('role', 'alert'); grid.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
          }
        });
        grid.append(tile);
      }
    } catch (error) { if (!controller.signal.aborted) { message.textContent = error.message; message.setAttribute('role', 'alert'); } }
  }
  function linkFields(entity, container) {
    entity.items ||= []; entity.meta ||= {};
    entity.meta.columns ??= entity.view === 'documents' ? 1 : 2; entity.meta.compact ??= false;
    const draft = state.draft, section = node('section', 'builder-images-section builder-links-section'), heading = node('h4', '', entity.view === 'documents' ? 'Документы' : 'Ссылки');
    const list = node('div', 'builder-link-items');
    const add = action('', () => {
      if (state.saving || entity.items.length >= 100) return;
      const item = { id: `item-${crypto.randomUUID()}`, title: '', text: '', link: '', link_text: '', meta: entity.view === 'documents' ? { kind: 'document', download: true } : { kind: 'link' } };
      entity.items.push(item); resetReview(); renderItems(); list.querySelector(entity.view === 'documents' ? `[data-item-id="${item.id}"] .builder-item-summary` : `[data-item-id="${item.id}"] input`)?.focus();
    }, 'builder-add builder-image-add builder-link-add');
    add.id = 'builder-add-link-item'; add.setAttribute('aria-label', entity.view === 'documents' ? 'Добавить документ' : 'Добавить ссылку'); add.title = add.getAttribute('aria-label');
    const plus = node('span', 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true'); add.append(plus);
    section.append(heading, list, add); container.append(section);
    let dragged = null; const openItems = new Set();
    const move = (id, beforeId) => {
      if (state.saving || id === beforeId) return;
      const index = entity.items.findIndex(item => item.id === id); if (index < 0) return;
      const item = entity.items.splice(index, 1)[0], destination = beforeId ? entity.items.findIndex(candidate => candidate.id === beforeId) : entity.items.length;
      entity.items.splice(destination, 0, item); resetReview(); renderItems(); list.querySelector(`[data-item-id="${id}"] .builder-link-drag`)?.focus();
    };
    const renderItems = () => {
      clear(list); add.disabled = entity.items.length >= 100;
      entity.items.forEach((item, index) => {
        const row = node('div', 'builder-link-row'); row.dataset.itemId = item.id; if (entity.view === 'documents') row.classList.add('builder-collapsible-item');
        const body = node('div', entity.view === 'links' ? 'builder-link-body builder-simple-links' : 'builder-link-body'), controls = node('div', 'builder-image-tools');
        const handle = action('⠿', () => { live.textContent = 'Используйте стрелки вверх и вниз или перетащите элемент.'; }, 'builder-media-drag builder-link-drag');
        handle.draggable = true; handle.setAttribute('aria-label', `Перетащить ${entity.view === 'documents' ? 'документ' : 'ссылку'} ${index + 1}`);
        handle.addEventListener('dragstart', event => { if (state.saving) { event.preventDefault(); return; } dragged = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); });
        handle.addEventListener('dragend', () => { dragged = null; list.querySelectorAll('.builder-drop-before,.builder-drop-after').forEach(item => item.classList.remove('builder-drop-before', 'builder-drop-after')); });
        handle.addEventListener('keydown', event => {
          if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'ArrowUp' && index > 0) move(item.id, entity.items[index - 1].id);
          if (event.key === 'ArrowDown' && index < entity.items.length - 1) move(item.id, entity.items[index + 2]?.id);
        });
        const remove = action('', () => { if (state.saving) return; entity.items.splice(index, 1); resetReview(); renderItems(); add.focus(); }, 'builder-delete text-danger');
        remove.setAttribute('aria-label', `Удалить ${entity.view === 'documents' ? 'документ' : 'ссылку'} ${index + 1}`); remove.append(trashIcon());
        if (entity.view === 'documents') controls.append(remove, handle); else controls.append(handle, remove);
        let itemShell;
        if (entity.view === 'links') {
          for (const [key, label] of [['link', 'URL'], ['link_text', 'Текст ссылки']]) {
            const control = bind(input(`builder-item-${item.id}-${key}`, item[key]), item, key); control.setAttribute('aria-label', label); control.placeholder = label;
            if (key === 'link') control.type = 'url'; body.append(control);
          }
        } else {
          itemShell = itemDetails(body, item, 'Документ', openItems);
          const previewSlot = node('div', 'builder-image-preview-slot builder-document-preview-slot');
          const preview = action('', () => openDocumentCatalog(draft, entity, item, preview, renderItems), 'builder-document-preview builder-image-preview-button');
          preview.id = `builder-item-${item.id}-choose`; preview.setAttribute('aria-label', `Выбрать документ ${index + 1}`);
          const documentName = draft.documentAutoNames?.[item.id] || item.link_text || item.title || '';
          preview.title = item.link ? documentName : 'Выбрать документ';
          const appearance = documentAppearance(item), icon = node('span', item.link ? `media-document-icon media-document-${appearance.category}` : 'builder-media-placeholder');
          icon.append(appearance.icon);
          if (item.link) { const name = node('span', 'builder-document-preview-name', documentName); name.title = documentName; icon.append(name); }
          preview.append(icon);
          const hint = node('span', 'builder-image-preview-hint'); hint.setAttribute('aria-hidden', 'true');
          const hintText = node('span', 'builder-image-preview-hint-text'); hintText.append(node('span', '', item.link ? 'Заменить' : 'Выбрать'), node('span', '', 'документ')); hint.append(hintText); preview.append(hint);
          previewSlot.append(preview);
          if (item.link) {
            const clearDocument = action('×', () => {
              if (state.picking || state.saving || state.draft !== draft) return;
              item.link = ''; delete item.sourceDocument; delete item.meta.file_type; delete item.meta.size; delete draft.documentAutoNames?.[item.id];
              resetReview(); renderItems(); document.getElementById(preview.id)?.focus({ preventScroll: true });
            }, 'builder-clear-media');
            clearDocument.setAttribute('aria-label', `Очистить документ ${index + 1}`); clearDocument.title = 'Очистить документ'; previewSlot.append(clearDocument);
          }
          body.append(previewSlot);
          const documentFields = node('div', 'builder-document-fields');
          for (const [key, label] of [['title', 'Заголовок'], ['link_text', 'Текст ссылки']]) {
            const control = key === 'text' ? textarea(`builder-item-${item.id}-${key}`, item[key], 1) : input(`builder-item-${item.id}-${key}`, item[key]);
            control.placeholder = label; control.setAttribute('aria-label', label); documentFields.append(bind(control, item, key));
            if (key === 'title') control.addEventListener('input', itemShell.update);
          }
          body.append(documentFields);
          body.append(itemMarkdownField(item, `builder-item-${item.id}-text`));
          const settings = node('div', 'builder-document-settings');
          const target = node('select', 'form-select'); target.id = `builder-item-${item.id}-target`;
          const selectedTarget = item.meta?.target || 'self';
          for (const [value, label] of [['self', 'В этом окне'], ['blank', 'В новом окне']]) target.append(new Option(label, value, false, selectedTarget.replace(/^_/, '') === value));
          target.addEventListener('change', () => { item.meta ||= {}; item.meta.target = target.value; resetReview(); }); settings.append(field('Открывать', target));
          const download = node('input', 'form-check-input'); download.type = 'checkbox'; download.id = `builder-item-${item.id}-download`; download.checked = item.meta?.download ?? true;
          download.addEventListener('change', () => { item.meta ||= {}; item.meta.download = download.checked; resetReview(); }); settings.append(field('Скачивать', download));
          body.append(settings);
        }
        row.append(entity.view === 'documents' ? itemShell.details : body, controls);
        const before = event => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
        row.addEventListener('dragover', event => { if (!dragged || state.saving) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; row.classList.toggle('builder-drop-before', before(event)); row.classList.toggle('builder-drop-after', !before(event)); });
        row.addEventListener('dragleave', () => row.classList.remove('builder-drop-before', 'builder-drop-after'));
        row.addEventListener('drop', event => { if (!dragged || state.saving) return; event.preventDefault(); const id = dragged; dragged = null; move(id, before(event) ? item.id : entity.items[index + 1]?.id); });
        list.append(row);
      });
    };
    renderItems();
    if (entity.view === 'documents' && entity.items.some(item => item.sourceDocument) && draft.mediaContext.htmlRevision) {
      const context = { revision: draft.revision, ...draft.mediaContext };
      state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}/document-catalog?${new URLSearchParams(context)}`)
        .then(catalog => {
          if (state.draft !== draft) return;
          for (const item of entity.items) {
            const name = catalog.documents.find(candidate => candidate.resourceId === item.sourceDocument?.resourceId)?.name;
            if (name && draft.documentAutoNames?.[item.id] !== name) {
              (draft.documentAutoNames ||= {})[item.id] = name;
              const preview = document.getElementById(`builder-item-${item.id}-choose`), caption = preview?.querySelector('.builder-document-preview-name');
              if (caption) { caption.textContent = name; caption.title = name; preview.title = name; }
            }
          }
        }).catch(() => {});
    }
    const advanced = node('details', 'builder-banner-advanced builder-links-advanced'); advanced.append(node('summary', '', 'Дополнительные настройки'));
    const columns = node('select', 'form-select'); columns.id = 'builder-links-columns';
    for (const number of [1, 2, 3]) columns.append(new Option(String(number), String(number), false, entity.meta.columns === number));
    columns.addEventListener('change', () => { entity.meta.columns = Number(columns.value); resetReview(); }); advanced.append(field('Колонки', columns));
    const compact = node('input', 'form-check-input'); compact.type = 'checkbox'; compact.id = 'builder-links-compact'; compact.checked = entity.meta.compact;
    compact.addEventListener('change', () => { entity.meta.compact = compact.checked; resetReview(); }); advanced.append(field('Компактный вид', compact));
    container.append(advanced);
  }
  function sectionsFields(entity, container) {
    entity.items ||= []; entity.meta ||= {};
    const section = node('section', 'builder-images-section builder-sections-section'), heading = node('h4', '', 'Элементы');
    const list = node('div', 'builder-section-items'), add = action('', () => addItem(entity.items, 1), 'builder-add builder-image-add');
    add.id = 'builder-add-section-item'; add.setAttribute('aria-label', 'Добавить элемент'); add.title = 'Добавить элемент';
    const plus = node('span', 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true'); add.append(plus);
    section.append(heading, list, add); container.append(section);
    const countItems = items => items.reduce((count, item) => count + 1 + countItems(item.children || []), 0);
    const addItem = (siblings, depth) => {
      if (state.saving || countItems(entity.items) >= 100 || depth > 6) return;
      const item = { id: `item-${crypto.randomUUID()}`, title: '', text: '', link: '', link_text: '', meta: { kind: depth === 1 ? 'section' : 'item' }, children: [] };
      siblings.push(item); resetReview(); renderItems(); list.querySelector(`[data-item-id="${CSS.escape(item.id)}"] > .builder-item-details > .builder-item-summary`)?.focus();
    };
    let dragged = null; const openItems = new Set();
    const locateItem = (items, id, depth = 1) => {
      for (const [index, item] of items.entries()) {
        if (item.id === id) return { item, items, index, depth };
        const nested = locateItem(item.children || [], id, depth + 1);
        if (nested) return nested;
      }
      return null;
    };
    const containsItem = (item, id) => item.id === id || (item.children || []).some(child => containsItem(child, id));
    const branchDepth = item => 1 + Math.max(0, ...(item.children || []).map(branchDepth));
    const canMove = (id, destinationDepth, parentId, targetId) => {
      const source = locateItem(entity.items, id);
      return source && destinationDepth + branchDepth(source.item) <= 7
        && (!parentId || !containsItem(source.item, parentId))
        && (!targetId || !containsItem(source.item, targetId));
    };
    const moveItem = (id, destination, depth, parentId, targetId = null, after = false) => {
      if (state.saving || !canMove(id, depth, parentId, targetId)) return;
      const source = locateItem(entity.items, id), [item] = source.items.splice(source.index, 1);
      const target = targetId ? destination.findIndex(candidate => candidate.id === targetId) : destination.length;
      destination.splice(target + (targetId && after ? 1 : 0), 0, item);
      resetReview(); renderItems(); list.querySelector(`[data-item-id="${CSS.escape(id)}"] .builder-section-drag`)?.focus();
    };
    const endDrop = (element, items, depth, parentId, indicator = false) => {
      element.addEventListener('dragover', event => {
        if (!dragged || !canMove(dragged, depth, parentId, null)) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        element.classList.add(indicator ? 'builder-drop-after' : 'builder-drop-active');
      });
      element.addEventListener('dragleave', event => {
        if (!element.contains(event.relatedTarget)) element.classList.remove('builder-drop-after', 'builder-drop-active');
      });
      element.addEventListener('drop', event => {
        if (!dragged || !canMove(dragged, depth, parentId, null)) return;
        event.preventDefault(); event.stopPropagation(); const moved = dragged; dragged = null;
        moveItem(moved, items, depth, parentId);
      });
    };
    const renderItems = () => {
      clear(list); section.classList.remove('builder-sections-dragging'); add.disabled = countItems(entity.items) >= 100;
      const renderLevel = (items, host, depth, parentId = null) => {
        items.forEach((item, index) => {
          item.children ||= []; item.meta ||= {};
          const row = node('div', 'builder-link-row builder-section-item builder-collapsible-item'); row.dataset.itemId = item.id;
          const body = node('div', 'builder-link-body builder-section-item-body'), controls = node('div', 'builder-image-tools');
          const itemShell = itemDetails(body, item, 'Элемент', openItems);
          const move = direction => {
            const target = items[index + direction];
            if (target) moveItem(item.id, items, depth, parentId, target.id, direction > 0);
          };
          const handle = action('⠿', () => { live.textContent = 'Используйте стрелки вверх и вниз или перетащите элемент.'; }, 'builder-media-drag builder-section-drag');
          handle.draggable = true; handle.setAttribute('aria-label', `Перетащить элемент ${index + 1}`);
          handle.addEventListener('keydown', event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); move(event.key === 'ArrowUp' ? -1 : 1); } });
          handle.addEventListener('dragstart', event => { if (state.saving) { event.preventDefault(); return; } dragged = item.id; event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; section.classList.add('builder-sections-dragging'); });
          handle.addEventListener('dragend', () => { dragged = null; section.classList.remove('builder-sections-dragging'); section.querySelectorAll('.builder-drop-before,.builder-drop-after,.builder-drop-active').forEach(node => node.classList.remove('builder-drop-before', 'builder-drop-after', 'builder-drop-active')); });
          const before = event => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
          row.addEventListener('dragover', event => {
            if (!dragged || !canMove(dragged, depth, parentId, item.id)) return;
            event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
            row.classList.toggle('builder-drop-before', before(event)); row.classList.toggle('builder-drop-after', !before(event));
          });
          row.addEventListener('dragleave', () => row.classList.remove('builder-drop-before', 'builder-drop-after'));
          row.addEventListener('drop', event => {
            if (!dragged || !canMove(dragged, depth, parentId, item.id)) return;
            event.preventDefault(); event.stopPropagation(); const moved = dragged; dragged = null;
            moveItem(moved, items, depth, parentId, item.id, !before(event));
          });
          const remove = action('', () => { if (state.saving) return; items.splice(index, 1); resetReview(); renderItems(); add.focus(); }, 'builder-delete text-danger');
          remove.setAttribute('aria-label', `Удалить элемент ${index + 1}`); remove.append(trashIcon()); controls.append(remove, handle);
          const title = input(`builder-item-${item.id}-title`, item.title); title.placeholder = 'Заголовок'; title.setAttribute('aria-label', 'Заголовок'); title.maxLength = 500; title.classList.add('builder-section-title');
          bind(title, item, 'title'); title.addEventListener('input', itemShell.update);
          body.append(title, itemMarkdownField(item, `builder-item-${item.id}-text`, 'builder-section-text'));
          const linkGroup = node('div', 'builder-section-link');
          for (const [key, label] of [['link', 'URL'], ['link_text', 'Текст ссылки']]) {
            const control = input(`builder-item-${item.id}-${key}`, item[key]); control.placeholder = label; control.setAttribute('aria-label', label);
            control.maxLength = key === 'link' ? 4096 : 500; if (key === 'link') control.type = 'url'; linkGroup.append(field(key === 'link' ? 'Ссылка' : label, bind(control, item, key)));
          }
          body.append(linkGroup);
          const kind = node('select', 'form-select'); kind.id = `builder-item-${item.id}-kind`;
          for (const [value, label] of [['section', 'Раздел'], ['item', 'Пункт'], ['address', 'Адрес'], ['phone', 'Телефон'], ['email', 'Почта'], ['hours', 'Режим работы']]) kind.append(new Option(label, value, false, (item.meta.kind || 'item') === value));
          kind.addEventListener('change', () => { item.meta.kind = kind.value; resetReview(); }); body.append(field('Тип элемента', kind));
          const target = node('select', 'form-select'); target.id = `builder-item-${item.id}-target`;
          for (const [value, label] of [['self', 'В этом окне'], ['blank', 'В новом окне']]) target.append(new Option(label, value, false, (item.meta.target || 'self').replace(/^_/, '') === value));
          target.addEventListener('change', () => { item.meta.target = target.value; resetReview(); }); body.append(field('Открывать ссылку', target));
          row.append(itemShell.details, controls); host.append(row);
          const children = node('div', 'builder-section-children'); host.append(children);
          if (depth < 6) renderLevel(item.children, children, depth + 1, item.id);
          if (depth < 6) {
            const addChild = action('', () => addItem(item.children, depth + 1), 'builder-add builder-image-add builder-section-add-child builder-section-drop');
            addChild.setAttribute('aria-label', 'Добавить вложенный пункт'); addChild.title = 'Добавить вложенный пункт';
            const plus = node('span', 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true'); addChild.append(plus);
            addChild.disabled = countItems(entity.items) >= 100; endDrop(addChild, item.children, depth + 1, item.id); children.append(addChild);
          }
        });
        const end = node('div', 'builder-section-drop-end'); end.setAttribute('aria-hidden', 'true'); host.append(end);
        endDrop(end, items, depth, parentId, true);
      };
      renderLevel(entity.items, list, 1);
    };
    add.classList.add('builder-section-drop'); endDrop(add, entity.items, 1, null);
    renderItems();
    const advanced = node('details', 'builder-banner-advanced builder-sections-advanced'); advanced.append(node('summary', '', 'Дополнительные настройки'));
    const columns = node('select', 'form-select'); columns.id = 'builder-sections-columns';
    for (const number of [1, 2, 3, 4]) columns.append(new Option(String(number), String(number), false, (entity.meta.columns ?? { list: 1, columns: 3, contacts: 2 }[entity.view]) === number));
    columns.addEventListener('change', () => { entity.meta.columns = Number(columns.value); resetReview(); }); advanced.append(field('Колонки', columns));
    for (const [key, label, fallback] of [['compact', 'Компактный вид', false], ['show_icons', 'Показывать иконки', entity.view === 'contacts']]) {
      const control = node('input', 'form-check-input'); control.id = `builder-sections-${key}`; control.type = 'checkbox'; control.checked = entity.meta[key] ?? fallback;
      control.addEventListener('change', () => { entity.meta[key] = control.checked; resetReview(); }); advanced.append(field(label, control));
    }
    container.append(advanced);
  }
  const tableCellImageIds = cell => cell.image_asset_ids || (cell.image_asset_id ? [cell.image_asset_id] : []);
  function setTableCellImageIds(cell, ids) {
    delete cell.image_asset_id; delete cell.image_asset_ids;
    if (ids.length === 1) cell.image_asset_id = ids[0];
    else if (ids.length > 1) cell.image_asset_ids = [...ids];
  }
  function tableReferencedMedia(entity) {
    return new Set((entity.rows || []).flatMap(row => row.cells || []).flatMap(tableCellImageIds));
  }
  function pruneTableMedia(entity, candidates) {
    const referenced = tableReferencedMedia(entity), removed = new Set(candidates);
    entity.media = entity.media.filter(asset => !removed.has(asset.id) || referenced.has(asset.id));
  }
  function dataTableFields(entity, container) {
    entity.columns ||= []; entity.rows ||= []; entity.meta ||= {}; entity.media = [];
    const caption = bind(input('builder-caption', entity.caption), entity, 'caption'); caption.maxLength = 1000;
    container.append(field('Подпись', caption));
    const editor = node('div', 'builder-data-table-editor'); container.append(editor);
    // These are local ARM resource limits (also enforced by the store).
    const limits = { columns: 100, rows: 100, cells: 1000 };
    const cellCount = () => entity.rows.reduce((sum, row) => sum + (row.cells?.length || 0), 0);
    const emptyCell = () => ({ id: `cell-${crypto.randomUUID()}`, value: '' });
    const rowDrafts = state.draft.dataTableRowDrafts ||= new Map();
    let dragged = null;
    const focus = selector => {
      const control = editor.querySelector(selector); if (!control) return;
      for (let parent = control.parentElement; parent && parent !== editor; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !(control.tagName === 'SUMMARY' && parent === control.parentElement)) parent.open = true;
      control.focus();
    };
    const inputField = (body, item, key, label, max, { multiline = false, optional = false, required = false, update } = {}) => {
      const control = multiline ? textarea(`builder-data-${item.id}-${key}`, item[key], 4) : input(`builder-data-${item.id}-${key}`, item[key]);
      control.maxLength = max; control.dataset.dataTableLabel = label;
      if (required) { control.dataset.nonblank = 'true'; control.setAttribute('aria-required', 'true'); }
      control.addEventListener('input', () => { if (optional && !control.value) delete item[key]; else item[key] = control.value; update?.(); resetReview(); });
      body.append(field(label, control)); return control;
    };
    const numberField = (body, item, key, label, min, max, id, fallback = '') => {
      const control = input(id, item[key] ?? fallback); Object.assign(control, { type: 'number', min: String(min), max: String(max), step: '1', placeholder: key === 'min_width' ? 'Автоматически' : 'Не задано' }); control.dataset.dataTableLabel = label;
      control.addEventListener('input', () => { if (control.value) item[key] = Number(control.value); else delete item[key]; resetReview(); }); body.append(field(label, control));
    };
    const checkbox = (body, item, key, label, id, fallback = false) => {
      const control = node('input', 'form-check-input'); Object.assign(control, { id, type: 'checkbox', checked: item[key] ?? fallback }); bind(control, item, key); body.append(field(label, control));
    };
    const alignField = (body, item, inherit) => {
      const control = node('select', 'form-select'); control.id = `builder-data-${item.id}-align`;
      for (const [value, label] of [...(inherit ? [['', 'По колонке']] : []), ['left', 'Слева'], ['center', 'По центру'], ['right', 'Справа']]) control.append(new Option(label, value, false, (item.align ?? (inherit ? '' : 'left')) === value));
      control.addEventListener('change', () => { if (control.value) item.align = control.value; else delete item.align; resetReview(); }); body.append(field('Выравнивание', control));
    };
    const render = (focusSelector) => {
      const opened = new Set([...editor.querySelectorAll('details[open]')].map(details => details.id));
      const active = editor.contains(document.activeElement) ? document.activeElement.id : null;
      clear(editor);
      const card = (items, item, index, kind, label, fill, removeItem, afterRemove) => {
        const shell = node('div', `builder-link-row builder-table-cell builder-data-${kind}`); shell.dataset.dataId = item.id;
        const details = node('details', 'builder-table-cell-details'), summary = node('summary'); details.id = `builder-data-${item.id}-details`;
        const update = () => { summary.textContent = (kind === 'cell' ? window.BuilderMarkdown.plainText(item.value).slice(0, 120) : String(kind === 'column' ? item.title : kind === 'group' ? item.group : '').trim()) || label; };
        const body = node('div', 'builder-table-cell-body'), controls = node('div', 'builder-image-tools');
        const move = beforeId => {
          if (state.saving || item.id === beforeId) return;
          const index = items.indexOf(item); if (index < 0) return; items.splice(index, 1);
          const destination = beforeId ? items.findIndex(candidate => candidate.id === beforeId) : items.length;
          items.splice(destination < 0 ? items.length : destination, 0, item); resetReview(); render(`#builder-data-${CSS.escape(item.id)}-drag`);
        };
        const handle = action('⠿', () => { live.textContent = 'Используйте стрелки вверх и вниз или перетащите элемент.'; }, 'builder-media-drag');
        handle.id = `builder-data-${item.id}-drag`; handle.draggable = true; handle.setAttribute('aria-label', `Перетащить: ${label.toLowerCase()} ${index + 1}`);
        handle.addEventListener('keydown', event => { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); if (event.key === 'ArrowUp' && index > 0) move(items[index - 1].id); else if (event.key === 'ArrowDown' && index < items.length - 1) move(items[index + 2]?.id); });
        handle.addEventListener('dragstart', event => { if (state.saving) { event.preventDefault(); return; } event.stopPropagation(); dragged = { items, item, move }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); });
        handle.addEventListener('dragend', event => { event.stopPropagation(); dragged = null; editor.querySelectorAll('.builder-drop-before,.builder-drop-after').forEach(element => element.classList.remove('builder-drop-before', 'builder-drop-after')); });
        const remove = action('', () => { if (state.saving) return; removeItem(); resetReview(); render(afterRemove); }, 'builder-delete text-danger'); remove.setAttribute('aria-label', `Удалить: ${label.toLowerCase()} ${index + 1}`); remove.append(trashIcon()); controls.append(remove, handle);
        const before = event => event.clientY < shell.getBoundingClientRect().top + shell.getBoundingClientRect().height / 2;
        shell.addEventListener('dragover', event => { if (!dragged || dragged.items !== items || state.saving) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; shell.classList.toggle('builder-drop-before', before(event)); shell.classList.toggle('builder-drop-after', !before(event)); });
        shell.addEventListener('dragleave', event => { event.stopPropagation(); shell.classList.remove('builder-drop-before', 'builder-drop-after'); });
        shell.addEventListener('drop', event => { if (!dragged || dragged.items !== items || state.saving) return; event.preventDefault(); event.stopPropagation(); const current = dragged; dragged = null; current.move(before(event) ? item.id : items[index + 1]?.id); });
        fill(body, update); update(); summary.id = `builder-data-${item.id}-summary`; details.append(summary, body); shell.append(details, controls); return shell;
      };
      const add = (id, label, callback, disabled) => {
        const button = action('', callback, 'builder-add builder-image-add'); button.id = id; button.disabled = disabled; button.setAttribute('aria-label', label); button.title = label;
        const plus = node('span', 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true'); button.append(plus); return button;
      };
      const columns = node('section', 'builder-images-section builder-table-section'), columnList = node('div', 'builder-data-columns'); columns.append(node('h4', '', 'Колонки'), columnList);
      entity.columns.forEach((column, index) => columnList.append(card(entity.columns, column, index, 'column', 'Колонка', (body, update) => {
        inputField(body, column, 'title', 'Заголовок', 500, { update }); inputField(body, column, 'key', 'Ключ', 200); alignField(body, column, false);
        numberField(body, column, 'width', 'Ширина, %', 5, 80, `builder-data-${column.id}-width`); checkbox(body, column, 'nowrap', 'Не переносить текст', `builder-data-${column.id}-nowrap`);
      }, () => entity.columns.splice(index, 1), '#builder-add-data-column')));
      columns.append(add('builder-add-data-column', 'Добавить колонку', () => { if (state.saving || entity.columns.length >= limits.columns) return; const column = { id: `column-${crypto.randomUUID()}`, key: '', title: '' }; entity.columns.push(column); resetReview(); render(`#builder-data-${CSS.escape(column.id)}-summary`); }, entity.columns.length >= limits.columns));
      editor.append(columns);
      const rows = node('section', 'builder-images-section builder-table-section'), rowList = node('div', 'builder-data-rows'); rows.append(node('h4', '', 'Строки'), rowList);
      entity.rows.forEach((row, index) => rowList.append(card(entity.rows, row, index, Object.hasOwn(row, 'group') ? 'group' : 'row', Object.hasOwn(row, 'group') ? 'Группа' : 'Строка', (body, update) => {
        const group = Object.hasOwn(row, 'group'), type = node('select', 'form-select'); type.id = `builder-data-${row.id}-type`;
        type.append(new Option('Строка', 'row', false, !group), new Option('Группа', 'group', false, group));
        type.addEventListener('change', () => {
          if (state.saving || type.value === (group ? 'group' : 'row')) return;
          const drafts = rowDrafts.get(row.id) || {};
          if (group) drafts.group = row.group; else drafts.cells = structuredClone(row.cells);
          const cells = type.value === 'row' ? structuredClone(drafts.cells || [emptyCell()]) : null;
          if (cells && cellCount() + cells.length > limits.cells) {
            type.value = 'group'; formError.textContent = `В таблице может быть не больше ${limits.cells} ячеек. Удалите лишние ячейки перед сменой типа.`; formError.classList.remove('d-none'); type.focus(); return;
          }
          rowDrafts.set(row.id, drafts); delete row.group; delete row.cells;
          if (cells) row.cells = cells; else row.group = drafts.group ?? '';
          resetReview(); render(`#${CSS.escape(type.id)}`);
        });
        body.append(field('Тип', type));
        if (group) { inputField(body, row, 'group', 'Заголовок', 500, { required: true, update }); return; }
        const cells = node('div', 'builder-table-cells'); body.append(cells);
        row.cells.forEach((cell, cellIndex) => cells.append(card(row.cells, cell, cellIndex, 'cell', 'Ячейка', (cellBody, updateCell) => {
          const text = itemMarkdownField(cell, `builder-data-${cell.id}-value`, 'builder-table-cell-text', 'value'); text.id = `builder-data-${cell.id}-text`;
          const source = text.querySelector('textarea'); source.dataset.dataTableLabel = 'Текст'; source.addEventListener('input', updateCell); cellBody.append(text);
          const settings = node('details', 'builder-table-cell-settings'); settings.id = `builder-data-${cell.id}-settings`; settings.append(node('summary', '', 'Настройки'));
          inputField(settings, cell, 'key', 'Ключ', 200, { optional: true }); alignField(settings, cell, true);
          numberField(settings, cell, 'colspan', 'Объединить колонок', 1, 12, `builder-data-${cell.id}-colspan`, 1); numberField(settings, cell, 'rowspan', 'Объединить строк', 1, 100, `builder-data-${cell.id}-rowspan`, 1);
          checkbox(settings, cell, 'is_header', 'Ячейка-заголовок', `builder-data-${cell.id}-is_header`); checkbox(settings, cell, 'nowrap', 'Не переносить текст', `builder-data-${cell.id}-nowrap`); cellBody.append(settings);
        }, () => { row.cells.splice(cellIndex, 1); if (!row.cells.length) { entity.rows.splice(entity.rows.indexOf(row), 1); rowDrafts.delete(row.id); } }, row.cells.length > 1 ? `#builder-data-${CSS.escape(row.id)}-add-cell` : '#builder-add-data-row')));
        body.append(add(`builder-data-${row.id}-add-cell`, 'Добавить ячейку', () => { if (state.saving || cellCount() >= limits.cells) return; const cell = emptyCell(); row.cells.push(cell); resetReview(); render(`#builder-data-${CSS.escape(cell.id)}-summary`); }, cellCount() >= limits.cells));
      }, () => { entity.rows.splice(index, 1); rowDrafts.delete(row.id); }, '#builder-add-data-row')));
      rows.append(add('builder-add-data-row', 'Добавить строку', () => { if (state.saving || entity.rows.length >= limits.rows || cellCount() >= limits.cells) return; const row = { id: `row-${crypto.randomUUID()}`, cells: [emptyCell()] }; entity.rows.push(row); resetReview(); render(`#builder-data-${CSS.escape(row.id)}-summary`); }, entity.rows.length >= limits.rows || cellCount() >= limits.cells)); editor.append(rows);
      for (const details of editor.querySelectorAll('details')) details.open = opened.has(details.id);
      // Focusing a summary must not expand its own new card, only its ancestors.
      if (focusSelector) focus(focusSelector); else if (active) focus(`#${CSS.escape(active)}`);
    };
    render();
    const advanced = node('details', 'builder-banner-advanced builder-data-advanced'); advanced.append(node('summary', '', 'Дополнительные настройки'));
    for (const [key, label, fallback] of [['striped', 'Чередовать фон строк', true], ['bordered', 'Показывать рамки', true], ['sticky_header', 'Закрепить заголовки колонок', false]]) checkbox(advanced, entity.meta, key, label, `builder-data-${key}`, fallback);
    numberField(advanced, entity.meta, 'min_width', 'Минимальная ширина, px', 480, 1600, 'builder-data-min_width'); container.append(advanced);
  }
  function validateDataTableFields() {
    for (const control of fields.querySelectorAll('[data-data-table-label]')) {
      let message = '';
      if (control.dataset.nonblank && !control.value.trim()) message = `Заполните поле «${control.dataset.dataTableLabel}».`;
      else if (!control.validity.valid) message = control.type === 'number' ? `Поле «${control.dataset.dataTableLabel}»: укажите целое число от ${control.min} до ${control.max} или оставьте пустым.` : `Проверьте поле «${control.dataset.dataTableLabel}».`;
      if (!message) continue;
      formError.textContent = message; formError.classList.remove('d-none');
      for (let parent = control.parentElement; parent && parent !== fields; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      control.focus(); control.scrollIntoView({ block: 'nearest' }); return false;
    }
    return true;
  }
  function tableFields(entity, container) {
    entity.rows ||= []; entity.meta ||= {};
    const section = node('section', 'builder-images-section builder-table-section'), heading = node('h4', '', 'Таблица');
    const list = node('div', 'builder-table-rows');
    const cellCount = () => entity.rows.reduce((sum, row) => sum + row.cells.length, 0);
    const emptyCell = () => ({ id: `cell-${crypto.randomUUID()}`, title: '', text: '', link: '', meta: {} });
    const addRow = action('', () => {
      if (state.saving || entity.rows.length >= 100 || cellCount() >= 100) return;
      const row = { id: `row-${crypto.randomUUID()}`, cells: [emptyCell()] }; entity.rows.push(row); resetReview(); renderRows();
      list.querySelector(`[data-row-id="${CSS.escape(row.id)}"] > details > summary`)?.focus();
    }, 'builder-add builder-image-add builder-table-add-row');
    addRow.id = 'builder-add-table-row'; addRow.setAttribute('aria-label', 'Добавить строку'); addRow.title = 'Добавить строку';
    const plus = node('span', 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true'); addRow.append(plus);
    section.append(heading, list, addRow); container.append(section);
    let draggedRow = null, draggedCell = null;
    const move = (items, id, beforeId, focusSelector) => {
      if (state.saving || id === beforeId) return;
      const index = items.findIndex(item => item.id === id); if (index < 0) return;
      const [item] = items.splice(index, 1), destination = beforeId ? items.findIndex(candidate => candidate.id === beforeId) : items.length;
      items.splice(destination, 0, item); resetReview(); renderRows({ preserveOpen: true }); list.querySelector(focusSelector)?.focus();
    };
    const rowDropClasses = () => list.querySelectorAll('.builder-drop-before,.builder-drop-after').forEach(item => item.classList.remove('builder-drop-before', 'builder-drop-after'));
    const renderRows = ({ preserveOpen = false } = {}) => {
      const openRows = preserveOpen ? new Set([...list.querySelectorAll('.builder-table-row-details[open]')].map(details => details.closest('.builder-table-row')?.dataset.rowId).filter(Boolean)) : new Set();
      const openCells = preserveOpen ? new Set([...list.querySelectorAll('.builder-table-cell-details[open]')].map(details => details.closest('.builder-table-cell')?.dataset.cellId).filter(Boolean)) : new Set();
      clearMediaPreviewObservers(); clear(list); addRow.disabled = entity.rows.length >= 100 || cellCount() >= 100;
      entity.rows.forEach((row, rowIndex) => {
        row.cells ||= [];
        const shell = node('div', 'builder-link-row builder-table-row'); shell.dataset.rowId = row.id;
        const details = node('details', 'builder-table-row-details'), summary = node('summary', '', 'Строка'); details.open = openRows.has(row.id);
        const body = node('div', 'builder-table-row-body'), cells = node('div', 'builder-table-cells');
        const controls = node('div', 'builder-image-tools'), handle = action('⠿', () => { live.textContent = 'Используйте стрелки вверх и вниз или перетащите строку.'; }, 'builder-media-drag builder-table-row-drag');
        handle.draggable = true; handle.setAttribute('aria-label', `Перетащить строку ${rowIndex + 1}`);
        handle.addEventListener('dragstart', event => { if (state.saving) { event.preventDefault(); return; } draggedRow = row.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.id); });
        handle.addEventListener('dragend', () => { draggedRow = null; rowDropClasses(); });
        handle.addEventListener('keydown', event => {
          if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault();
          if (event.key === 'ArrowUp' && rowIndex > 0) move(entity.rows, row.id, entity.rows[rowIndex - 1].id, `[data-row-id="${CSS.escape(row.id)}"] .builder-table-row-drag`);
          if (event.key === 'ArrowDown' && rowIndex < entity.rows.length - 1) move(entity.rows, row.id, entity.rows[rowIndex + 2]?.id, `[data-row-id="${CSS.escape(row.id)}"] .builder-table-row-drag`);
        });
        const remove = action('', () => {
          if (state.saving) return; const candidates = row.cells.flatMap(tableCellImageIds); entity.rows.splice(rowIndex, 1); pruneTableMedia(entity, candidates); resetReview(); renderRows(); addRow.focus();
        }, 'builder-delete text-danger'); remove.setAttribute('aria-label', `Удалить строку ${rowIndex + 1}`); remove.append(trashIcon()); controls.append(handle, remove);
        const addCell = action('', () => {
          if (state.saving || row.cells.length >= 100 || cellCount() >= 100) return;
          const cell = emptyCell(); row.cells.push(cell); resetReview(); renderRows();
          const reopened = list.querySelector(`[data-row-id="${CSS.escape(row.id)}"] > details`); if (reopened) reopened.open = true;
          list.querySelector(`[data-cell-id="${CSS.escape(cell.id)}"] > details > summary`)?.focus();
        }, 'builder-add builder-image-add builder-table-add-cell');
        addCell.setAttribute('aria-label', 'Добавить ячейку'); addCell.title = 'Добавить ячейку'; const cellPlus = node('span', 'builder-add-plus', '+'); cellPlus.setAttribute('aria-hidden', 'true'); addCell.append(cellPlus);
        let cellDragged = null;
        row.cells.forEach((cell, cellIndex) => {
          cell.meta ||= {};
          const cellShell = node('div', 'builder-link-row builder-table-cell'); cellShell.dataset.cellId = cell.id;
          const cellDetails = node('details', 'builder-table-cell-details'), cellSummary = node('summary', '', cell.title || 'Ячейка'); cellDetails.open = openCells.has(cell.id);
          const cellBody = node('div', 'builder-table-cell-body'), cellControls = node('div', 'builder-image-tools');
          const cellHandle = action('⠿', () => { live.textContent = 'Используйте стрелки вверх и вниз или перетащите ячейку.'; }, 'builder-media-drag builder-table-cell-drag');
          cellHandle.draggable = true; cellHandle.setAttribute('aria-label', `Перетащить ячейку ${cellIndex + 1}`);
          cellHandle.addEventListener('dragstart', event => { if (state.saving) { event.preventDefault(); return; } event.stopPropagation(); cellDragged = cell.id; draggedCell = cell.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', cell.id); });
          cellHandle.addEventListener('dragend', event => { event.stopPropagation(); cellDragged = null; draggedCell = null; cells.querySelectorAll('.builder-drop-before,.builder-drop-after').forEach(item => item.classList.remove('builder-drop-before', 'builder-drop-after')); });
          cellHandle.addEventListener('keydown', event => {
            if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault();
            if (event.key === 'ArrowUp' && cellIndex > 0) move(row.cells, cell.id, row.cells[cellIndex - 1].id, `[data-cell-id="${CSS.escape(cell.id)}"] .builder-table-cell-drag`);
            if (event.key === 'ArrowDown' && cellIndex < row.cells.length - 1) move(row.cells, cell.id, row.cells[cellIndex + 2]?.id, `[data-cell-id="${CSS.escape(cell.id)}"] .builder-table-cell-drag`);
          });
          const removeCell = action('', () => {
            if (state.saving) return; const candidates = tableCellImageIds(cell); row.cells.splice(cellIndex, 1);
            if (!row.cells.length) entity.rows.splice(entity.rows.indexOf(row), 1); pruneTableMedia(entity, candidates); resetReview(); renderRows();
            (entity.rows.includes(row) ? list.querySelector(`[data-row-id="${CSS.escape(row.id)}"] .builder-table-add-cell`) : addRow)?.focus();
          }, 'builder-delete text-danger'); removeCell.setAttribute('aria-label', `Удалить ячейку ${cellIndex + 1}`); removeCell.append(trashIcon()); cellControls.append(removeCell, cellHandle);
          const title = input(`builder-cell-${cell.id}-title`, cell.title); title.placeholder = 'Заголовок'; title.setAttribute('aria-label', 'Заголовок'); title.maxLength = 500;
          bind(title, cell, 'title'); title.addEventListener('input', () => { cellSummary.textContent = title.value || 'Ячейка'; }); cellBody.append(title);
          cellBody.append(itemMarkdownField(cell, `builder-cell-${cell.id}-text`, 'builder-table-cell-text'));
          mediaFields(entity, cellBody, 'Изображения', { tableCell: cell });
          const link = node('details', 'builder-link-fields builder-gallery-link builder-gallery-collapsible builder-table-cell-link'); link.append(node('summary', '', 'Ссылка'));
          const linkFields = node('div', 'builder-gallery-link-fields'), linkControl = input(`builder-cell-${cell.id}-link`, cell.link); linkControl.type = 'url'; linkControl.placeholder = 'URL'; linkControl.setAttribute('aria-label', 'URL'); linkControl.maxLength = 4096; linkFields.append(bind(linkControl, cell, 'link')); link.append(linkFields); cellBody.append(link);
          const settings = node('details', 'builder-gallery-image-settings builder-table-cell-settings'); settings.append(node('summary', '', 'Настройки ячейки'));
          for (const [key, label, options, fallback] of [
            ['align', 'Выравнивание содержимого', ['left', 'center', 'right'], 'left'], ['media_mode', 'Режим размера', ['intrinsic', 'fill'], 'intrinsic'], ['media_align', 'Выравнивание изображения', ['start', 'center', 'end'], 'start']
          ]) {
            const control = node('select', 'form-select'); control.id = `builder-cell-${cell.id}-${key}`;
            for (const value of options) control.append(new Option(value, value, false, (cell.meta[key] ?? fallback) === value));
            control.addEventListener('change', () => { cell.meta[key] = control.value; resetReview(); }); settings.append(field(label, control));
          }
          for (const [key, label, min, max, fallback] of [['colspan', 'Столбцов', 1, 12, 1], ['rowspan', 'Строк', 1, 100, 1], ['media_width', 'Максимальная ширина изображения, px', 48, 1600, '']]) {
            const control = input(`builder-cell-${cell.id}-${key}`, cell.meta[key] ?? fallback); control.type = 'number'; control.min = String(min); control.max = String(max); control.step = '1'; if (key === 'media_width') control.placeholder = 'Без ограничения';
            control.addEventListener('input', () => { if (control.value) cell.meta[key] = Number(control.value); else delete cell.meta[key]; resetReview(); }); settings.append(field(label, control));
          }
          const header = node('input', 'form-check-input'); header.id = `builder-cell-${cell.id}-is_header`; header.type = 'checkbox'; header.checked = cell.meta.is_header ?? false;
          header.addEventListener('change', () => { cell.meta.is_header = header.checked; resetReview(); }); settings.append(field('Ячейка-заголовок', header)); cellBody.append(settings);
          cellDetails.append(cellSummary, cellBody); cellShell.append(cellDetails, cellControls);
          const beforeCell = event => event.clientY < cellShell.getBoundingClientRect().top + cellShell.getBoundingClientRect().height / 2;
          cellShell.addEventListener('dragover', event => { if (!cellDragged || state.saving) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; cellShell.classList.toggle('builder-drop-before', beforeCell(event)); cellShell.classList.toggle('builder-drop-after', !beforeCell(event)); });
          cellShell.addEventListener('dragleave', event => { event.stopPropagation(); cellShell.classList.remove('builder-drop-before', 'builder-drop-after'); });
          cellShell.addEventListener('drop', event => { if (!cellDragged || state.saving) return; event.preventDefault(); event.stopPropagation(); const id = cellDragged; cellDragged = null; draggedCell = null; move(row.cells, id, beforeCell(event) ? cell.id : row.cells[cellIndex + 1]?.id, `[data-cell-id="${CSS.escape(id)}"] .builder-table-cell-drag`); });
          cells.append(cellShell);
        });
        addCell.disabled = row.cells.length >= 100 || cellCount() >= 100; body.append(cells, addCell); details.append(summary, body); shell.append(details, controls);
        const beforeRow = event => event.clientY < shell.getBoundingClientRect().top + shell.getBoundingClientRect().height / 2;
        shell.addEventListener('dragover', event => { if (!draggedRow || draggedCell || state.saving) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; shell.classList.toggle('builder-drop-before', beforeRow(event)); shell.classList.toggle('builder-drop-after', !beforeRow(event)); });
        shell.addEventListener('dragleave', () => { if (!draggedCell) shell.classList.remove('builder-drop-before', 'builder-drop-after'); });
        shell.addEventListener('drop', event => { if (!draggedRow || draggedCell || state.saving) return; event.preventDefault(); const id = draggedRow; draggedRow = null; move(entity.rows, id, beforeRow(event) ? row.id : entity.rows[rowIndex + 1]?.id, `[data-row-id="${CSS.escape(id)}"] .builder-table-row-drag`); });
        list.append(shell);
      });
    };
    renderRows();
    const advanced = node('details', 'builder-banner-advanced builder-table-advanced'); advanced.append(node('summary', '', 'Дополнительные настройки'));
    const border = node('input', 'form-check-input'); border.id = 'builder-show_border'; border.type = 'checkbox'; border.checked = entity.show_border ?? false;
    border.addEventListener('change', () => { entity.show_border = border.checked; resetReview(); }); advanced.append(field('Показывать рамки', border)); container.append(advanced);
  }
  function gridFields(entity, container) {
    entity.items ||= []; entity.meta ||= {};
    // The site renders grid images only through item references. Adopt every
    // pooled asset no item points to (legacy galleries, blocks converted from
    // other types) as its own element, or the image would silently disappear.
    const adopted = new Set(entity.items.map(item => item.image_asset_id).filter(Boolean));
    for (const asset of entity.media) {
      if (adopted.has(asset.id)) continue;
      adopted.add(asset.id);
      entity.items.push({ id: `item-${crypto.randomUUID()}`, title: '', text: '', link: '', link_text: '', image_asset_id: asset.id, badge: '', date: '', meta: {} });
    }
    const section = node('section', 'builder-images-section builder-links-section builder-gallery-section');
    const heading = node('h4', '', 'Элементы'), list = node('div', 'builder-link-items');
    const add = action('', () => {
      if (state.saving || entity.items.length >= 100) return;
      const asset = emptyMedia(); entity.media.push(asset);
      const item = { id: `item-${crypto.randomUUID()}`, title: '', text: '', link: '', link_text: '', image_asset_id: asset.id, badge: '', date: '', meta: {} };
      entity.items.push(item); resetReview(); renderItems(); list.querySelector(`[data-item-id="${CSS.escape(item.id)}"] > .builder-item-details > .builder-item-summary`)?.focus();
    }, 'builder-add builder-image-add');
    add.id = 'builder-add-gallery-item'; add.setAttribute('aria-label', 'Добавить элемент'); add.title = 'Добавить элемент';
    const plus = node('span', 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true'); add.append(plus);
    section.append(heading, list, add); container.append(section);
    let dragged = null; const openItems = new Set();
    const inherited = key => entity.meta[key] ?? ({ media_mode: 'intrinsic', media_align: 'start' })[key];
    const syncItemFallbacks = () => {
      for (const control of list.querySelectorAll('[data-gallery-fallback]')) {
        const key = control.dataset.galleryFallback;
        if (key === 'media_width') control.placeholder = inherited(key) ? `По умолчанию (${inherited(key)} px)` : 'По умолчанию (без ограничения)';
        else control.querySelector('option[value=""]').textContent = `По умолчанию (${inherited(key)})`;
      }
    };
    const move = (id, beforeId) => {
      if (state.saving || id === beforeId) return;
      const index = entity.items.findIndex(item => item.id === id); if (index < 0) return;
      const [item] = entity.items.splice(index, 1), destination = beforeId ? entity.items.findIndex(candidate => candidate.id === beforeId) : entity.items.length;
      entity.items.splice(destination, 0, item); resetReview(); renderItems(); list.querySelector(`[data-item-id="${CSS.escape(id)}"] .builder-link-drag`)?.focus();
    };
    const renderItems = () => {
      clearMediaPreviewObservers(); clear(list); add.disabled = entity.items.length >= 100;
      entity.items.forEach((item, index) => {
        item.meta ||= {};
        if (!entity.media.some(asset => asset.id === item.image_asset_id)) {
          const asset = emptyMedia(); entity.media.push(asset); item.image_asset_id = asset.id;
        }
        const row = node('div', 'builder-link-row builder-gallery-item builder-collapsible-item'); row.dataset.itemId = item.id;
        const body = node('div', 'builder-link-body builder-gallery-item-body'), controls = node('div', 'builder-image-tools');
        const itemShell = itemDetails(body, item, 'Элемент', openItems);
        const handle = action('⠿', () => { live.textContent = 'Используйте стрелки вверх и вниз или перетащите элемент.'; }, 'builder-media-drag builder-link-drag');
        handle.draggable = true; handle.setAttribute('aria-label', `Перетащить элемент ${index + 1}`);
        handle.addEventListener('dragstart', event => { if (state.saving) { event.preventDefault(); return; } dragged = item.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); });
        handle.addEventListener('dragend', () => { dragged = null; list.querySelectorAll('.builder-drop-before,.builder-drop-after').forEach(element => element.classList.remove('builder-drop-before', 'builder-drop-after')); });
        handle.addEventListener('keydown', event => {
          if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'ArrowUp' && index > 0) move(item.id, entity.items[index - 1].id);
          if (event.key === 'ArrowDown' && index < entity.items.length - 1) move(item.id, entity.items[index + 2]?.id);
        });
        const remove = action('', () => {
          if (state.saving) return;
          entity.items.splice(index, 1);
          if (!entity.items.some(candidate => candidate.image_asset_id === item.image_asset_id)) entity.media = entity.media.filter(asset => asset.id !== item.image_asset_id);
          resetReview(); renderItems(); add.focus();
        }, 'builder-delete text-danger');
        remove.setAttribute('aria-label', `Удалить элемент ${index + 1}`); remove.append(trashIcon()); controls.append(remove, handle);
        const title = input(`builder-item-${item.id}-title`, item.title); title.placeholder = 'Заголовок'; title.setAttribute('aria-label', 'Заголовок'); title.maxLength = 500;
        bind(title, item, 'title'); title.addEventListener('input', itemShell.update);
        body.append(title, itemMarkdownField(item, `builder-item-${item.id}-text`));
        const imageSection = mediaFields(entity, body, 'Изображение', { galleryItem: item });
        const imageSettings = node('details', 'builder-gallery-image-settings'); imageSettings.append(node('summary', '', 'Настройки изображения'));
        for (const [key, label, options] of [
          ['media_mode', 'Режим размера', ['intrinsic', 'fill']],
          ['media_align', 'Выравнивание изображения', ['start', 'center', 'end']]
        ]) {
          const control = node('select', 'form-select'); control.id = `builder-item-${item.id}-${key}`; control.dataset.galleryFallback = key;
          control.append(new Option('', '', false, item.meta[key] === undefined));
          for (const value of options) control.append(new Option(value, value, false, item.meta[key] === value));
          control.addEventListener('change', () => { if (control.value) item.meta[key] = control.value; else delete item.meta[key]; resetReview(); }); imageSettings.append(field(label, control));
        }
        const width = input(`builder-item-${item.id}-media_width`, item.meta.media_width ?? ''); width.type = 'number'; width.min = '48'; width.max = '1600'; width.step = '1'; width.dataset.galleryFallback = 'media_width';
        width.addEventListener('input', () => { if (width.value) item.meta.media_width = Number(width.value); else delete item.meta.media_width; resetReview(); });
        imageSettings.append(field('Максимальная ширина, px', width)); imageSection.append(imageSettings);
        const link = node('details', 'builder-link-fields builder-gallery-link builder-gallery-collapsible'); link.append(node('summary', '', 'Ссылка'));
        const linkFields = node('div', 'builder-gallery-link-fields');
        for (const [key, label] of [['link', 'URL'], ['link_text', 'Текст ссылки']]) {
          const control = input(`builder-item-${item.id}-${key}`, item[key]); control.placeholder = label; control.setAttribute('aria-label', label);
          control.maxLength = key === 'link' ? 4096 : 500; if (key === 'link') control.type = 'url'; linkFields.append(bind(control, item, key));
        }
        const style = node('select', 'form-select'); style.id = `builder-item-${item.id}-action_style`;
        for (const [value, label] of [['link', 'Ссылка'], ['primary', 'Кнопка']]) style.append(new Option(label, value, false, (item.meta.action_style || 'link') === value));
        style.addEventListener('change', () => { item.meta.action_style = style.value; resetReview(); }); linkFields.append(field('Вид действия', style)); link.append(linkFields); body.append(link);
        const labels = node('div', 'builder-gallery-labels');
        for (const [key, label] of [['badge', 'Метка'], ['date', 'Дата']]) {
          const control = input(`builder-item-${item.id}-${key}`, item[key]); control.maxLength = 500; control.placeholder = label; control.setAttribute('aria-label', label); labels.append(bind(control, item, key));
        }
        body.append(labels);
        row.append(itemShell.details, controls);
        const before = event => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
        row.addEventListener('dragover', event => { if (!dragged || state.saving) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; row.classList.toggle('builder-drop-before', before(event)); row.classList.toggle('builder-drop-after', !before(event)); });
        row.addEventListener('dragleave', () => row.classList.remove('builder-drop-before', 'builder-drop-after'));
        row.addEventListener('drop', event => { if (!dragged || state.saving) return; event.preventDefault(); const id = dragged; dragged = null; move(id, before(event) ? item.id : entity.items[index + 1]?.id); });
        list.append(row);
      });
      syncItemFallbacks();
    };
    renderItems();
    const advanced = node('details', 'builder-banner-advanced builder-gallery-advanced'); advanced.append(node('summary', '', 'Дополнительные настройки'));
    const select = (key, label, options, fallback) => {
      const control = node('select', 'form-select'); control.id = `builder-grid-${key}`;
      for (const value of options) control.append(new Option(String(value), String(value), false, (entity.meta[key] ?? fallback) === value));
      control.addEventListener('change', () => { entity.meta[key] = key === 'columns' ? Number(control.value) : control.value; if (['media_mode', 'media_align'].includes(key)) syncItemFallbacks(); resetReview(); }); advanced.append(field(label, control));
    };
    const viewDefaults = {
      columns: entity.view === 'compact' ? 5 : entity.view === 'list' ? 2 : 3,
      image_ratio: ['promo', 'news'].includes(entity.view) ? '3x2' : entity.view === 'services' ? '4x3' : 'auto',
      image_fit: ['promo', 'news', 'services', 'list'].includes(entity.view) ? 'cover' : 'contain'
    };
    select('columns', 'Колонки', [2, 3, 4, 5, 6], viewDefaults.columns);
    select('image_ratio', 'Соотношение сторон изображения', ['auto', '4x3', '3x2', '1x1'], viewDefaults.image_ratio);
    select('image_fit', 'Заполнение изображения', ['cover', 'contain'], viewDefaults.image_fit);
    select('items_align', 'Выравнивание элементов', ['start', 'center', 'end'], 'start');
    select('media_mode', 'Режим размера', ['intrinsic', 'fill'], 'intrinsic');
    select('media_align', 'Выравнивание изображения', ['start', 'center', 'end'], 'start');
    for (const [key, label] of [['item_max_width', 'Максимальная ширина элемента, px'], ['media_width', 'Максимальная ширина изображения, px']]) {
      const control = input(`builder-grid-${key}`, entity.meta[key] ?? ''); control.type = 'number'; control.min = key === 'item_max_width' ? '96' : '48'; control.max = key === 'item_max_width' ? '720' : '1600'; control.step = '1'; control.placeholder = 'Без ограничения';
      control.addEventListener('input', () => { if (control.value) entity.meta[key] = Number(control.value); else delete entity.meta[key]; if (key === 'media_width') syncItemFallbacks(); resetReview(); }); advanced.append(field(label, control));
    }
    const border = node('input', 'form-check-input'); border.type = 'checkbox'; border.id = 'builder-grid-show_border'; border.checked = entity.meta.show_border ?? ['catalog', 'promo', 'news', 'services', 'list'].includes(entity.view);
    border.addEventListener('change', () => { entity.meta.show_border = border.checked; resetReview(); }); advanced.append(field('Показывать рамки', border));
    container.append(advanced);
  }
  function mediaFields(entity, container = fields, label = 'Изображения', { banner = false, fixedCount = 0, galleryItem = null, tableCell = null } = {}) {
    const collapsible = galleryItem || tableCell;
    const section = node(collapsible ? 'details' : 'section', `${banner ? 'builder-images-section builder-banner-image' : 'builder-images-section'}${collapsible ? ' builder-gallery-collapsible' : ''}${tableCell ? ' builder-table-cell-images' : ''}`); section.setAttribute('aria-labelledby', collapsible ? `builder-image-title-${(galleryItem || tableCell).id}` : 'builder-images-title');
    const heading = node(collapsible ? 'summary' : 'h4', '', label); heading.id = collapsible ? `builder-image-title-${(galleryItem || tableCell).id}` : 'builder-images-title';
    const draft = state.draft;
    const cellIds = () => tableCell ? tableCellImageIds(tableCell) : [];
    const canAdd = () => tableCell ? cellIds().length < 12 && entity.media.length < 1200 : entity.media.length < 12;
    const list = node('div', 'builder-images'), add = action('', () => {
      if (state.saving || !canAdd()) return; const asset = emptyMedia(); entity.media.push(asset);
      if (tableCell) setTableCellImageIds(tableCell, [...cellIds(), asset.id]);
      resetReview(); renderMedia(); document.getElementById(`builder-media-${asset.id}-originalUrl-choose`).focus();
    }, 'builder-add builder-image-add');
    if (!galleryItem && !tableCell) add.id = 'builder-add-image'; add.setAttribute('aria-label', 'Добавить изображение'); add.title = 'Добавить изображение';
    const plus = node('span', 'builder-add-plus', '+'); plus.setAttribute('aria-hidden', 'true'); add.append(plus);
    section.append(heading, list); if (!banner && !fixedCount && !galleryItem) section.append(add); container.append(section);
    const observers = new Set();
    let dragged = null;
    const move = (id, beforeId) => {
      if (state.saving || id === beforeId) return;
      if (tableCell) {
        const ids = cellIds(), index = ids.indexOf(id); if (index < 0) return;
        ids.splice(index, 1); const destination = beforeId ? ids.indexOf(beforeId) : ids.length; ids.splice(destination, 0, id); setTableCellImageIds(tableCell, ids);
        resetReview(); renderMedia(); list.querySelector(`[data-media-id="${CSS.escape(id)}"] .builder-media-drag`)?.focus(); return;
      }
      const index = entity.media.findIndex(item => item.id === id); if (index < 0) return;
      if (fixedCount && (index >= fixedCount || (beforeId && !entity.media.slice(0, fixedCount).some(item => item.id === beforeId)))) return;
      const asset = entity.media.splice(index, 1)[0], destination = beforeId ? entity.media.findIndex(item => item.id === beforeId) : fixedCount ? Math.min(fixedCount - 1, entity.media.length) : entity.media.length;
      entity.media.splice(destination, 0, asset); resetReview(); renderMedia(); list.querySelector(`[data-media-id="${id}"] .builder-media-drag`)?.focus();
    };
    const renderMedia = () => {
      for (const observer of observers) { observer.disconnect(); mediaPreviewObservers.delete(observer); } observers.clear();
      clear(list); add.disabled = !canAdd();
      const visibleMedia = tableCell ? cellIds().map(id => entity.media.find(asset => asset.id === id)).filter(Boolean) : galleryItem ? entity.media.filter(asset => asset.id === galleryItem.image_asset_id) : banner ? entity.media.slice(0, 1) : fixedCount ? entity.media.slice(0, fixedCount) : entity.media;
      visibleMedia.forEach((asset, index) => {
        const row = node('div', 'builder-image-row'); row.dataset.mediaId = asset.id;
        const controls = node('div', 'builder-image-tools'), handle = action('⠿', () => { live.textContent = 'Используйте стрелки вверх и вниз для изменения порядка или перетащите изображение.'; }, 'builder-media-drag'); handle.draggable = true; handle.title = 'Перетащить изображение; стрелки вверх и вниз меняют порядок'; handle.setAttribute('aria-label', `Перетащить изображение ${index + 1}`);
        controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', `Действия с изображением ${index + 1}`);
        handle.addEventListener('dragstart', event => { if (state.saving) { event.preventDefault(); return; } dragged = asset.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', asset.id); });
        handle.addEventListener('dragend', () => { dragged = null; list.querySelectorAll('.builder-drop-before,.builder-drop-after').forEach(item => item.classList.remove('builder-drop-before', 'builder-drop-after')); });
        handle.addEventListener('keydown', event => {
          if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'ArrowUp' && index > 0) move(asset.id, visibleMedia[index - 1].id);
          if (event.key === 'ArrowDown' && index < visibleMedia.length - 1) move(asset.id, visibleMedia[index + 2]?.id);
        });
        const remove = action('', () => {
          if (state.saving) return;
          if (tableCell) { setTableCellImageIds(tableCell, cellIds().filter(id => id !== asset.id)); pruneTableMedia(entity, [asset.id]); }
          else entity.media.splice(entity.media.indexOf(asset), 1);
          resetReview(); renderMedia(); add.focus();
        }, 'builder-delete text-danger'); remove.setAttribute('aria-label', `Удалить изображение ${index + 1}`); remove.title = 'Удалить изображение'; remove.append(trashIcon());
        controls.append(handle); if (!fixedCount) controls.append(remove);
        const body = node('div', 'builder-media-form'), saved = sections().flatMap(section => section.blocks).flatMap(block => block.media).find(item => item.id === asset.id);
        const top = node('div', 'builder-media-top'), previews = node('div', 'builder-image-previews'), inputs = node('div', 'builder-media-fields');
        const draft = state.draft;
        for (const [kind, key] of [['original', 'originalUrl'], ['big', 'bigUrl']]) {
          const selectedPreview = draft.previews[`${asset.id}-${kind}`];
          const src = selectedPreview || (saved?.[`${kind}Url`] && saved[`${kind}Url`] === asset[`${kind}Url`] ? mediaUrl(saved, kind) : '');
          const choose = action('', () => openMediaCatalog(draft, entity, asset, kind, key, choose, renderMedia), 'builder-media-picker builder-image-preview-button');
          choose.id = `builder-media-${asset.id}-${key}-choose`; choose.title = `Выбрать ${kind === 'original' ? 'основную' : 'большую'} картинку`; choose.setAttribute('aria-label', choose.title);
          const preview = node(src ? 'img' : 'span', src ? 'builder-media-image' : 'builder-media-placeholder');
          if (src) { preview.src = src; preview.alt = ''; }
          else preview.append(lineIcon(['M4 5h16v14H4z', 'm4 15 3.5-4 3 3 2.5-3 4 5', 'M15.5 8.5h.01']));
          const overlay = node('span', 'builder-image-preview-hint'); overlay.setAttribute('aria-hidden', 'true');
          const hint = node('span', 'builder-image-preview-hint-text');
          hint.append(node('span', '', `Выбрать ${kind === 'original' ? 'основную' : 'большую'}`), node('span', '', 'картинку'));
          overlay.append(hint);
          choose.append(preview, overlay);
          const previewSlot = node('div', 'builder-image-preview-slot'); previewSlot.append(choose);
          if (asset[key]) {
            const clearVariant = action('×', () => {
              if (state.picking || state.saving || state.draft !== draft) return;
              asset[key] = ''; delete asset[`${kind}Media`]; delete draft.previews[`${asset.id}-${kind}`];
              resetReview(); renderMedia(); document.getElementById(choose.id)?.focus();
            }, 'builder-clear-media');
            clearVariant.type = 'button'; clearVariant.title = `Сбросить ${kind === 'original' ? 'основную' : 'большую'} картинку`;
            clearVariant.setAttribute('aria-label', clearVariant.title); previewSlot.append(clearVariant);
          }
          previews.append(previewSlot);
          for (const type of ['dragover', 'drop']) choose.addEventListener(type, event => {
            if (!event.dataTransfer?.types?.includes('Files')) return;
            event.preventDefault(); event.stopPropagation();
          });
        }
        for (const [key, label] of [['href', 'Ссылка изображения'], ['alt', 'Альтернативный текст']]) {
          const control = input(`builder-media-${asset.id}-${key}`, asset[key]);
          control.placeholder = label;
          control.setAttribute('aria-label', label);
          const wrapper = node('div', 'builder-image-text'); wrapper.dataset.field = key; wrapper.append(bind(control, asset, key)); inputs.append(wrapper);
        }
        top.prepend(previews, inputs); body.append(top);
        const caption = bind(textarea(`builder-media-${asset.id}-caption`, asset.caption, 1), asset, 'caption');
        caption.classList.add('builder-media-caption'); caption.placeholder = 'Подпись'; caption.setAttribute('aria-label', 'Подпись');
        caption.addEventListener('input', () => growTextarea(caption)); body.append(caption);
        if (banner || galleryItem) { row.classList.add('builder-banner-image-row'); row.append(body); }
        else row.append(body, controls);
        const before = event => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
        row.addEventListener('dragover', event => { if (!dragged || state.saving) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; row.classList.toggle('builder-drop-before', before(event)); row.classList.toggle('builder-drop-after', !before(event)); });
        row.addEventListener('dragleave', () => row.classList.remove('builder-drop-before', 'builder-drop-after'));
        row.addEventListener('drop', event => { if (!dragged || state.saving) return; event.preventDefault(); const id = dragged; dragged = null; move(id, before(event) ? asset.id : visibleMedia[index + 1]?.id); });
        list.append(row);
        growTextarea(caption);
        const matchPreviewHeight = () => { if (row.isConnected) previews.style.height = `${inputs.getBoundingClientRect().height}px`; };
        const observer = new ResizeObserver(matchPreviewHeight); observer.observe(inputs); mediaPreviewObservers.add(observer); observers.add(observer); matchPreviewHeight();
        let captionWidth = caption.getBoundingClientRect().width;
        const captionObserver = new ResizeObserver(entries => {
          const width = entries[0].contentRect.width;
          if (Math.abs(width - captionWidth) < .5) return;
          captionWidth = width; growTextarea(caption);
        });
        captionObserver.observe(caption); mediaPreviewObservers.add(captionObserver); observers.add(captionObserver);
      });
    }; renderMedia(); return section;
  }
  function createBlock(sectionId, trigger) {
    if (busy() || state.assembling || sections().find(section => section.id === sectionId).blocks.length >= 40) return;
    const entity = { id: `block-${crypto.randomUUID()}`, type: 'content', view: 'default', title: '', text: '', content: '', settings: '', media: [], review: { status: 'unreviewed', reason: '' } };
    open(entity, 'block', sectionId, trigger, 'create');
  }
  function createTab(trigger) {
    if (busy() || state.assembling || state.document.tabs.length >= 12) return;
    const entity = { id: `tab-${crypto.randomUUID()}`, title: 'Новая вкладка', review: { status: 'unreviewed', reason: '' }, blocks: [] };
    open(entity, 'tab', entity.id, trigger, 'create');
  }
  function open(entity, kind, sectionId, trigger, mode = 'edit') {
    if (busy()) return;
    ++state.request;
    const target = { kind, sectionId, id: entity.id }, draft = { jobId: state.jobId, attempt: state.attempt, revision: state.revision, mediaContext: { ...state.mediaContext }, previews: {}, frames: structuredClone(state.frames || {}), document: structuredClone(state.document), baseDocument: structuredClone(state.document), originalEntity: structuredClone(mode === 'create' ? entity : locate(target, state.document) || entity), target: structuredClone(target), mode,
      autosave: { generation: 0, savedGeneration: 0, contentGeneration: 0, blockedGeneration: null, conflict: '', timer: null, inFlight: null, allowClose: false, persisted: false, lastStored: null } };
    if (mode === 'create') {
      if (kind === 'tab') draft.document.tabs.push(structuredClone(entity));
      else sections(draft.document).find(section => section.id === sectionId).blocks.push(structuredClone(entity));
    }
    const draftEntity = locate(draft.target, draft.document); if (!draftEntity) return;
    state.target = target; state.trigger = trigger; state.draft = draft; state.modalShown = false;
    clearMediaPreviewObservers(); clear(fields); clear(reviewFooter); reviewFooter.hidden = true; formError.classList.add('d-none'); save.textContent = mode === 'delete' ? `Удалить ${kind === 'tab' ? 'вкладку' : 'блок'}` : 'Сохранить'; save.classList.toggle('btn-danger', mode === 'delete');
    save.disabled = Boolean(state.assembling); save.title = state.assembling ? ASSEMBLY_HINT : '';
    document.getElementById('page-builder-modal-title').textContent = mode === 'create' ? `Добавить ${kind === 'tab' ? 'вкладку' : 'блок'}` : `Редактировать ${kind === 'tab' ? 'вкладку' : 'блок'}`; document.getElementById('page-builder-modal-kind').textContent = kind === 'tab' ? 'Вкладка страницы' : 'Блок страницы';
    if (mode === 'delete') {
      document.getElementById('page-builder-modal-title').textContent = `Удалить ${kind === 'tab' ? 'вкладку' : 'блок'}?`;
      fields.append(node('p', '', kind === 'tab' ? `Вкладка «${draftEntity.title}» будет удалена вместе с ${draftEntity.blocks.length} блоками, изображениями и проверками.` : `Блок «${draftEntity.title}» будет удалён из раздела вместе с изображениями и проверкой.`));
      window.tabler.Modal.getOrCreateInstance(modalElement).show(trigger); return;
    }
    if (kind === 'tab') {
      const title = input('builder-title', draftEntity.title); title.maxLength = 200;
      title.addEventListener('input', () => { draftEntity.title = title.value; scheduleAutosave(true); }); fields.append(field('Название вкладки', title));
      window.tabler.Modal.getOrCreateInstance(modalElement).show(trigger); return;
    }
    blockFields(draftEntity);
    if (mode !== 'create') reviewFields(draftEntity);
    else fields.append(node('p', 'text-secondary small', 'Новый блок сохраняется со статусом «Ожидает отправки».'));
    window.tabler.Modal.getOrCreateInstance(modalElement).show(trigger);
  }
  function locate(target, document) {
    const section = target.kind === 'section' ? document.common : [document.common, ...document.tabs].find(item => item.id === target.sectionId);
    return target.kind === 'block' ? section?.blocks.find(item => item.id === target.id) : section;
  }
  let savingControls = null, savingLabel = '';
  function savingUi(busy) {
    if (busy && !savingControls) {
      savingControls = [...fields.querySelectorAll('input, textarea, select, button, [contenteditable]'), ...reviewFooter.querySelectorAll('input, textarea, select, button, [contenteditable]')].map(control => ({ control, disabled: control.disabled, contenteditable: control.getAttribute('contenteditable') }));
      savingLabel = save.textContent;
      for (const { control } of savingControls) {
        if ('disabled' in control) control.disabled = true;
        if (control.hasAttribute('contenteditable')) control.setAttribute('contenteditable', 'false');
      }
      fields.setAttribute('aria-disabled', 'true'); reviewFooter.setAttribute('aria-disabled', 'true');
      save.textContent = 'Сохранение…';
    } else if (!busy && savingControls) {
      for (const { control, disabled, contenteditable } of savingControls) {
        if ('disabled' in control) control.disabled = disabled;
        if (contenteditable === null) control.removeAttribute('contenteditable'); else control.setAttribute('contenteditable', contenteditable);
      }
      savingControls = null;
      fields.removeAttribute('aria-disabled'); reviewFooter.removeAttribute('aria-disabled');
      save.textContent = savingLabel;
    }
    save.disabled = busy || Boolean(state.assembling); save.classList.toggle('btn-loading', busy); modalElement.toggleAttribute('aria-busy', busy);
    modalElement.querySelectorAll('[data-bs-dismiss="modal"]').forEach(control => { control.disabled = busy; control.setAttribute('aria-disabled', String(busy)); });
  }
  function scheduleAutosave(contentChanged) {
    const draft = state.draft;
    if (!draft?.autosave || draft.mode === 'delete') return;
    // Во время сборки черновик не копит несохранённые правки: закрытие остаётся чистым.
    if (state.assembling) return;
    const autosave = draft.autosave; autosave.generation++;
    if (contentChanged) { draft.contentChanged = true; autosave.contentGeneration = autosave.generation; }
    window.clearTimeout(autosave.timer); autosave.timer = null;
    if (!state.picking && !autosave.conflict) autosave.timer = window.setTimeout(() => { autosave.timer = null; void drainAutosave(draft); }, 300);
  }
  function replaceDraftTarget(document, draft, entity) {
    if (draft.target.kind === 'tab') {
      const index = document.tabs.findIndex(tab => tab.id === draft.target.id);
      if (index < 0) document.tabs.push(entity); else document.tabs[index] = entity;
      return entity;
    }
    const section = sections(document).find(item => item.id === draft.target.sectionId);
    if (!section) return null;
    const index = section.blocks.findIndex(block => block.id === draft.target.id);
    if (index < 0) section.blocks.push(entity); else section.blocks[index] = entity;
    return entity;
  }
  function invalidDraft(message, control, showErrors) {
    if (showErrors) {
      formError.textContent = message; formError.classList.remove('d-none');
      control?.focus?.();
    }
    return { invalid: true };
  }
  function saveErrorMessage(error, prefix = 'Не удалось сохранить') {
    const href = /Некорректный URL \S+\.media\[(\d+)\]\.href/.exec(error.message);
    const longHref = /Некорректное поле \S+\.media\[(\d+)\]\.href/.exec(error.message);
    const itemLink = /Некорректный URL (?:common|tabs\[\d+\])\.blocks\[\d+\]\.items\[(\d+)\]\.link/.exec(error.message);
    const longItemLink = /Некорректное поле (?:common|tabs\[\d+\])\.blocks\[\d+\]\.items\[(\d+)\]\.link/.exec(error.message);
    return itemLink ? `${prefix}: ссылка ${Number(itemLink[1]) + 1}, поле «URL». Укажите полный адрес http:// или https://, ссылку mailto: или tel:, либо путь на сайте с «/». Пробелы недопустимы.`
      : longItemLink ? `${prefix}: ссылка ${Number(longItemLink[1]) + 1}, поле «URL» слишком длинное. Максимум 4096 символов.`
        : href ? `${prefix}: изображение ${Number(href[1]) + 1}, поле «Ссылка изображения». Укажите полный адрес http:// или https://, ссылку mailto: или tel:, либо путь на сайте с «/». Пробелы недопустимы.`
          : longHref ? `${prefix}: изображение ${Number(longHref[1]) + 1}, поле «Ссылка изображения» слишком длинное. Максимум 4096 символов.`
            : `${prefix}: ${error.message}`;
  }
  function prepareDraft(draft, showErrors = false) {
    const source = locate(draft.target, draft.document);
    if (!source) return invalidDraft('Редактируемый объект больше не существует.', null, showErrors);
    const next = structuredClone(draft.baseDocument), reviewStatus = document.getElementById('builder-review-status')?.value || 'unreviewed';
    const reviewReason = document.getElementById('builder-review-reason')?.value.trim() || '';
    let edited = structuredClone(source);
    if (draft.target.kind === 'tab') {
      edited.title = document.getElementById('builder-title').value.trim();
      if (!edited.title) return invalidDraft('Название не может быть пустым.', document.getElementById('builder-title'), showErrors);
      if (edited.title.length > 200) return invalidDraft('Название не может быть длиннее 200 символов.', document.getElementById('builder-title'), showErrors);
    } else if (!draft.contentChanged && draft.reviewConfirmed) {
      if (reviewStatus === 'failed' && !reviewReason) return invalidDraft('Укажите причину непройденной проверки.', document.getElementById('builder-review-reason'), showErrors);
      edited = structuredClone(draft.originalEntity); edited.review = { status: reviewStatus, reason: reviewStatus === 'failed' ? reviewReason : '' }; edited.reviewedRevision = draft.revision;
    } else {
      if (reviewStatus === 'failed' && !reviewReason) return invalidDraft('Укажите причину непройденной проверки.', document.getElementById('builder-review-reason'), showErrors);
      if (edited.type === 'rich-content') {
        if (!edited.text.trim()) return invalidDraft('Заполните поле «HTML».', document.querySelector('#builder-content .cm-content'), showErrors);
        if (edited.text.length > 12000) return invalidDraft('Поле «HTML» не может быть длиннее 12000 символов.', document.querySelector('#builder-content .cm-content'), showErrors);
        const reason = document.getElementById('builder-reason');
        if (!reason?.value.trim()) return invalidDraft('Заполните поле «Обоснование».', reason, showErrors);
      }
      edited.title = document.getElementById('builder-title').value.trim();
      edited.review = document.getElementById('builder-review-status')?.disabled && !draft.contentChanged ? structuredClone(draft.originalEntity.review) : { status: reviewStatus, reason: reviewStatus === 'failed' ? reviewReason : '' };
      if (edited.type === 'big-media') edited.media = edited.media.slice(0, 1);
      if (edited.type === 'service' || edited.type === 'content') edited.media = edited.media.slice(0, 2);
      if (edited.type === 'table') { const referenced = tableReferencedMedia(edited); edited.media = edited.media.filter(asset => referenced.has(asset.id)); }
      if (edited.type === 'rich-content' || edited.type === 'data-table') edited.media = [];
      // Links, sections and embeds render no images at all, so their legacy
      // pools (invisible in the editor) are dropped instead of failing the save.
      if (edited.type === 'links' || edited.type === 'sections' || edited.type === 'embed') edited.media = [];
      if (draft.reviewConfirmed && reviewStatus !== 'unreviewed') edited.reviewedRevision = draft.revision;
    }
    if (!replaceDraftTarget(next, draft, edited)) return invalidDraft('Раздел редактируемого объекта больше не существует.', null, showErrors);
    return { document: next, entity: edited };
  }
  function same(value, other) { return JSON.stringify(value) === JSON.stringify(other); }
  async function reconcileAutosaveConflict(draft, prepared, sentGeneration) {
    const stored = await state.api(pageUrl(draft.jobId, draft.attempt));
    if (state.draft !== draft) return { resolved: false };
    const current = locate(draft.target, stored.document), sent = locate(draft.target, prepared.document);
    if (current && sent && same(current, sent)) return { resolved: true, stored };
    const unchanged = draft.mode === 'create' ? !current : current && same(current, draft.originalEntity);
    if (!unchanged) {
      throw Object.assign(new Error('Страница обновилась в другом окне. Локальные правки оставлены в редакторе; перезагрузите страницу и сверяйте их с новой версией.'), { status: 409, persistentConflict: true });
    }
    draft.baseDocument = structuredClone(stored.document); draft.revision = stored.revision; acceptDocument(stored);
    return { resolved: false, retry: true };
  }
  function acceptAutosave(draft, stored, sentGeneration, sentContentGeneration) {
    if (state.draft !== draft) return;
    acceptDocument(stored, draft.target.kind === 'block' ? draft.target.id : null);
    draft.revision = stored.revision; draft.baseDocument = structuredClone(stored.document);
    draft.originalEntity = structuredClone(locate(draft.target, stored.document) || draft.originalEntity);
    draft.autosave.savedGeneration = Math.max(draft.autosave.savedGeneration, sentGeneration);
    draft.autosave.blockedGeneration = null; draft.autosave.persisted = true; draft.autosave.lastStored = stored;
    if (draft.autosave.contentGeneration <= sentContentGeneration) draft.contentChanged = false;
    state.mutationError = ''; formError.classList.add('d-none'); updateReviewAvailability();
  }
  async function drainAutosave(draft, showErrors = false) {
    if (state.draft !== draft || !draft.autosave) return false;
    if (state.picking) return false;
    if (state.assembling) return false;
    const autosave = draft.autosave; window.clearTimeout(autosave.timer); autosave.timer = null;
    if (autosave.conflict) {
      formError.textContent = saveErrorMessage(new Error(autosave.conflict), 'Не удалось сохранить локальные изменения'); formError.classList.remove('d-none'); live.textContent = formError.textContent;
      return false;
    }
    if (autosave.blockedGeneration === autosave.generation) return false;
    if (autosave.inFlight) { await autosave.inFlight; return autosave.savedGeneration === autosave.generation; }
    autosave.inFlight = (async () => {
      while (state.draft === draft && autosave.savedGeneration < autosave.generation) {
        const sentGeneration = autosave.generation, sentContentGeneration = autosave.contentGeneration, prepared = prepareDraft(draft, showErrors);
        if (prepared.invalid) return false;
        if (draft.mode === 'edit' && same(prepared.entity, draft.originalEntity)) { autosave.savedGeneration = sentGeneration; continue; }
        live.textContent = 'Сохранение локальных изменений…'; modalElement.setAttribute('aria-busy', 'true');
        try {
          let stored;
          try {
            stored = await state.api(pageUrl(draft.jobId, draft.attempt), { method: 'POST', body: JSON.stringify({ revision: draft.revision, document: prepared.document }) });
          } catch (error) {
            if (error.status !== 409) throw error;
            const reconciled = await reconcileAutosaveConflict(draft, prepared, sentGeneration);
            if (reconciled.resolved) stored = reconciled.stored;
            else if (reconciled.retry) continue;
            else return false;
          }
          acceptAutosave(draft, stored, sentGeneration, sentContentGeneration); live.textContent = 'Локальные изменения сохранены.';
        } catch (error) {
          if (state.draft === draft) { autosave.blockedGeneration = autosave.generation; if (error.persistentConflict) autosave.conflict = error.message; formError.textContent = saveErrorMessage(error, 'Не удалось сохранить локальные изменения'); formError.classList.remove('d-none'); live.textContent = formError.textContent; }
          return false;
        }
      }
      return state.draft === draft && autosave.savedGeneration === autosave.generation;
    })();
    try { return await autosave.inFlight; }
    finally {
      autosave.inFlight = null;
      if (state.draft === draft && !state.saving) modalElement.removeAttribute('aria-busy');
      if (state.draft === draft && autosave.savedGeneration < autosave.generation && autosave.blockedGeneration !== autosave.generation && !autosave.conflict && !autosave.timer && !state.picking) autosave.timer = window.setTimeout(() => { autosave.timer = null; void drainAutosave(draft); }, 300);
    }
  }
  async function closeAfterAutosave(draft, showErrors = false, fence = false) {
    if (fence && prepareDraft(draft, showErrors).invalid) return false;
    if (fence) { state.saving = draft; savingUi(true); }
    const saved = await drainAutosave(draft, showErrors);
    if (fence && state.saving === draft) state.saving = null;
    if (!saved || state.draft !== draft || state.picking) {
      if (state.draft === draft) { modalElement.removeAttribute('aria-busy'); savingUi(false); updateReviewAvailability(); }
      return false;
    }
    draft.autosave.allowClose = true;
    if (!state.modalShown) { draft.closeWhenShown = true; return true; }
    window.tabler.Modal.getInstance(modalElement)?.hide(); return true;
  }
  modalElement.addEventListener('hide.bs.modal', event => {
    if (state.saving || state.picking) { event.preventDefault(); return; }
    // При работающей сборке закрытие разрешено: локальные правки молча отбрасываются.
    if (state.assembling) return;
    const draft = state.draft, autosave = draft?.autosave;
    if (!autosave || autosave.allowClose) { if (autosave) autosave.allowClose = false; return; }
    if (autosave.savedGeneration < autosave.generation || autosave.inFlight) { event.preventDefault(); void closeAfterAutosave(draft, true); }
  });
  modalElement.addEventListener('hidden.bs.modal', clearMediaPreviewObservers);
  modalElement.addEventListener('shown.bs.modal', () => {
    state.modalShown = true;
    if (state.pendingSaved || state.draft?.closeWhenShown) { if (state.draft) state.draft.closeWhenShown = false; window.tabler.Modal.getInstance(modalElement).hide(); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (state.saving || state.pendingSaved || state.picking || state.assembling) return;
    formError.classList.add('d-none'); const draft = state.draft, target = draft && locate(draft.target, draft.document); if (!target) return;
    const advertised = state.pendingJob, currentJobId = advertised?.id || state.jobId;
    if (draft.jobId !== currentJobId || draft.attempt !== (advertised?.builderAttempt ?? state.attempt)) { formError.textContent = 'Страница обновилась: обработка перезапущена. Локальные правки оставлены в редакторе.'; formError.classList.remove('d-none'); return; }
    if (draft.mode === 'delete') {
      const next = structuredClone(draft.document);
      if (draft.target.kind === 'tab') next.tabs = next.tabs.filter(tab => tab.id !== draft.target.id);
      else { const section = sections(next).find(section => section.id === draft.target.sectionId); section.blocks = section.blocks.filter(block => block.id !== draft.target.id); }
      await persistDraft(draft, next); return;
    }
    if (target.type === 'data-table' && draft.contentChanged && !validateDataTableFields()) return;
    if (!draft.autosave.generation) {
      const prepared = prepareDraft(draft, true); if (prepared.invalid) return;
      if (draft.mode === 'create' || !same(prepared.entity, draft.originalEntity)) scheduleAutosave(true);
    }
    await closeAfterAutosave(draft, true, true);
  });
  async function persistDraft(draft, next) {
    state.saving = draft; savingUi(true);
    try {
      const stored = await state.api(pageUrl(draft.jobId, draft.attempt), { method: 'POST', body: JSON.stringify({ revision: draft.revision, document: next }) });
      if (state.draft !== draft || state.saving !== draft) return;
      state.pendingSaved = stored; state.saving = null; state.mutationError = '';
      if (state.modalShown) window.tabler.Modal.getInstance(modalElement).hide();
    } catch (error) {
      if (state.draft === draft && state.saving === draft) {
        formError.textContent = saveErrorMessage(error);
        formError.classList.remove('d-none');
      }
    } finally {
      if (state.saving === draft) state.saving = null;
      if (state.draft === draft && !state.pendingSaved) { savingUi(false); updateReviewAvailability(); }
    }
  }
  async function fetchAndRender(job, advertisedRevision) {
    if (busy() || state.drag) { state.pendingJob = job; return; }
    if (state.documentRead?.jobId === job.id && state.documentRead.attempt === job.builderAttempt && state.documentRead.request === state.request) return;
    const switching = !samePage(job);
    if (switching) { state.jobId = job.id; state.attempt = job.builderAttempt; state.revision = 0; state.document = null; state.sync = null; state.activeTab = null; state.mutationError = ''; renderProgress(); renderSyncNotice(); root.classList.add('d-none'); errorBox.classList.add('d-none'); loading.classList.remove('d-none'); }
    const request = ++state.request, documentRead = { jobId: job.id, attempt: job.builderAttempt, request }; state.documentRead = documentRead;
    try {
      const stored = await state.api(pageUrl(job.id, job.builderAttempt)); if (request !== state.request) return;
      if (busy() || state.drag) { state.pendingJob = job; return; }
      const sameFrames = JSON.stringify(state.frames) === JSON.stringify(stored.frames);
      state.mediaContext = stored.mediaContext;
      if (samePage(job) && state.document && state.revision === stored.revision && sameFrames) { updateSync(stored.sync); loading.classList.add('d-none'); renderMutationError(); root.classList.remove('d-none'); return; }
      state.jobId = job.id; state.attempt = job.builderAttempt; acceptDocument(stored); state.blockTypes = stored.blockTypes;
      state.blockTypes.forEach(type => { TYPE[type.name] = type.label; }); render();
      if (!advertisedRevision) await state.refresh?.();
    } catch (error) {
      if (request !== state.request || busy() || state.drag) return;
      loading.classList.add('d-none'); errorBox.textContent = [state.mutationError, `Системная ошибка шага 3: ${error.message}`].filter(Boolean).join(' '); errorBox.classList.remove('d-none');
    } finally { if (state.documentRead === documentRead) state.documentRead = null; }
  }
  modalElement.addEventListener('hidden.bs.modal', () => {
    const trigger = state.trigger, target = state.target, draft = state.draft, saved = state.pendingSaved || draft?.autosave?.lastStored, pendingJob = state.pendingJob;
    if (draft?.autosave) { window.clearTimeout(draft.autosave.timer); draft.autosave.timer = null; }
    state.target = null; state.trigger = null; state.draft = null; state.saving = null; state.pendingSaved = null; state.pendingJob = null; savingUi(false); window.ArmEditors.destroy('builder-content'); clear(fields); clear(reviewFooter); reviewFooter.hidden = true;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    window.setTimeout(async () => {
      if (state.document && renderedAssemblyLock !== Boolean(state.assembling)) render();
      if (pendingJob && !samePage(pendingJob)) { await fetchAndRender(pendingJob, Number(pendingJob.pageBuilder?.revision || 0)); await state.refresh?.(); return; }
      if (saved) {
        acceptDocument(saved, target?.kind === 'block' ? target.id : null);
        if (target?.kind === 'tab') state.activeTab = target.id;
        render(target);
        if (target?.kind === 'tab') focusTab(target.id); else focusBlock(target?.id, target?.sectionId);
        await state.refresh?.(); return;
      }
      if (pendingJob) { await fetchAndRender(pendingJob, Number(pendingJob.pageBuilder?.revision || 0)); if (target?.kind === 'tab') focusTab(target.id); else focusBlock(target?.id, target?.sectionId); }
    }, 0);
  });
  async function load(job, options) {
    const attempt = options.attempt || job.attempts.at(-1);
    job = { ...job, builderAttempt: attempt.number, pageBuilder: attempt.pageBuilder, mediaContext: { attempt: attempt.number, htmlRevision: attempt.htmlMedia?.revision || 0 } };
    state.api = options.api; state.refresh = options.refresh;
    syncAssemblyLock(attempt);
    if (state.document && !busy() && !state.drag && renderedAssemblyLock !== Boolean(state.assembling)) render();
    const revision = Number(job.pageBuilder?.revision || 0);
    const syncChanged = job.pageBuilder?.syncVersion !== state.sync?.version;
    if (samePage(job) && state.document && syncChanged && state.draft && !state.saving && !state.syncRequest) {
      const current = state.draft, generation = state.request; state.syncRequest = current;
      try {
        const stored = await state.api(pageUrl(job.id, job.builderAttempt));
        if (generation === state.request && samePage(job) && state.draft === current && stored.revision === current.revision) updateSync(stored.sync);
      } catch { /* Local editing stays available; the main polling loop retries. */ }
      finally { if (state.syncRequest === current) state.syncRequest = null; }
      if (generation !== state.request || state.draft !== current || !samePage(job)) return;
    }
    if (samePage(job) && state.document && revision === state.revision && !syncChanged && state.mediaContext?.htmlRevision === job.mediaContext.htmlRevision) { state.mediaContext = job.mediaContext; if (state.pendingJob && !samePage(state.pendingJob)) { root.classList.remove('d-none'); renderProgress(summary()); } state.pendingJob = null; return; }
    if (busy() || state.drag) { state.pendingJob = job; if (!samePage(job)) { ++state.request; root.classList.add('d-none'); renderProgress(); } return; }
    await fetchAndRender(job, revision);
  }
  window.PageBuilder = { render: load };
})();
