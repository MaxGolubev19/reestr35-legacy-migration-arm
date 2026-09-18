(() => {
  'use strict';
  const STATUS = {
    unreviewed: { label: 'Не проверено', className: 'review-unreviewed' },
    passed: { label: 'Пройдено', className: 'review-passed' },
    failed: { label: 'Не пройдено', className: 'review-failed' },
    system_error: { label: 'Системная ошибка', className: 'review-system-error' }
  };
  const TYPE = { hero: 'Баннер', text: 'Текст', buttons: 'Кнопки', image: 'Изображение', gallery: 'Галерея', table: 'Таблица', video: 'Видео' };
  const state = { jobId: null, revision: 0, document: null, activeTab: null, request: 0, api: null, refresh: null,
    target: null, trigger: null, draft: null, saving: null, pendingJob: null, pendingSaved: null };
  const root = document.getElementById('page-builder-content'), loading = document.getElementById('page-builder-loading'), errorBox = document.getElementById('page-builder-error');
  const modalElement = document.getElementById('page-builder-modal'), form = document.getElementById('page-builder-form'), fields = document.getElementById('page-builder-fields');
  const formError = document.getElementById('page-builder-form-error'), save = document.getElementById('page-builder-save');
  const progressCount = document.getElementById('builder-progress-count'), progressBar = document.getElementById('builder-progress-bar');
  const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const clear = item => item.replaceChildren();
  function mediaUrl(asset) { return `/api/page-builder/${encodeURIComponent(state.jobId)}/media/${encodeURIComponent(asset.id)}`; }
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
    const column = node('div', 'col-12'), button = node('button', `card builder-block ${STATUS[block.review.status].className}`); button.type = 'button';
    button.setAttribute('aria-label', `${block.title}. ${TYPE[block.type]}. ${STATUS[block.review.status].label}. Открыть настройки`);
    Object.assign(button.dataset, { builderKind: 'block', builderSectionId: sectionId, builderId: block.id });
    const body = node('span', 'card-body builder-block-body text-start'), top = node('span', 'd-flex align-items-start gap-2');
    const heading = node('span', 'builder-block-heading'); heading.append(node('span', 'text-secondary small', TYPE[block.type]), node('strong', 'd-block', block.title));
    top.append(heading); body.append(top, node('span', 'text-secondary builder-description', block.description));
    if (block.content) body.append(node('span', 'builder-content-preview', block.content));
    if (block.media.length) {
      const gallery = node('span', 'builder-media-preview');
      for (const asset of block.media.slice(0, 3)) { const img = node('img'); img.src = mediaUrl(asset); img.alt = asset.alt || 'Медиа'; img.loading = 'lazy'; gallery.append(img); }
      if (block.media.length > 3) gallery.append(node('span', 'builder-media-more', `+${block.media.length - 3}`)); body.append(gallery);
    }
    if (block.review.reason) body.append(node('span', 'builder-failure-reason', block.review.reason));
    button.append(body); button.addEventListener('click', () => open(block, 'block', sectionId, button)); column.append(button); return column;
  }
  function activateTab(id, focus = false) {
    state.activeTab = id; render();
    if (focus) root.querySelector(`.builder-tab[data-tab-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }
  function render() {
    clear(root); const doc = state.document, totals = summary(); renderProgress(totals);
    const common = node('section', 'builder-section'); common.setAttribute('aria-label', 'Общая часть');
    const commonGrid = node('div', 'row g-2'); doc.common.blocks.forEach(block => commonGrid.append(blockCard(block, doc.common.id))); common.append(commonGrid); root.append(common);
    const tabs = node('section', 'builder-section');
    const nav = node('div', 'builder-tabs'); nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', 'Вкладки новой страницы');
    if (!doc.tabs.some(tab => tab.id === state.activeTab)) state.activeTab = doc.tabs[0].id;
    doc.tabs.forEach((tab, tabIndex) => {
      const selected = state.activeTab === tab.id, derived = sectionReview(tab), button = node('button', `builder-tab ${selected ? 'active' : ''}`), dot = node('span', `builder-status-dot ${STATUS[derived.status].className}`);
      button.type = 'button'; button.role = 'tab'; button.id = `builder-tab-${tab.id}`; button.tabIndex = selected ? 0 : -1;
      button.setAttribute('aria-selected', String(selected)); button.setAttribute('aria-controls', `builder-panel-${tab.id}`); button.setAttribute('aria-label', `${tab.title}: ${STATUS[derived.status].label}`);
      dot.setAttribute('aria-hidden', 'true'); button.append(dot, node('span', '', tab.title)); button.dataset.tabId = tab.id;
      button.addEventListener('click', () => activateTab(tab.id, true));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? doc.tabs.length - 1 : (tabIndex + (event.key === 'ArrowRight' ? 1 : -1) + doc.tabs.length) % doc.tabs.length;
        event.preventDefault(); activateTab(doc.tabs[index].id, true);
      });
      nav.append(button);
    }); tabs.append(nav);
    doc.tabs.forEach(tab => {
      const selected = state.activeTab === tab.id, panel = node('div', 'builder-tab-panel'); panel.id = `builder-panel-${tab.id}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `builder-tab-${tab.id}`); panel.tabIndex = selected ? 0 : -1; panel.hidden = !selected;
      const grid = node('div', 'row g-2'); tab.blocks.forEach(block => grid.append(blockCard(block, tab.id))); panel.append(grid); tabs.append(panel);
    }); root.append(tabs);
    loading.classList.add('d-none'); errorBox.classList.add('d-none'); root.classList.remove('d-none');
  }
  const field = (label, control) => { const group = node('div', 'mb-3'), caption = node('label', 'form-label', label); caption.htmlFor = control.id; group.append(caption, control); return group; };
  const input = (id, value) => { const control = node('input', 'form-control'); Object.assign(control, { id, value: value || '', type: 'text' }); return control; };
  const textarea = (id, value, rows = 4) => { const control = node('textarea', 'form-control'); Object.assign(control, { id, value: value || '', rows }); return control; };
  function reviewFields(entity) {
    const status = node('select', 'form-select'); status.id = 'builder-review-status';
    for (const value of ['unreviewed', 'passed', 'failed']) { const option = node('option', '', STATUS[value].label); option.value = value; option.selected = entity.review.status === value; status.append(option); }
    const reason = textarea('builder-review-reason', entity.review.reason || '', 3); reason.placeholder = 'Обязательно для «Не пройдено»';
    const update = () => { const failed = status.value === 'failed'; reason.required = failed; reason.closest('.mb-3').classList.toggle('d-none', !failed); if (!failed) reason.value = ''; };
    fields.append(field('Принудительный статус визуальной проверки', status), field('Причина', reason)); status.addEventListener('change', update); update();
  }
  function open(entity, kind, sectionId, trigger) {
    if (state.draft || state.saving) return;
    const target = { kind, sectionId, id: entity.id }, draft = { jobId: state.jobId, revision: state.revision, document: structuredClone(state.document), target: structuredClone(target) };
    const draftEntity = locate(draft.target, draft.document); if (!draftEntity) return;
    state.target = target; state.trigger = trigger; state.draft = draft;
    clear(fields); formError.classList.add('d-none');
    document.getElementById('page-builder-modal-title').textContent = draftEntity.title; document.getElementById('page-builder-modal-kind').textContent = kind === 'block' ? TYPE[draftEntity.type] : kind === 'tab' ? 'Вкладка' : 'Общая часть';
    fields.append(field('Название', input('builder-title', draftEntity.title)));
    if (kind === 'block') {
      fields.append(field('Описание карточки', textarea('builder-description', draftEntity.description, 2)), field('Содержимое', textarea('builder-content', draftEntity.content, 6)), field('Настройки', textarea('builder-settings', draftEntity.settings, 3)));
      if (draftEntity.media.length) {
        const heading = node('h4', 'mt-4', 'Медиа из локального HTML Mori Cinema'); fields.append(heading);
        draftEntity.media.forEach((asset, index) => { const row = node('div', 'builder-media-form'); const img = node('img'); img.src = mediaUrl(asset); img.alt = asset.alt || 'Медиа'; const inputs = node('div'); const alt = input(`builder-media-alt-${index}`, asset.alt), url = input(`builder-media-url-${index}`, asset.originalUrl); url.type = 'url'; url.required = true; inputs.append(field('Alt', alt), field('URL источника', url)); row.append(img, inputs); fields.append(row); });
      }
    }
    reviewFields(draftEntity); window.tabler.Modal.getOrCreateInstance(modalElement).show(trigger);
  }
  function locate(target, document) {
    const section = target.kind === 'section' ? document.common : [document.common, ...document.tabs].find(item => item.id === target.sectionId);
    return target.kind === 'block' ? section?.blocks.find(item => item.id === target.id) : section;
  }
  function findOpener(target) {
    return [...root.querySelectorAll('[data-builder-kind]')].find(item => item.dataset.builderKind === target?.kind && item.dataset.builderSectionId === target?.sectionId && item.dataset.builderId === target?.id);
  }
  function savingUi(busy) {
    save.disabled = busy; save.classList.toggle('btn-loading', busy); modalElement.toggleAttribute('aria-busy', busy);
    modalElement.querySelectorAll('[data-bs-dismiss="modal"]').forEach(control => { control.disabled = busy; control.setAttribute('aria-disabled', String(busy)); });
  }
  modalElement.addEventListener('hide.bs.modal', event => { if (state.saving) event.preventDefault(); });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (state.saving || state.pendingSaved) return;
    formError.classList.add('d-none'); const draft = state.draft, target = draft && locate(draft.target, draft.document); if (!target) return;
    const status = document.getElementById('builder-review-status').value, reason = document.getElementById('builder-review-reason').value.trim();
    if (status === 'failed' && !reason) { formError.textContent = 'Укажите причину непройденной проверки.'; formError.classList.remove('d-none'); document.getElementById('builder-review-reason').focus(); return; }
    const next = structuredClone(draft.document), edited = locate(draft.target, next); edited.title = document.getElementById('builder-title').value.trim(); edited.review = { status, reason: status === 'failed' ? reason : '' };
    if (!edited.title) { formError.textContent = 'Название не может быть пустым.'; formError.classList.remove('d-none'); return; }
    if (draft.target.kind === 'block') {
      edited.description = document.getElementById('builder-description').value; edited.content = document.getElementById('builder-content').value; edited.settings = document.getElementById('builder-settings').value;
      edited.media.forEach((asset, index) => { asset.alt = document.getElementById(`builder-media-alt-${index}`).value; asset.originalUrl = document.getElementById(`builder-media-url-${index}`).value; });
    }
    state.saving = draft; savingUi(true);
    try {
      const stored = await state.api(`/api/page-builder/${encodeURIComponent(draft.jobId)}`, { method: 'POST', body: JSON.stringify({ revision: draft.revision, document: next }) });
      if (state.draft !== draft || state.saving !== draft) return;
      state.pendingSaved = stored; state.saving = null; window.tabler.Modal.getInstance(modalElement).hide();
    } catch (error) {
      if (state.draft === draft && state.saving === draft) { formError.textContent = `Не удалось сохранить: ${error.message}`; formError.classList.remove('d-none'); }
    } finally {
      if (state.saving === draft) state.saving = null;
      if (state.draft === draft && !state.pendingSaved) savingUi(false);
    }
  });
  async function fetchAndRender(job, advertisedRevision) {
    if (state.draft) { state.pendingJob = job; return; }
    const switching = state.jobId !== job.id;
    if (switching) { state.jobId = job.id; state.revision = 0; state.document = null; state.activeTab = null; renderProgress(); root.classList.add('d-none'); errorBox.classList.add('d-none'); loading.classList.remove('d-none'); }
    const request = ++state.request;
    try {
      const stored = await state.api(`/api/page-builder/${encodeURIComponent(job.id)}`); if (request !== state.request) return;
      if (state.draft) { state.pendingJob = job; return; }
      state.jobId = job.id; state.revision = stored.revision; state.document = stored.document; render();
      if (!advertisedRevision) await state.refresh?.();
    } catch (error) {
      if (request !== state.request || state.draft) return;
      loading.classList.add('d-none'); errorBox.textContent = `Системная ошибка шага 3: ${error.message}`; errorBox.classList.remove('d-none');
    }
  }
  modalElement.addEventListener('hidden.bs.modal', () => {
    const trigger = state.trigger, target = state.target, saved = state.pendingSaved, pendingJob = state.pendingJob;
    state.target = null; state.trigger = null; state.draft = null; state.saving = null; state.pendingSaved = null; state.pendingJob = null; savingUi(false); clear(fields);
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    window.setTimeout(async () => {
      if (saved) { state.revision = saved.revision; state.document = saved.document; render(); findOpener(target)?.focus({ preventScroll: true }); await state.refresh?.(); return; }
      if (pendingJob) { await fetchAndRender(pendingJob, Number(pendingJob.pageBuilder?.revision || 0)); findOpener(target)?.focus({ preventScroll: true }); }
    }, 0);
  });
  async function load(job, options) {
    state.api = options.api; state.refresh = options.refresh; const revision = Number(job.pageBuilder?.revision || 0);
    if (state.jobId === job.id && state.document && revision === state.revision) return;
    if (state.draft) { state.pendingJob = job; return; }
    await fetchAndRender(job, revision);
  }
  window.PageBuilder = { render: load };
})();
