(() => {
  'use strict';
  let key = '', generation = 0, modalGeneration = 0, modalTrigger, renderContext = '';
  const sectionState = new Map();
  let modalImages = [], modalImageIndex = 0;
  const $ = id => document.getElementById(id);
  function node(tag, text, css) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (css) element.className = css; return element; }
  function button(text, action, css = 'btn btn-outline-primary') { const element = node('button', text, css); element.type = 'button'; element.addEventListener('click', () => action(element)); return element; }
  function link(text, url) { const element = node('a', text, 'btn btn-outline-secondary'); element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer'; return element; }
  function embedFrame(item, preview = false) {
    const frame = node('iframe');
    const policy = window.ArmEmbedPolicy.inspect(item.resolvedUrl, location.origin);
    if (!policy.allowed || !('credentialless' in frame)) {
      const fallback = node('div', policy.allowed ? 'Браузер не поддерживает изолированное встраивание' : policy.reason, 'alert alert-warning mb-0');
      fallback.setAttribute('role', 'status'); return fallback;
    }
    frame.title = `${preview ? 'Превью' : 'Встраивание'} ${item.originalUrl}`;
    // Players need their own origin for storage and same-origin API requests.
    // Credentialless gives them ephemeral storage, never the user's cookies.
    frame.credentialless = true;
    frame.setAttribute('sandbox', 'allow-scripts allow-presentation allow-same-origin');
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.className = preview ? 'media-frame-preview' : 'media-full-frame';
    if (preview) { frame.loading = 'lazy'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true'); }
    else frame.allowFullscreen = true;
    frame.src = policy.url;
    return frame;
  }
  function galleryTile(gallery, tile) {
    const column = node('div', undefined, 'col-12 col-md-6 col-xxl-4'), card = node('div', undefined, 'card image-card h-100');
    card.append(tile); column.append(card); gallery.append(column); return card;
  }
  function sourceFrames(root) {
    const frames = [];
    function visit(node) {
      if (node.localName === 'iframe' && node.hasAttribute('src')) frames.push(node);
      for (const child of node.childNodes || []) visit(child);
      if (node.content) visit(node.content);
    }
    visit(root); return frames;
  }
  function accordionSection(id, title, content, count) {
    const item = node('details', undefined, 'accordion-item html-media-section'), stateKey = `${renderContext}:${id}`;
    item.open = sectionState.get(stateKey) ?? false;
    const heading = node('summary', undefined, `accordion-button${item.open ? '' : ' collapsed'}`);
    heading.append(node('span', title), node('span', String(count), 'badge bg-secondary-lt'));
    const body = node('div', undefined, 'accordion-body'); body.append(content); item.append(heading, body);
    item.addEventListener('toggle', () => { sectionState.set(stateKey, item.open); heading.classList.toggle('collapsed', !item.open); });
    return item;
  }
  async function json(url) { const response = await fetch(url, { cache: 'no-store' }); const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; }
  function showModal(title, content, trigger) {
    window.ArmEditors.destroy('media-modal-body'); modalImages = []; $('media-counter').textContent = ''; $('media-navigation').classList.add('d-none');
    $('media-modal-body').classList.remove('gallery-viewport'); $('media-modal-title').removeAttribute('title');
    modalGeneration++; modalTrigger = { element: trigger, context: renderContext, identity: trigger.dataset.mediaTrigger }; $('media-modal-title').textContent = title; $('media-modal-body').replaceChildren(content);
    window.ModalActions.set('media-modal', null);
    window.tabler.Modal.getOrCreateInstance($('media-modal')).show(); return modalGeneration;
  }
  $('media-modal').addEventListener('hidden.bs.modal', () => {
    window.ArmEditors.destroy('media-modal-body'); modalImages = []; $('media-modal-body').replaceChildren();
    modalGeneration++; const trigger = modalTrigger; modalTrigger = null;
    if (!trigger || trigger.context !== renderContext) return;
    // Checkpoint polling replaces cards. Match the exact attempt/revision and
    // occurrence, not just its URL (different resources can share one object).
    const current = trigger.element?.isConnected ? trigger.element : [...$('html-media-content').querySelectorAll('button[data-media-trigger]')].find(candidate => candidate.dataset.mediaTrigger === trigger.identity);
    if (current && !current.disabled && current.getAttribute('aria-disabled') !== 'true' && current.checkVisibility({ checkVisibilityCSS: true })) current.focus({ preventScroll: true });
  });
  function showImage(index) {
    if (index < 0 || index >= modalImages.length) return; modalImageIndex = index;
    const item = modalImages[index], full = node('img'); full.src = item.url; full.alt = item.originalUrl; full.className = 'media-full-image';
    $('media-modal-title').textContent = item.originalUrl; $('media-modal-title').title = item.originalUrl; $('media-modal-body').replaceChildren(full);
    $('media-modal-body').classList.add('gallery-viewport'); $('media-modal-body').scrollTo(0, 0);
    $('media-counter').textContent = `${index + 1} / ${modalImages.length}`; $('media-navigation').classList.remove('d-none');
    $('media-prev').disabled = index === 0; $('media-next').disabled = index === modalImages.length - 1;
    window.ModalActions.set('media-modal', { url: item.url, name: new URL(item.resolvedUrl).pathname.split('/').pop() || 'image', image: true });
    if (document.activeElement?.disabled) $('media-modal').focus({ preventScroll: true });
  }
  $('media-prev').addEventListener('click', () => showImage(modalImageIndex - 1)); $('media-next').addEventListener('click', () => showImage(modalImageIndex + 1));
  document.addEventListener('keydown', event => { if (modalImages.length && $('media-modal').classList.contains('show') && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); showImage(modalImageIndex + (event.key === 'ArrowRight' ? 1 : -1)); } });
  async function render(job, attempt, options) {
    const container = $('html-media-content'), info = attempt?.htmlMedia;
    const next = JSON.stringify([job?.id, attempt?.number, attempt?.status, info, attempt?.error, job?.canResume, job?.canPause]);
    if (next === key) return; key = next; const version = ++generation; renderContext = JSON.stringify([job?.id, attempt?.number, info?.revision || 0]); container.replaceChildren();
    window.ModalActions.clearExternal('media-modal');
    if (!job || !attempt) { $('media-progress').classList.add('d-none'); return; }
    const base = `/api/html-media/${job.id}/${attempt.number}`, revision = info?.revision || 0, prefix = `${base}/${revision}/`;
    const controls = node('div', undefined, 'd-flex flex-wrap gap-2 mb-3');
    const alert = node('div', info?.error || attempt.error || '', 'alert alert-danger'); if (!alert.textContent) alert.classList.add('d-none');
    const error = message => { alert.textContent = message; alert.classList.remove('d-none'); };
    const current = job.attempts.at(-1)?.number === attempt.number;
    const input = node('input'); input.type = 'file'; input.accept = '.html,.htm,text/html'; input.hidden = true;
    const canUpload = current && ['paused','complete','interrupted'].includes(attempt.status) && !job.isActive;
    let sourceFailed = !revision || !!info?.error || !!attempt.error;
    input.addEventListener('change', async () => {
      const file = input.files[0]; if (!file) return;
      if (file.size > 8 * 1024 * 1024) return error('HTML превышает лимит 8 MiB');
      card.disabled = true;
      try {
        const response = await fetch(`${base}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-csrf-token': options.csrfToken, 'x-html-revision': String(revision) }, body: file });
        const value = await response.json(); if (!response.ok) throw new Error(value.error); await options.refresh();
      } catch (failure) { error(failure.message); card.disabled = !canUpload; }
    });
    const card = button(sourceFailed ? 'HTML не найден — выбрать файл' : `HTML · ${(info.source.bytes / 1024).toFixed(1)} KiB`, async trigger => {
      if (sourceFailed) { if (canUpload) input.click(); return; }
      const serial = showModal('Исходный HTML', node('p', 'Загрузка…'), trigger);
      try { const value = await json(prefix + 'code'); if (serial === modalGeneration && await window.ArmEditors.showHtml('media-modal-body', value.text) && serial === modalGeneration) window.ModalActions.set('media-modal', { url: prefix + 'source', name: 'source.html', text: () => window.ArmEditors.text('media-modal-body') }); }
      catch (failure) { sourceFailed = true; card.textContent = 'HTML недоступен — выбрать файл'; card.disabled = !canUpload; if (serial === modalGeneration) $('media-modal-body').replaceChildren(node('p', failure.message, 'alert alert-danger')); }
    }, 'btn btn-outline-primary html-source-card');
    card.dataset.mediaTrigger = JSON.stringify([job.id, attempt.number, revision, 'source']);
    if (sourceFailed) card.disabled = !canUpload;
    controls.append(card, input);
    container.append(controls, alert);
    if (!revision) { $('media-progress').classList.add('d-none'); return; }
    const total = Math.max(0, Number(info.total) || 0), pending = Math.max(0, Number(info.pending) || 0);
    const processed = Math.min(total, Math.max(0, total - pending));
    const percent = total ? Math.min(100, Math.round(processed / total * 100)) : 0;
    $('media-progress').classList.toggle('d-none', total === 0);
    $('media-progress-count').textContent = `${processed}/${total}`;
    $('media-progress-bar').style.width = `${percent}%`;
    const progress = $('media-progress-bar').parentElement;
    progress.setAttribute('aria-valuenow', String(percent)); progress.setAttribute('aria-label', `Обработано ${processed} из ${total} ресурсов`);
    try {
      const manifest = await json(prefix + 'manifest'); if (version !== generation) return;
      const gallery = node('div', undefined, 'row g-3 mb-3'), documents = node('ul', undefined, 'media-items'), external = node('div', undefined, 'row g-3 mb-3'), issues = node('ul', undefined, 'media-items');
      const raster = item => ['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp'].includes(item.detectedMime || item.mime);
      const images = manifest.resources.filter(item => item.status === 'downloaded' && raster(item)).map(item => ({ ...item, url: prefix + item.object }));
      for (const item of manifest.resources) {
        if (item.status === 'downloaded') {
          const url = prefix + item.object;
          if (raster(item)) {
            const image = node('img'); image.src = url; image.alt = item.originalUrl; image.loading = 'lazy'; image.className = 'gallery-thumb w-100';
            const tile = button('', trigger => { showModal(item.originalUrl, node('span'), trigger); modalImages = images; showImage(images.findIndex(candidate => candidate.id === item.id)); }, 'btn w-100'); tile.setAttribute('aria-label', `Открыть изображение ${item.originalUrl}`); tile.append(image);
            tile.dataset.mediaTrigger = JSON.stringify([job.id, attempt.number, revision, 'image', item.id, item.object, item.originalUrl]);
            galleryTile(gallery, tile);
          } else { const li = node('li'); li.append(link(`${item.originalUrl} · ${item.mime} · ${item.bytes} B`, url)); documents.append(li); }
        } else if (item.status === 'external' && item.occurrence?.tag === 'iframe') {
          const tile = button('', async trigger => {
            const externalUrl = window.ArmEmbedPolicy.inspect(item.resolvedUrl, location.origin).url;
            const serial = showModal(item.originalUrl, embedFrame(item), trigger);
            window.ModalActions.set('media-modal', { copy: false, download: false, externalUrl });
            try {
              const source = await json(prefix + 'code');
              // Read the corresponding occurrence from preserved source, including
              // legacy revisions. Never insert imported HTML into the app DOM.
              const parsed = new DOMParser().parseFromString(source.text, 'text/html');
              const matches = sourceFrames(parsed).filter(frame => frame.getAttribute('src') === item.originalUrl);
              const ordinal = manifest.resources.filter(candidate => candidate.id < item.id && candidate.occurrence?.tag === 'iframe' && candidate.occurrence.attribute === 'src' && candidate.originalUrl === item.originalUrl).length;
              const code = matches[ordinal]?.outerHTML;
              if (!code) throw new Error('Исходный iframe не найден');
              if (serial === modalGeneration) window.ModalActions.set('media-modal', { text: () => code, download: false, externalUrl: version === generation ? externalUrl : undefined });
            } catch (failure) { if (serial === modalGeneration) { const message = node('p', `Не удалось подготовить iframe для копирования: ${failure.message}`, 'alert alert-danger'); message.setAttribute('role', 'alert'); $('media-modal-body').append(message); } }
          }, 'btn w-100 media-frame-tile');
          tile.setAttribute('aria-label', `Открыть iframe ${item.originalUrl}`);
          tile.dataset.mediaTrigger = JSON.stringify([job.id, attempt.number, revision, 'iframe', item.id]);
          const preview = node('span', undefined, 'gallery-thumb media-frame-viewport'); preview.append(embedFrame(item, true)); tile.append(preview);
          galleryTile(external, tile);
        } else if (item.status === 'external') { const entry = node('div', undefined, 'col-12'); entry.append(link(item.originalUrl, item.resolvedUrl)); external.append(entry); }
        else if (['failed','unsupported'].includes(item.status)) issues.append(node('li', `${item.status}: ${item.originalUrl} — ${item.error || 'Статическая обработка не поддерживается'}`));
      }
      const accordion = node('div', undefined, 'accordion html-media-accordion'); accordion.id = 'html-media-accordion';
      const sections = [
        ['images', 'Изображения', gallery],
        ['documents', 'Документы и медиа', documents],
        ['external', 'Внешние встраивания', external],
        ['issues', 'Ошибки и неподдерживаемые ресурсы', issues]
      ];
      for (const [id, title, content] of sections) if (content.childElementCount) accordion.append(accordionSection(id, title, content, content.childElementCount));
      if (accordion.childElementCount) container.append(accordion);
    } catch (failure) {
      if (version === generation) {
        // The same snapshot may arrive on the next poll. Retry it after a
        // transient failure, while the generation guard keeps old responses out.
        key = '';
        error(failure.message);
      }
    }
  }
  window.HtmlMedia = { render };
})();
