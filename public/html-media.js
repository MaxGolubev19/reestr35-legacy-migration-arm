(() => {
  'use strict';
  let key = '', generation = 0, modalGeneration = 0, modalTrigger, renderContext = '';
  const sectionState = new Map();
  let modalImages = [], modalImageIndex = 0;
  const $ = id => document.getElementById(id);
  function node(tag, text, css) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (css) element.className = css; return element; }
  function button(text, action, css = 'btn btn-outline-primary') { const element = node('button', text, css); element.type = 'button'; element.addEventListener('click', () => action(element)); return element; }
  function link(text, url) { const element = node('a', text, 'btn btn-outline-secondary'); element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer'; return element; }
  const embedFrame = (item, preview = false) => window.ArmEmbedPolicy.createFrame(item, { preview });
  function galleryTile(gallery, tile) {
    const column = node('div', undefined, 'col-12 col-md-6 col-xxl-4'), card = node('div', undefined, 'card image-card h-100');
    card.append(tile); column.append(card); gallery.append(column); return card;
  }
  function documentName(item) {
    const safe = value => {
      if (typeof value !== 'string') return '';
      const name = value.trim();
      return name && new TextEncoder().encode(name).length <= 240 && !/[\p{Cc}\p{Cf}\p{Cs}<>:"/\\|?*]/u.test(value) && !/^\.|[. ]$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ? name : '';
    };
    const supplied = safe(item.occurrence?.downloadFilename);
    if (supplied) return supplied;
    for (const address of [item.resolvedUrl, item.originalUrl]) {
      try {
        const segment = new URL(address).pathname.split('/').pop();
        const name = safe(decodeURIComponent(segment || ''));
        if (name) return name;
      } catch { /* A malformed URL or escape falls through to the next source. */ }
    }
    const known = {
      'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/rtf': 'rtf', 'text/rtf': 'rtf',
      'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/gzip': 'gz',
      'application/vnd.rar': 'rar', 'application/x-7z-compressed': '7z', 'application/x-tar': 'tar',
      'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'video/ogg': 'ogg',
      'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'video/webm': 'webm', 'audio/webm': 'webm', 'video/quicktime': 'mov',
      'image/svg+xml': 'svg', 'image/tiff': 'tiff', 'image/vnd.microsoft.icon': 'ico'
    };
    const mime = String(item.detectedMime || item.mime || '').toLowerCase().split(';')[0];
    return `Файл${known[mime] ? `.${known[mime]}` : ''}`;
  }
  function documentKind(item, name) {
    const mime = String(item.detectedMime || item.mime || '').toLowerCase().split(';')[0];
    const extension = name.match(/\.([a-z\d]{1,10})$/i)?.[1].toLowerCase() || '';
    const known = { pdf: 'document', doc: 'document', docx: 'document', odt: 'document', txt: 'document', rtf: 'document', xls: 'document', xlsx: 'document', csv: 'document', ppt: 'document', pptx: 'document', zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio', mp4: 'video', webm: 'video', mov: 'video', avi: 'video', svg: 'graphic', tif: 'graphic', tiff: 'graphic', ico: 'graphic' };
    const byMime = {
      'application/pdf': ['document', 'PDF'], 'application/msword': ['document', 'DOC'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['document', 'DOCX'],
      'application/vnd.ms-excel': ['document', 'XLS'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['document', 'XLSX'],
      'application/vnd.ms-powerpoint': ['document', 'PPT'], 'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['document', 'PPTX'],
      'application/rtf': ['document', 'RTF'], 'text/rtf': ['document', 'RTF'], 'text/plain': ['document', 'TXT'], 'text/csv': ['document', 'CSV'],
      'application/zip': ['archive', 'ZIP'], 'application/x-zip-compressed': ['archive', 'ZIP'], 'application/gzip': ['archive', 'GZ'],
      'application/vnd.rar': ['archive', 'RAR'], 'application/x-rar-compressed': ['archive', 'RAR'],
      'application/x-7z-compressed': ['archive', '7Z'], 'application/x-tar': ['archive', 'TAR'],
      'audio/mpeg': ['audio', 'MP3'], 'audio/wav': ['audio', 'WAV'], 'audio/ogg': ['audio', 'OGG'], 'audio/mp4': ['audio', 'M4A'],
      'video/mp4': ['video', 'MP4'], 'video/webm': ['video', 'WEBM'], 'video/ogg': ['video', 'OGG'], 'video/quicktime': ['video', 'MOV'],
      'image/svg+xml': ['graphic', 'SVG'], 'image/tiff': ['graphic', 'TIFF'], 'image/vnd.microsoft.icon': ['graphic', 'ICO'], 'image/x-icon': ['graphic', 'ICO']
    };
    const specific = byMime[mime] || (mime.startsWith('audio/') ? ['audio', 'Аудио'] : mime.startsWith('video/') ? ['video', 'Видео'] : mime.startsWith('image/') ? ['graphic', 'Изображение'] : mime.startsWith('text/') ? ['document', 'Текст'] : null);
    return specific ? { kind: specific[0], format: specific[1] } : { kind: known[extension] || 'other', format: extension ? extension.toUpperCase() : 'Тип неизвестен' };
  }
  function documentIcon(kind) {
    const paths = {
      document: ['M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M14 3v6h5', 'M9 13h6', 'M9 17h6'],
      archive: ['M5 3h14v18H5z', 'M10 3v3', 'M14 6v3', 'M10 9v3', 'M14 12v3', 'M10 15v4h4v-4z'],
      audio: ['M9 18V6l11-2v12', 'M9 18a3 2 0 1 1-6 0a3 2 0 0 1 6 0Z', 'M20 16a3 2 0 1 1-6 0a3 2 0 0 1 6 0Z'],
      video: ['M4 5h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'm19 9 3-2v10l-3-2', 'm8 9 5 3-5 3z'],
      graphic: ['M4 4h16v16H4z', 'M8 9a1 1 0 1 0 2 0a1 1 0 0 0-2 0Z', 'm5 17 4-5 5 5'],
      other: ['M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M14 3v6h5', 'M10 15h4']
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    for (const data of paths[kind]) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', data); svg.append(path); }
    return svg;
  }
  function trashIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6'); svg.append(path); return svg;
  }
  function documentTile(gallery, item, url, onDelete) {
    const name = documentName(item), { kind, format } = documentKind(item, name);
    const column = node('div', undefined, 'col-12 col-md-6 col-xxl-4 media-document-column'), card = node('a', undefined, 'card media-document-card h-100');
    card.href = url; card.setAttribute('aria-label', `Скачать файл ${name}, ресурс ${item.id}`);
    const icon = node('div', undefined, `media-document-icon media-document-${kind}`); icon.append(documentIcon(kind));
    const details = node('div', undefined, 'media-document-details');
    const title = node('div', name, 'media-document-name'); title.title = name;
    const meta = node('div', undefined, 'media-document-meta'); meta.append(node('span', format, 'badge bg-secondary-lt'));
    if (Number.isFinite(item.bytes) && item.bytes >= 0) meta.append(node('span', item.bytes > 0 && item.bytes < 5000 ? '< 0,01 МБ' : `${(item.bytes / 1000000).toFixed(2).replace('.', ',')} МБ`));
    details.append(title, meta); card.append(icon, details); column.append(card);
    const remove = node('button', undefined, 'btn btn-icon btn-sm media-document-delete'); remove.type = 'button'; remove.title = `Удалить ${name}`; remove.setAttribute('aria-label', `Удалить файл ${name}`); remove.append(trashIcon()); remove.addEventListener('click', () => onDelete(remove));
    column.append(remove); gallery.append(column);
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
  const deletionOpen = () => !!document.querySelector('.media-delete-confirm[open]');
  $('media-modal').addEventListener('hide.bs.modal', event => { if (deletionOpen()) event.preventDefault(); });
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
    if (deletionOpen() || index < 0 || index >= modalImages.length) return; modalImageIndex = index;
    const item = modalImages[index], full = node('img'); full.src = item.url; full.alt = item.originalUrl; full.className = 'media-full-image';
    $('media-modal-title').textContent = item.originalUrl; $('media-modal-title').title = item.originalUrl; $('media-modal-body').replaceChildren(full);
    $('media-modal-body').classList.add('gallery-viewport'); $('media-modal-body').scrollTo(0, 0);
    $('media-counter').textContent = `${index + 1} / ${modalImages.length}`; $('media-navigation').classList.remove('d-none');
    $('media-prev').disabled = index === 0; $('media-next').disabled = index === modalImages.length - 1;
    const name = item.manual && item.occurrence?.downloadFilename || new URL(item.resolvedUrl, location.origin).pathname.split('/').pop() || 'image';
    window.ModalActions.set('media-modal', { url: item.url, name, image: true, delete: item.delete });
    if (document.activeElement?.disabled) $('media-modal').focus({ preventScroll: true });
  }
  $('media-prev').addEventListener('click', () => showImage(modalImageIndex - 1)); $('media-next').addEventListener('click', () => showImage(modalImageIndex + 1));
  document.addEventListener('keydown', event => { if (!deletionOpen() && modalImages.length && $('media-modal').classList.contains('show') && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); showImage(modalImageIndex + (event.key === 'ArrowRight' ? 1 : -1)); } });
  async function render(job, attempt, options) {
    const container = $('html-media-content'), info = attempt?.htmlMedia;
    const next = JSON.stringify([job?.id, attempt?.number, attempt?.status, info, attempt?.pageBuilder?.revision, attempt?.error, job?.canResume, job?.canPause]);
    if (next === key) return; key = next; const version = ++generation; renderContext = JSON.stringify([job?.id, attempt?.number, info?.revision || 0]); container.replaceChildren();
    window.ModalActions.clearExternal('media-modal');
    if (!job || !attempt) { $('media-progress').classList.add('d-none'); return; }
    const base = `/api/html-media/${job.id}/${attempt.number}`, revision = info?.revision || 0, prefix = `${base}/${revision}/`;
    const controls = node('div', undefined, 'd-flex flex-wrap gap-2 mb-3');
    const alert = node('div', info?.error || attempt.error || '', 'alert alert-danger'); if (!alert.textContent) alert.classList.add('d-none');
    const error = message => { alert.textContent = message; alert.classList.remove('d-none'); };
    async function confirmDeletion(item, trigger, inModal) {
      if (document.querySelector('.media-delete-confirm[open]')) return;
      const request = { checkpoint: info?.checkpoint || 0, revision: attempt.pageBuilder?.revision || 0, resourceId: item.id };
      const dialog = node('dialog', undefined, 'media-delete-confirm'), panel = node('div', undefined, 'media-delete-panel');
      const title = node('h3', 'Удалить ресурс?', 'h3 mb-2'), message = node('p', 'Проверка связей с новой страницей…', 'mb-3');
      const warning = node('div', '', 'alert alert-danger d-none'); warning.setAttribute('role', 'alert');
      const controls = node('div', undefined, 'd-flex justify-content-end gap-2'), cancel = node('button', 'Отмена', 'btn btn-outline-secondary'), remove = node('button', 'Удалить', 'btn btn-danger');
      cancel.type = remove.type = 'button'; remove.disabled = true; controls.append(cancel, remove); panel.append(title, message, warning, controls); dialog.append(panel); document.body.append(dialog);
      let completed = false;
      dialog.addEventListener('close', () => { dialog.remove(); if (!completed && trigger.isConnected) trigger.focus({ preventScroll: true }); }, { once: true });
      cancel.addEventListener('click', () => dialog.close()); dialog.showModal(); cancel.focus();
      try {
        const impact = await json(`${prefix}delete-impact?${new URLSearchParams(request)}`);
        if (!dialog.open) return;
        message.textContent = impact.used ? 'Ресурс используется в блоках новой страницы. Он будет удалён и из этих блоков.' : 'Ресурс будет удалён из списка ресурсов страницы.';
        remove.disabled = false;
      } catch (failure) { if (dialog.open) { warning.textContent = failure.message; warning.classList.remove('d-none'); message.textContent = 'Удаление недоступно.'; } }
      remove.addEventListener('click', async () => {
        remove.disabled = cancel.disabled = true; warning.classList.add('d-none');
        try {
          const response = await fetch(`${prefix}delete`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': options.csrfToken }, body: JSON.stringify(request) });
          const value = await response.json(); if (!response.ok) throw new Error(value.error);
          completed = true; dialog.close();
          if (inModal) { modalTrigger = null; modalImages = []; modalGeneration++; window.tabler.Modal.getOrCreateInstance($('media-modal')).hide(); }
          key = ''; await options.refresh(); $('html-media-content').querySelector('.html-source-card')?.focus({ preventScroll: true });
        } catch (failure) {
          if (completed) error(`Ресурс удалён. Обновите страницу: ${failure.message}`);
          else { warning.textContent = failure.message; warning.classList.remove('d-none'); remove.disabled = cancel.disabled = false; }
        }
      });
    }
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
      const gallery = node('div', undefined, 'row g-3 mb-3'), documents = node('div', undefined, 'row g-3 mb-3'), external = node('div', undefined, 'row g-3 mb-3'), issues = node('ul', undefined, 'media-items');
      const raster = item => ['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp'].includes(item.detectedMime || item.mime);
      const images = manifest.resources.filter(item => item.status === 'downloaded' && raster(item)).map(item => ({ ...item, url: prefix + item.object, delete: trigger => confirmDeletion(item, trigger, true) }));
      for (const item of manifest.resources) {
        if (item.status === 'downloaded') {
          const url = prefix + item.object;
          if (raster(item)) {
            const image = node('img'); image.src = url; image.alt = item.originalUrl; image.loading = 'lazy'; image.className = 'gallery-thumb w-100';
            const tile = button('', trigger => { showModal(item.originalUrl, node('span'), trigger); modalImages = images; showImage(images.findIndex(candidate => candidate.id === item.id)); }, 'btn w-100'); tile.setAttribute('aria-label', `Открыть изображение ${item.originalUrl}`); tile.append(image);
            tile.dataset.mediaTrigger = JSON.stringify([job.id, attempt.number, revision, 'image', item.id, item.object, item.originalUrl]);
            galleryTile(gallery, tile);
          } else documentTile(documents, item, `${url}?resourceId=${encodeURIComponent(item.id)}`, trigger => confirmDeletion(item, trigger, false));
        } else if (item.status === 'external' && item.occurrence?.tag === 'iframe') {
          const tile = button('', async trigger => {
            const externalUrl = window.ArmEmbedPolicy.inspect(item.resolvedUrl, location.origin).url;
            const serial = showModal(item.originalUrl, embedFrame(item), trigger);
            const remove = button => confirmDeletion(item, button, true);
            window.ModalActions.set('media-modal', { copy: false, download: false, externalUrl, delete: remove });
            try {
              let code = item.manual && item.snippet;
              if (!code) {
                const source = await json(prefix + 'code');
                // Read the corresponding occurrence from preserved source, including
                // legacy revisions. Never insert imported HTML into the app DOM.
                const parsed = new DOMParser().parseFromString(source.text, 'text/html');
                const matches = sourceFrames(parsed).filter(frame => frame.getAttribute('src') === item.originalUrl);
                const ordinal = manifest.resources.filter(candidate => candidate.id < item.id && !candidate.manual && candidate.occurrence?.tag === 'iframe' && candidate.occurrence.attribute === 'src' && candidate.originalUrl === item.originalUrl).length;
                code = matches[ordinal]?.outerHTML;
              }
              if (!code) throw new Error('Исходный iframe не найден');
              if (serial === modalGeneration) window.ModalActions.set('media-modal', { text: () => code, download: false, externalUrl: version === generation ? externalUrl : undefined, delete: remove });
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
