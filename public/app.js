(() => {
  "use strict";

  const POLL_INTERVAL_MS = 1500;
  const ACTIVE_STATUSES = new Set(["running", "validating", "stopping"]);
  const TERMINAL_STATUSES = new Set(["complete", "needs_review", "incomplete", "failed", "cancelled", "interrupted"]);
  // These are the current-attempt outcomes for which the queue already shows a
  // red retry action. A user cancellation is intentional, so it is not an error.
  const ERROR_STATUSES = new Set(["needs_review", "incomplete", "failed", "interrupted"]);
  const STATUS_LABELS = {
    paused: "На паузе",
    queued: "В очереди",
    running: "Выполняется",
    validating: "Проверяется",
    stopping: "Останавливается",
    complete: "Готово",
    needs_review: "Нужна проверка",
    incomplete: "Неполный результат",
    failed: "Ошибка",
    cancelled: "Отменено",
    interrupted: "Прервано"
  };
  const STATUS_CLASSES = {
    paused: "bg-secondary-lt",
    queued: "bg-blue-lt",
    running: "bg-blue-lt",
    validating: "bg-azure-lt",
    stopping: "bg-yellow-lt",
    complete: "bg-green-lt",
    needs_review: "bg-yellow-lt",
    incomplete: "bg-orange-lt",
    failed: "bg-red-lt",
    cancelled: "bg-secondary-lt",
    interrupted: "bg-red-lt"
  };

  const state = {
    csrfToken: "",
    concurrency: 2,
    settingsPending: false,
    settingsDesired: null,
    jsonRequest: 0,
    jsonController: null,
    jsonTrigger: null,
    jobs: [],
    selectedJobId: null,
    selectedAttemptNumber: null,
    logsKey: null,
    pollTimer: null,
    stopped: false,
    jobsFingerprint: null,
    galleryKey: null,
    galleryFingerprint: null,
    gallery: [],
    galleryIndex: 0,
    galleryTrigger: null,
    eventSource: null,
    refreshPromise: null,
    refreshQueued: false,
    submitting: false,
    pendingActions: new Set()
  };

  const el = Object.fromEntries([
    "connection-dot", "connection-label", "concurrency-value", "global-alert",
    "batch-form", "url-input", "clear-url", "url-feedback", "submit-button", "batch-result", "progress-label",
    "progress-bar", "jobs-body", "empty-detail", "concurrency-slider", "settings-error",
    "job-detail", "detail-title", "detail-url", "attempt-duration", "detail-id",
    "detail-status", "detail-created", "attempt-select", "attempt-meta", "files-list",
    "summary-output", "issues-output", "logs-card", "stdout-output",
    "stderr-output", "stdout-truncated", "stderr-truncated", "png-gallery",
    "gallery-message", "qa-progress", "qa-progress-count", "qa-progress-bar",
    "png-modal", "png-modal-title", "png-counter", "png-status",
    "png-full", "png-error", "png-prev", "png-next", "png-original",
    "json-modal", "json-modal-title", "json-output", "json-error", "json-original"
  ].map((id) => [id, document.getElementById(id)]));

  function setConnection(connected, message) {
    el["connection-label"].textContent = message;
    el["connection-dot"].className = `status-dot ${connected ? "bg-green" : "status-dot-animated bg-red"}`;
  }

  function showGlobalError(message) {
    el["global-alert"].textContent = message;
    el["global-alert"].classList.toggle("d-none", !message);
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ru-RU");
  }

  function formatValue(value, empty = "Нет данных") {
    if (value === null || value === undefined || value === "") return empty;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch (_error) {
      return String(value);
    }
  }

  function currentAttempt(job) {
    const attempts = Array.isArray(job.attempts) ? job.attempts : [];
    return attempts.length ? attempts[attempts.length - 1] : null;
  }

  function effectiveStatus(job) {
    const attempt = currentAttempt(job);
    return String(job.status || (attempt && attempt.status) || "unknown").toLowerCase();
  }

  function renderFavicon() {
    const icon = document.getElementById("dynamic-favicon");
    if (!icon) return;
    // canStop comes from the server's live child-process map and decides whether
    // the blue state is active. Its number is the current workload: each live or
    // queued job once, including the unlikely overlap of both signals.
    const active = state.jobs.some((job) => job.canStop === true);
    const workload = state.jobs.filter((job) => job.canStop === true || effectiveStatus(job) === "queued").length;
    const errors = state.jobs.filter((job) => ERROR_STATUSES.has(effectiveStatus(job))).length;
    const pausedOrCancelled = state.jobs.filter((job) => ["paused", "cancelled"].includes(effectiveStatus(job))).length;
    const count = active ? workload : errors || pausedOrCancelled;
    const color = active ? "#206bc4" : errors ? "#d63939" : pausedOrCancelled ? "#626976" : "#2fb344";
    const label = count ? String(count) : "";
    const fontSize = label.length <= 2 ? 18 : label.length === 3 ? 14 : label.length === 4 ? 10 : label.length === 5 ? 8 : label.length === 6 ? 7 : 6;
    const mark = count
      ? `<text x="16" y="21" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="700">${label}</text>`
      : '<path d="M9 16.5l4.5 4.5L23 11" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="${color}"/>${mark}</svg>`;
    icon.setAttribute("href", `data:image/svg+xml,${encodeURIComponent(svg)}`);
  }

  function badge(status) {
    const normalized = String(status || "unknown").toLowerCase();
    const span = document.createElement("span");
    span.className = `badge ${STATUS_CLASSES[normalized] || "bg-secondary-lt"}`;
    span.textContent = STATUS_LABELS[normalized] || normalized;
    return span;
  }

  function clear(node) {
    node.replaceChildren();
  }

  function safeFileHref(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin || url.username || url.password || !url.pathname.startsWith("/api/files/")) return null;
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const controller = new AbortController();
    const upstreamSignal = options.signal;
    const abortFromUpstream = () => controller.abort(upstreamSignal.reason);
    if (upstreamSignal) {
      if (upstreamSignal.aborted) abortFromUpstream();
      else upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
    }
    const timeout = window.setTimeout(() => controller.abort(new DOMException("Превышено время ожидания", "TimeoutError")), 10000);
    headers.set("Accept", "application/json");
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      headers.set("x-csrf-token", state.csrfToken);
    }
    try {
      const response = await fetch(path, { ...options, headers, signal: controller.signal, cache: "no-store" });
      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (response.ok) throw error;
        data = null;
      }
      if (!response.ok) {
        const message = data && typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return data;
    } finally {
      window.clearTimeout(timeout);
      if (upstreamSignal) upstreamSignal.removeEventListener("abort", abortFromUpstream);
    }
  }

  function renderProgress() {
    const total = state.jobs.length;
    const complete = state.jobs.filter((job) => effectiveStatus(job) === "complete").length;
    const percent = total ? Math.round((complete / total) * 100) : 0;
    el["progress-label"].textContent = `${complete} / ${total}`;
    el["progress-label"].setAttribute("aria-label", `Готово ${complete} из ${total}`);
    el["progress-bar"].style.width = `${percent}%`;
    el["progress-bar"].parentElement.setAttribute("aria-valuenow", String(percent));
  }

  function actionIcon(name) {
    if (name === "running") {
      const indicator = document.createElement("span");
      indicator.className = "status-dot status-dot-animated bg-blue";
      indicator.setAttribute("aria-hidden", "true");
      return indicator;
    }
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ class: "icon", width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
    const shapes = {
      pause: [["path", { d: "M6 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12" }], ["path", { d: "M14 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12" }]],
      clock: [["path", { d: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" }], ["path", { d: "M12 7v5l3 3" }]],
      check: [["path", { d: "M5 12l5 5l10 -10" }]],
      alert: [["path", { d: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" }], ["path", { d: "M12 8v4" }], ["path", { d: "M12 16h.01" }]],
      square: [["path", { d: "M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -10" }]]
    };
    for (const [tag, attributes] of shapes[name] || shapes.alert) {
      const node = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      svg.append(node);
    }
    return svg;
  }

  function actionButton(job, action, label, icon, color, secondary = false) {
    const status = effectiveStatus(job);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn btn-icon btn-ghost-secondary text-${color}`;
    button.dataset[secondary ? "jobSecondaryAction" : "jobAction"] = job.id;
    button.dataset.action = action || "";
    button.dataset.status = status;
    button.dataset.icon = icon;
    button.title = `${STATUS_LABELS[status] || status} · ${label}`;
    button.setAttribute("aria-label", `${button.title} · ${job.url}`);
    button.disabled = !action;
    button.setAttribute("aria-busy", String(state.pendingActions.has(job.id)));
    button.setAttribute("aria-disabled", String(!action || state.pendingActions.has(job.id)));
    button.append(actionIcon(icon));
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (action && !state.pendingActions.has(job.id)) writeAction(job.id, action, button);
    });
    button.addEventListener("keydown", event => event.stopPropagation());
    return button;
  }

  function queueActions(job) {
    const status = effectiveStatus(job);
    const attempt = currentAttempt(job);
    if (job.canStop === true && TERMINAL_STATUSES.has(status)) return [actionButton(job, "stop", "Повторить остановку", "square", "yellow")];
    const mapping = {
      paused: ["resume", "Возобновить", "pause", "secondary"],
      queued: attempt?.phase === "qa" ? ["stop", "Отменить проверку", "square", "blue"] : ["pause", "Поставить на паузу", "clock", "blue"],
      running: [job.canStop ? "stop" : null, job.canStop ? "Остановить" : "Остановка недоступна: нет работающего процесса", "running", "blue"],
      validating: [job.canStop ? "stop" : null, job.canStop ? "Остановить" : "Остановка недоступна: процесс завершён", "running", "blue"],
      stopping: [null, "Остановка уже выполняется", "square", "yellow"],
      complete: ["retry", "Повторить", "check", "green"],
      cancelled: ["retry", "Повторить", "square", "secondary"]
    };
    if (job.canContinueQa === true) {
      return [
        actionButton(job, "continue-qa", "Продолжить проверку", "check", "blue"),
        actionButton(job, "retry", "Повторить захват", "alert", "red", true)
      ];
    }
    const action = mapping[status] || (TERMINAL_STATUSES.has(status) ? ["retry", "Повторить", "alert", "red"] : [null, "Действие недоступно", "alert", "secondary"]);
    return [actionButton(job, ...action)];
  }

  function renderJobs() {
    const focused = el["jobs-body"].contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.dataset.jobAction || focused?.dataset.jobSecondaryAction || focused?.dataset.jobSelect;
    const focusedAction = Boolean(focused?.dataset.jobAction || focused?.dataset.jobSecondaryAction);
    const focusedOperation = focused?.dataset.action;
    clear(el["jobs-body"]);
    if (!state.jobs.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 2;
      cell.className = "text-secondary text-center py-5";
      cell.textContent = "Очередь пуста";
      row.append(cell);
      el["jobs-body"].append(row);
      return;
    }

    state.jobs.slice().reverse().forEach((job) => {
      const row = document.createElement("tr");
      row.dataset.jobId = job.id;
      row.dataset.jobSelect = job.id;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Открыть результаты задания ${job.url || job.id}`);
      if (job.id === state.selectedJobId) row.classList.add("table-active");

      const urlCell = document.createElement("td");
      const url = document.createElement("span");
      url.className = "fw-medium text-break";
      url.textContent = job.url || "—";
      urlCell.append(url);
      const attempt = currentAttempt(job);
      if (attempt?.phase === "qa" && attempt.status === "queued" && attempt.qaRetryAt) {
        const retry = document.createElement("div");
        retry.className = "small text-secondary";
        retry.textContent = `Автоповтор проверки ${attempt.qaAutoRetries}/3`;
        urlCell.append(retry);
      }

      const statusCell = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "d-inline-flex gap-1";
      actions.append(...queueActions(job));
      statusCell.append(actions);

      statusCell.className = "text-end";
      row.append(urlCell, statusCell);
      const select = () => selectJob(job.id);
      row.addEventListener("click", select);
      row.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select();
      });
      el["jobs-body"].append(row);
    });
    if (focusedId) {
      const controls = [...el["jobs-body"].querySelectorAll("[data-job-action], [data-job-secondary-action], [data-job-select]")];
      const target = controls.find(control => (focusedAction ? (control.dataset.jobAction || control.dataset.jobSecondaryAction) : control.dataset.jobSelect) === focusedId &&
        (!focusedAction || control.dataset.action === focusedOperation) && !control.disabled) || controls.find(control => control.dataset.jobSelect === focusedId);
      target?.focus({ preventScroll: true });
    }
  }

  function renderAttempt(job, attempt) {
    clear(el["attempt-meta"]);
    clear(el["files-list"]);
    if (!attempt) {
      el["attempt-meta"].textContent = "Попытки ещё нет.";
      el["summary-output"].textContent = "Нет данных";
      el["issues-output"].textContent = "Нет данных";
      el["logs-card"].classList.add("d-none");
      renderQaProgress(null);
      return;
    }

    const list = document.createElement("dl");
    list.className = "row mb-0";
    [
      ["Начало", formatDate(attempt.startedAt)],
      ["Завершение", formatDate(attempt.finishedAt)],
      ["Код выхода", attempt.exitCode === null || attempt.exitCode === undefined ? "—" : String(attempt.exitCode)],
      ["Ошибка", attempt.error || "—"]
    ].forEach(([label, value]) => {
      const dt = document.createElement("dt");
      dt.className = "col-4";
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.className = "col-8 text-break";
      dd.textContent = String(value);
      list.append(dt, dd);
    });
    el["attempt-meta"].append(list);
    el["summary-output"].textContent = formatValue(attempt.summary);
    el["issues-output"].textContent = formatValue(attempt.issues, "Замечаний нет");

    const files = (Array.isArray(attempt.files) ? attempt.files : []).filter(file => file.kind !== "png");
    if (!files.length) {
      const empty = document.createElement("div");
      empty.className = "text-secondary";
      empty.textContent = "Отчёта JSON пока нет";
      el["files-list"].append(empty);
    } else {
      files.forEach((file) => {
        const item = document.createElement("div");
        item.className = "mb-2";
        const row = document.createElement("div");
        row.className = "d-flex flex-wrap gap-2 align-items-center";
        const info = document.createElement("div");
        const name = document.createElement("div");
        name.className = "fw-medium text-break";
        name.textContent = file.name || "Файл";
        const kind = document.createElement("div");
        kind.className = "text-secondary small";
        kind.textContent = file.kind || "file";
        info.append(name, kind);
        row.append(info);
        const href = safeFileHref(file.url);
        if (href) {
          const link = document.createElement("button");
          link.type = "button";
          link.className = "btn btn-outline-primary btn-sm ms-auto";
          link.dataset.fileHref = href;
          link.textContent = "Открыть";
          link.setAttribute("aria-label", `Открыть ${file.name || "JSON"}`);
          link.addEventListener("click", () => openJson(file, link));
          row.append(link);
        }
        item.append(row);
        el["files-list"].append(item);
      });
    }

    el["logs-card"].classList.remove("d-none");
    renderGallery(job, attempt);
  }

  function formatDuration(attempt, timestamp = Date.now()) {
    const start = Date.parse(attempt?.startedAt);
    const finish = attempt?.finishedAt ? Date.parse(attempt.finishedAt) : ACTIVE_STATUSES.has(attempt?.status) ? timestamp : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return "—";
    const seconds = Math.floor((finish - start) / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
  }

  function renderDuration() {
    const job = state.jobs.find(candidate => candidate.id === state.selectedJobId);
    el["attempt-duration"].textContent = formatDuration(job && selectedAttempt(job));
  }

  function selectedAttempt(job) {
    const attempts = Array.isArray(job.attempts) ? job.attempts : [];
    return attempts.find((attempt) => String(attempt.number) === String(state.selectedAttemptNumber)) || attempts[attempts.length - 1] || null;
  }

  function renderDetail() {
    const job = state.jobs.find((candidate) => candidate.id === state.selectedJobId);
    if (!job) {
      state.selectedJobId = null;
      state.selectedAttemptNumber = null;
      state.logsKey = null;
      el["empty-detail"].classList.remove("d-none");
      el["job-detail"].classList.add("d-none");
      el["logs-card"].classList.add("d-none");
      return;
    }

    el["empty-detail"].classList.add("d-none");
    el["job-detail"].classList.remove("d-none");
    el["detail-title"].textContent = "Результаты страницы";
    const detailUrl = el["detail-url"];
    detailUrl.textContent = job.url || "—";
    if (job.url) {
      detailUrl.href = job.url;
      detailUrl.target = "_blank";
      detailUrl.rel = "noopener noreferrer";
    } else {
      detailUrl.removeAttribute("href");
      detailUrl.removeAttribute("target");
      detailUrl.removeAttribute("rel");
    }
    el["detail-id"].textContent = String(job.id || "—");
    el["detail-created"].textContent = formatDate(job.createdAt);

    const attempts = Array.isArray(job.attempts) ? job.attempts : [];
    if (attempts.length && !attempts.some((attempt) => String(attempt.number) === String(state.selectedAttemptNumber))) {
      state.selectedAttemptNumber = attempts[attempts.length - 1].number;
      state.logsKey = null;
    }
    clear(el["attempt-select"]);
    attempts.slice().reverse().forEach((attempt) => {
      const option = document.createElement("option");
      option.value = String(attempt.number);
      option.textContent = `Попытка ${attempt.number}`;
      option.selected = String(attempt.number) === String(state.selectedAttemptNumber);
      el["attempt-select"].append(option);
    });
    el["attempt-select"].disabled = !attempts.length;
    el["detail-status"].replaceChildren(badge(selectedAttempt(job)?.status));
    renderDuration();
    renderAttempt(job, selectedAttempt(job));
  }

  function renderState(data) {
    state.csrfToken = typeof data.csrfToken === "string" ? data.csrfToken : "";
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const fingerprint = JSON.stringify(jobs);
    const changed = fingerprint !== state.jobsFingerprint;
    state.jobs = jobs;
    state.jobsFingerprint = fingerprint;
    // Refresh the tab signal for every state response, even when the queue
    // fingerprint is unchanged and the heavier DOM render is skipped.
    renderFavicon();
    if (Number.isInteger(data.concurrency)) state.concurrency = data.concurrency;
    if (!state.settingsPending && document.activeElement !== el["concurrency-slider"]) renderSettings();
    renderProgress();
    if (changed) {
      renderJobs();
      renderDetail();
    }
    renderDuration();
  }

  function selectJob(id) {
    state.selectedJobId = id;
    const job = state.jobs.find((candidate) => candidate.id === id);
    const attempt = job && currentAttempt(job);
    state.selectedAttemptNumber = attempt ? attempt.number : null;
    state.logsKey = null;
    renderJobs();
    renderDetail();
    refreshSelectedLogs(true);
  }

  async function writeAction(id, action, button) {
    state.pendingActions.add(id);
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-disabled", "true");
    showGlobalError("");
    try {
      await api(`/api/jobs/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        body: "{}"
      });
      if (action === "retry" && state.selectedJobId === id) state.selectedAttemptNumber = null;
      await refreshState();
    } catch (error) {
      showGlobalError(error instanceof Error ? error.message : String(error));
    } finally {
      state.pendingActions.delete(id);
      renderJobs();
    }
  }

  function showBatchResult(data) {
    clear(el["batch-result"]);
    const parts = [];
    const duplicates = Array.isArray(data.duplicates) ? data.duplicates : [];
    const invalid = Array.isArray(data.invalid) ? data.invalid : [];
    if (duplicates.length) parts.push(["warning", `Повторы: ${duplicates.join(", ")}`]);
    if (invalid.length) {
      const details = invalid.map((item) => `${item.input || "—"}: ${item.error || "некорректный URL"}`).join("; ");
      parts.push(["danger", `Некорректные: ${details}`]);
    }
    el["batch-result"].className = parts.length ? "mt-3" : "mt-3 d-none";
    parts.forEach(([type, text]) => {
      const alert = document.createElement("div");
      alert.className = `alert alert-${type} mb-2`;
      alert.textContent = text;
      el["batch-result"].append(alert);
    });
  }

  async function submitUrl(event) {
    event.preventDefault();
    if (state.submitting) return;
    const row = { input: el["url-input"], feedback: el["url-feedback"] };
    let canonical;
    try { canonical = normalizeInputUrl(row.input.value.trim()); }
    catch (error) { rowFeedback(row, "invalid", error.message); return; }
    rowFeedback(row, "", "");
    state.submitting = true;
    row.input.readOnly = true;
    el["clear-url"].disabled = true;
    el["submit-button"].disabled = true;
    el["submit-button"].setAttribute("aria-busy", "true");
    showGlobalError("");
    try {
      const data = await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({ urls: canonical })
      });
      showBatchResult(data || {});
      const invalid = data.invalid.find(item => item.input === canonical);
      if (invalid) rowFeedback(row, "invalid", invalid.error);
      else if (data.added.length) row.input.value = "";
      else if (data.duplicates.length) rowFeedback(row, "valid", "Уже в очереди — повтор не добавлен");
      await refreshState();
    } catch (error) {
      showGlobalError(error instanceof Error ? error.message : String(error));
    } finally {
      el["submit-button"].disabled = false;
      el["submit-button"].setAttribute("aria-busy", "false");
      el["clear-url"].disabled = false;
      row.input.readOnly = false;
      state.submitting = false;
    }
  }

  // Keep this policy identical to the server; the API still validates every row.
  function normalizeInputUrl(input) {
    const message = "Нужен полный HTTPS-адрес поддомена reestr35.ru, без логина и нестандартного порта.";
    if (typeof input !== "string" || input.length > 4096 || /[\u0000-\u0020\\]/.test(input)) throw new Error(message);
    let url;
    try { url = new URL(input); } catch { throw new Error(message); }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+reestr35\.ru$/i.test(url.hostname)) throw new Error(message);
    url.hash = "";
    return url.href;
  }

  function rowFeedback(row, type, message) {
    row.input.classList.toggle("is-invalid", type === "invalid");
    row.input.classList.toggle("is-valid", type === "valid");
    row.input.setAttribute("aria-invalid", String(type === "invalid"));
    row.feedback.className = type ? `${type}-feedback d-block` : "d-none";
    row.feedback.textContent = message;
  }

  function renderSettings() {
    el["concurrency-slider"].value = String(state.concurrency);
    el["concurrency-slider"].disabled = !state.csrfToken;
    el["concurrency-value"].textContent = String(state.concurrency);
  }

  async function changeConcurrency() {
    state.settingsDesired = Number(el["concurrency-slider"].value);
    if (state.settingsPending) return;
    state.settingsPending = true;
    el["concurrency-slider"].setAttribute("aria-busy", "true");
    el["settings-error"].classList.add("d-none");
    try {
      // Keep the focused range enabled. Serialize requests, coalescing rapid changes
      // to the latest requested limit instead of repainting an older response.
      while (state.settingsDesired !== null) {
        const concurrency = state.settingsDesired;
        state.settingsDesired = null;
        try {
          const result = await api("/api/settings", { method: "POST", body: JSON.stringify({ concurrency }) });
          state.concurrency = result.concurrency;
          el["settings-error"].classList.add("d-none");
        } catch (error) {
          el["settings-error"].textContent = `Не удалось изменить параллельность: ${error.message}`;
          el["settings-error"].classList.remove("d-none");
        }
        // Do not overwrite a queued change or an in-progress pointer drag.
        if (state.settingsDesired === null && Number(el["concurrency-slider"].value) === concurrency) renderSettings();
      }
    } finally {
      state.settingsPending = false;
      el["concurrency-slider"].setAttribute("aria-busy", "false");
    }
  }

  async function openJson(file, trigger) {
    const href = safeFileHref(file.url);
    if (!href) return;
    state.jsonController?.abort();
    state.jsonController = new AbortController();
    const request = ++state.jsonRequest;
    state.jsonTrigger = href;
    el["json-modal-title"].textContent = file.name || "JSON";
    el["json-original"].href = href;
    el["json-output"].textContent = "Загрузка…";
    el["json-error"].classList.add("d-none");
    window.tabler.Modal.getOrCreateInstance(el["json-modal"]).show(trigger);
    try {
      const data = await api(href, { signal: state.jsonController.signal });
      if (request === state.jsonRequest) el["json-output"].textContent = JSON.stringify(data, null, 2);
    } catch (error) {
      if (request !== state.jsonRequest) return;
      el["json-output"].textContent = "";
      el["json-error"].textContent = `Не удалось загрузить JSON: ${error.message}`;
      el["json-error"].classList.remove("d-none");
    }
  }

  function imageStatusBadge(file) {
    const qaStatus = ["unreviewed", "passed", "issues"].includes(file.qaStatus) ? file.qaStatus : "unreviewed";
    const status = file.loadError ? "load_error" : qaStatus;
    const labels = { unreviewed: "Не проверено", passed: "Проверено", issues: "Есть замечания", load_error: "PNG не загружен" };
    const classes = { unreviewed: "bg-secondary-lt", passed: "bg-green-lt", issues: "bg-yellow-lt", load_error: "bg-red-lt" };
    const span = document.createElement("span");
    span.className = `badge image-status ${classes[status]}`;
    span.dataset.imageStatus = status;
    span.textContent = labels[status];
    return span;
  }

  function qaCounts(attempt) {
    const qa = attempt?.qa && typeof attempt.qa === "object" ? attempt.qa : {};
    const segments = Array.isArray(qa.segments) ? qa.segments.map(segment => ({
      name: typeof segment?.name === "string" ? segment.name : "",
      status: ["passed", "issues", "pending"].includes(segment?.status) ? segment.status : "pending"
    })) : [];
    const passed = segments.filter(segment => segment.status === "passed").length;
    const issues = segments.filter(segment => segment.status === "issues").length;
    const pending = segments.filter(segment => segment.status === "pending").length;
    return { total: segments.length, reviewed: passed + issues, passed, issues, pending, segments };
  }

  function renderQaProgress(attempt) {
    const qa = qaCounts(attempt);
    const percent = qa.total ? Math.min(100, Math.round((qa.reviewed / qa.total) * 100)) : 0;
    el["qa-progress"].classList.toggle("d-none", qa.total === 0);
    el["qa-progress-count"].textContent = `${qa.reviewed}/${qa.total}`;
    const progress = el["qa-progress-bar"];
    const classes = { passed: "bg-green", issues: "bg-red", pending: "bg-secondary" };
    progress.querySelectorAll(".qa-progress-segment").forEach(item => window.tabler.Tooltip.getInstance(item)?.dispose());
    const items = qa.segments.map((segment, index) => {
      const item = document.createElement("span");
      const tooltip = `${index + 1} — ${segment.name}`;
      item.className = `progress-bar qa-progress-segment ${classes[segment.status]}`;
      item.dataset.qaStatus = segment.status;
      item.dataset.qaName = segment.name;
      item.dataset.qaTooltip = tooltip;
      item.title = tooltip;
      item.setAttribute("aria-hidden", "true");
      return item;
    });
    progress.replaceChildren(...items);
    items.forEach(item => new window.tabler.Tooltip(item, { trigger: "hover", title: item.dataset.qaTooltip, html: false }));
    progress.setAttribute("aria-valuenow", String(percent));
    progress.setAttribute("aria-label", `Проверено ${qa.reviewed} из ${qa.total} PNG: без замечаний ${qa.passed}, с замечаниями ${qa.issues}, ожидают проверки ${qa.pending}`);
  }

  function showPng(index) {
    if (index < 0 || index >= state.gallery.length) return;
    state.galleryIndex = index;
    const file = state.gallery[index];
    el["png-modal-title"].textContent = file.name;
    el["png-counter"].textContent = `${index + 1} / ${state.gallery.length}`;
    el["png-status"].replaceChildren(imageStatusBadge(file));
    el["png-prev"].disabled = index === 0;
    el["png-next"].disabled = index === state.gallery.length - 1;
    if (el["png-modal"].classList.contains("show") && (document.activeElement.disabled || !el["png-modal"].contains(document.activeElement))) el["png-modal"].focus({ preventScroll: true });
    el["png-original"].href = file.href;
    if (el["png-full"].getAttribute("src") !== file.href) {
      el["png-error"].classList.add("d-none");
      el["png-full"].alt = `Снимок сегмента ${file.name}, попытка ${state.selectedAttemptNumber}`;
      el["png-full"].src = file.href;
      el["png-full"].parentElement.scrollTo(0, 0);
    }
  }

  function drawGallery() {
    clear(el["png-gallery"]);
    state.gallery.forEach((file, index) => {
      const column = document.createElement("div");
      column.className = "col-12 col-md-6 col-xxl-4";
      const card = document.createElement("div");
      card.className = "card h-100";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "btn p-0 w-100";
      open.dataset.fileName = file.name;
      open.dataset.fileHref = file.href;
      open.setAttribute("aria-label", `Просмотреть ${file.name}`);
      const img = document.createElement("img");
      img.className = "card-img-top gallery-thumb";
      img.src = file.href;
      img.alt = `Снимок сегмента ${file.name}`;
      img.loading = "lazy";
      open.append(img);
      const body = document.createElement("div");
      body.className = "card-body p-3";
      const title = document.createElement("h4");
      title.className = "card-title text-break mb-2";
      title.textContent = file.name.replace(/\.png$/i, "").replace(/__/g, " / ").replace(/_/g, " ");
      const status = document.createElement("div");
      status.className = "d-flex flex-wrap gap-2";
      status.replaceChildren(imageStatusBadge(file));
      img.addEventListener("error", () => {
        file.loadError = true;
        status.replaceChildren(imageStatusBadge(file));
        if (state.gallery[state.galleryIndex] === file) el["png-status"].replaceChildren(imageStatusBadge(file));
      });
      body.append(title, status);
      card.append(open, body);
      column.append(card);
      el["png-gallery"].append(column);
      card.addEventListener("click", () => {
        state.galleryTrigger = { key: state.galleryKey, name: file.name, href: file.href };
        showPng(index);
        window.tabler.Modal.getOrCreateInstance(el["png-modal"]).show(open);
      });
    });
    if (el["png-modal"].classList.contains("show")) showPng(state.galleryIndex);
  }

  function renderGallery(job, attempt) {
    const key = `${job.id}:${attempt.number}`;
    const files = Array.isArray(attempt.files) ? attempt.files : [];
    const fingerprint = JSON.stringify([key, files, attempt.status]);
    const changedAttempt = key !== state.galleryKey;
    renderQaProgress(attempt);
    if (changedAttempt) {
      window.tabler.Modal.getInstance(el["png-modal"])?.hide();
      state.galleryIndex = 0;
      state.galleryKey = key;
    }
    if (fingerprint === state.galleryFingerprint) return;
    state.galleryFingerprint = fingerprint;
    const selectedName = changedAttempt ? null : state.gallery[state.galleryIndex]?.name;
    state.gallery = files.filter(file => file.kind === "png" && safeFileHref(file.url)).map(file => ({ ...file, href: safeFileHref(file.url) }));
    state.galleryIndex = Math.max(0, state.gallery.findIndex(file => file.name === selectedName));
    el["gallery-message"].textContent = state.gallery.length ? `${state.gallery.length} PNG` : "Снимков пока нет";
    drawGallery();
  }

  async function fetchLog(jobId, attemptNumber, stream) {
    const query = new URLSearchParams({ stream });
    return api(`/api/logs/${encodeURIComponent(jobId)}/${encodeURIComponent(attemptNumber)}?${query.toString()}`);
  }

  async function refreshSelectedLogs(force = false) {
    const job = state.jobs.find((candidate) => candidate.id === state.selectedJobId);
    const attempt = job && selectedAttempt(job);
    if (!job || !attempt) return;
    const key = `${job.id}:${attempt.number}`;
    if (force || state.logsKey !== key) {
      el["stdout-output"].textContent = "Загрузка…";
      el["stderr-output"].textContent = "Загрузка…";
    }
    state.logsKey = key;
    try {
      const [stdout, stderr] = await Promise.all([
        fetchLog(job.id, attempt.number, "stdout"),
        fetchLog(job.id, attempt.number, "stderr")
      ]);
      if (state.logsKey !== key) return;
      el["stdout-output"].textContent = stdout && stdout.text ? stdout.text : "Журнал пуст";
      el["stderr-output"].textContent = stderr && stderr.text ? stderr.text : "Журнал пуст";
      el["stdout-truncated"].classList.toggle("d-none", !(stdout && stdout.truncated));
      el["stderr-truncated"].classList.toggle("d-none", !(stderr && stderr.truncated));
    } catch (error) {
      if (state.logsKey !== key) return;
      const message = `Не удалось загрузить журнал: ${error instanceof Error ? error.message : String(error)}`;
      el["stdout-output"].textContent = message;
      el["stderr-output"].textContent = message;
    }
  }

  async function refreshState() {
    if (state.refreshPromise) {
      state.refreshQueued = true;
      return state.refreshPromise;
    }
    state.refreshPromise = (async () => {
      do {
        state.refreshQueued = false;
        const data = await api("/api/state");
        renderState(data || {});
        setConnection(true, "Подключено");
        showGlobalError("");
        await refreshSelectedLogs();
      } while (state.refreshQueued && !state.stopped);
    })();
    try { await state.refreshPromise; }
    finally { state.refreshPromise = null; }
  }

  function connectEvents() {
    state.eventSource = new EventSource("/api/events");
    state.eventSource.addEventListener("qa-review", () => {
      refreshState().catch(() => {}); // Polling remains the visible reconnect/error fallback.
    });
  }

  async function poll() {
    if (state.stopped) return;
    try {
      await refreshState();
    } catch (error) {
      setConnection(false, "Переподключение…");
      showGlobalError(`Сервер недоступен: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!state.stopped) state.pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
    }
  }

  el["batch-form"].addEventListener("submit", submitUrl);
  el["url-input"].addEventListener("input", () => {
    rowFeedback({ input: el["url-input"], feedback: el["url-feedback"] }, "", "");
    el["batch-result"].classList.add("d-none");
  });
  el["clear-url"].addEventListener("click", () => {
    el["url-input"].value = "";
    rowFeedback({ input: el["url-input"], feedback: el["url-feedback"] }, "", "");
    el["batch-result"].classList.add("d-none");
    el["url-input"].focus({ preventScroll: true });
  });
  el["concurrency-slider"].addEventListener("input", () => { el["concurrency-value"].textContent = el["concurrency-slider"].value; });
  el["concurrency-slider"].addEventListener("change", changeConcurrency);
  el["concurrency-slider"].addEventListener("blur", () => { if (!state.settingsPending) renderSettings(); });
  el["json-modal"].addEventListener("hidden.bs.modal", () => {
    state.jsonRequest++;
    state.jsonController?.abort();
    const button = [...el["files-list"].querySelectorAll("button")].find(candidate => candidate.dataset.fileHref === state.jsonTrigger);
    state.jsonTrigger = null;
    if (button?.isConnected && !button.disabled) button.focus({ preventScroll: true });
  });
  el["png-prev"].addEventListener("click", () => showPng(state.galleryIndex - 1));
  el["png-next"].addEventListener("click", () => showPng(state.galleryIndex + 1));
  el["png-full"].addEventListener("error", () => el["png-error"].classList.remove("d-none"));
  el["png-modal"].addEventListener("hidden.bs.modal", () => {
    const trigger = state.galleryTrigger;
    state.galleryTrigger = null;
    if (!trigger || trigger.key !== state.galleryKey) return;
    // Polling may replace the original button while the modal is open.
    const button = [...el["png-gallery"].querySelectorAll("button")].find(candidate =>
      candidate.dataset.fileName === trigger.name && candidate.dataset.fileHref === trigger.href);
    if (button?.isConnected && !button.disabled) button.focus({ preventScroll: true });
  });
  document.addEventListener("keydown", event => {
    if (!el["png-modal"].classList.contains("show")) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      showPng(state.galleryIndex + (event.key === "ArrowLeft" ? -1 : 1));
    }
  });
  el["attempt-select"].addEventListener("change", () => {
    state.selectedAttemptNumber = el["attempt-select"].value;
    state.logsKey = null;
    renderDetail();
    refreshSelectedLogs(true);
  });
  window.addEventListener("beforeunload", () => {
    state.stopped = true;
    if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
    state.eventSource?.close();
  });

  connectEvents();
  poll();
})();
