(() => {
  "use strict";

  const POLL_INTERVAL_MS = 1500;
  const ACTIVE_STATUSES = new Set(["running", "pausing", "validating", "stopping"]);
  // Current-attempt outcomes that need attention in the tab indicator.
  const ERROR_STATUSES = new Set(["needs_review", "incomplete", "failed", "interrupted"]);
  const STATUS_LABELS = {
    paused: "На паузе",
    queued: "В очереди",
    running: "Выполняется",
    pausing: "Приостанавливается",
    validating: "Проверяется",
    stopping: "Останавливается",
    complete: "Готово",
    needs_review: "Нужна проверка",
    incomplete: "Неполный результат",
    failed: "Ошибка",
    cancelled: "Отменено",
    interrupted: "Прервано"
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
    activeStage: 1,
    stageContextKey: null,
    stageManuallySelected: false,
    eventSource: null,
    refreshPromise: null,
    refreshQueued: false,
    refreshGeneration: 0,
    shutdownRequested: false,
    shutdownError: false,
    submitting: false,
    pendingActions: new Map()
  };

  const el = Object.fromEntries([
    "connection-control", "connection-dot", "connection-label", "concurrency-value", "global-alert",
    "batch-form", "url-input", "clear-url", "url-feedback", "submit-button", "batch-result", "progress-label",
    "progress-bar", "jobs-body", "empty-detail", "concurrency-slider", "settings-error",
    "job-detail", "detail-url", "result-steps", "attempt-duration", "detail-id",
    "detail-created", "attempt-select", "attempt-meta", "files-list", "recapture-button",
    "stage-step-1", "stage-step-2", "stage-step-3", "gallery-body",
    "metadata-panel", "summary-panel", "stage-two-panel", "stage-three-panel", "attempt-header",
    "technical-area", "media-source-panel", "media-source-meta", "media-outcome-panel", "media-outcome-status", "media-outcome-meta",
    "summary-output", "issues-output", "logs-card", "stdout-output",
    "stderr-output", "stdout-truncated", "stderr-truncated", "png-gallery",
    "qa-progress", "qa-progress-count", "qa-progress-bar", "media-progress", "media-progress-count", "media-progress-bar", "builder-progress", "builder-progress-count", "builder-progress-bar",
    "png-modal", "png-modal-title", "png-counter",
    "png-full", "png-error", "png-prev", "png-next",
    "json-modal", "json-modal-title", "json-output", "json-error"
  ].map((id) => [id, document.getElementById(id)]));

  function setConnection(connected, message, phase = connected ? "connected" : "reconnecting") {
    el["connection-label"].textContent = message;
    const dotClass = phase === "connected" ? "bg-green" : phase === "stopping" ? "status-dot-animated bg-yellow" : phase === "disconnected" ? "bg-red" : "status-dot-animated bg-red";
    el["connection-dot"].className = `status-dot ${dotClass}`;
    el["connection-control"].disabled = phase !== "connected";
  }

  function showGlobalError(message) {
    if (!message) state.shutdownError = false;
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
    // isActive comes from the server's live child-process map and decides whether
    // the blue state is active. Its number is the current workload: each live or
    // queued job once, including the unlikely overlap of both signals.
    const active = state.jobs.some((job) => job.isActive === true);
    const workload = state.jobs.filter((job) => job.isActive === true || effectiveStatus(job) === "queued").length;
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
        throw Object.assign(new Error(message), { status: response.status });
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
    const pending = state.pendingActions.get(job.id);
    const pendingAction = Boolean(action && pending?.action === action);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn btn-icon btn-ghost-secondary queue-status-button text-${color}`;
    button.dataset[secondary ? "jobSecondaryAction" : "jobAction"] = job.id;
    button.dataset.action = action || "";
    button.dataset.status = status;
    button.dataset.icon = icon;
    button.dataset.actionLabel = label;
    button.dataset.jobUrl = job.url;
    button.disabled = !action || Boolean(pending);
    button.setAttribute("aria-busy", String(pendingAction));
    button.setAttribute("aria-disabled", String(button.disabled));
    const graphic = actionIcon(icon);
    if (icon === "running") graphic.className = `status-dot status-dot-animated bg-${color}`;
    button.append(graphic);
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (action && !state.pendingActions.has(job.id)) writeAction(job.id, action, button);
    });
    button.addEventListener("keydown", event => event.stopPropagation());
    const wrapper = document.createElement("span");
    wrapper.className = "queue-status-control";
    wrapper.append(button);
    wrapper.addEventListener("click", event => { if (button.disabled) event.stopPropagation(); });
    updateActionTooltip(button);
    return wrapper;
  }

  function updateActionTooltip(button) {
    const title = button.dataset.problem || `${STATUS_LABELS[button.dataset.status] || button.dataset.status} · ${button.disabled ? "Недоступно" : button.dataset.actionLabel}`;
    button.title = title;
    button.setAttribute("aria-label", `${title} · ${button.dataset.jobUrl}`);
    const wrapper = button.parentElement;
    window.tabler.Tooltip.getInstance(wrapper)?.dispose();
    if (button.dataset.problem) { wrapper.tabIndex = 0; wrapper.setAttribute("role", "img"); wrapper.setAttribute("aria-label", title); }
    new window.tabler.Tooltip(wrapper, { trigger: button.dataset.problem ? "hover focus" : "hover", title, html: false, animation: false });
  }

  function queueActions(job) {
    const status = effectiveStatus(job);
    const attempt = currentAttempt(job);
    if (status === "paused" && attempt?.phase === "html-media" && attempt.htmlMedia?.status === "missing") {
      const control = actionButton(job, null, "Загрузить HTML", "alert", "yellow");
      control.dataset.jobWarning = job.id;
      const button = control.querySelector("button");
      button.dataset.problem = "HTML не найден.";
      updateActionTooltip(button);
      return [control];
    }
    const mapping = {
      paused: [job.canResume ? "resume" : null, "Продолжить", "pause", "secondary"],
      queued: ["pause", "Приостановить", "clock", "blue"],
      running: [job.canPause ? "pause" : null, "Приостановить", "running", "blue"],
      pausing: [null, "Недоступно", "running", "yellow"],
      validating: [job.canPause ? "pause" : null, "Приостановить", "running", "blue"],
      stopping: [null, "Недоступно", "square", "yellow"],
      complete: [job.canRecapture ? "retry" : null, "Перезапустить", "check", "green"],
      needs_review: [job.canRecapture ? "retry" : null, "Перезапустить", "alert", "red"],
      incomplete: [job.canRecapture ? "retry" : null, "Перезапустить", "alert", "orange"],
      failed: [job.canRecapture ? "retry" : null, "Перезапустить", "alert", "red"],
      interrupted: [job.canResume ? "resume" : job.canRecapture ? "retry" : null, job.canResume ? "Продолжить" : "Перезапустить", "alert", "red"],
      cancelled: [job.canRecapture ? "retry" : null, "Перезапустить", "square", "secondary"]
    };
    const action = mapping[status] || [null, "Недоступно", "alert", "secondary"];
    return [actionButton(job, ...action)];
  }

  function renderJobs() {
    const focused = el["jobs-body"].contains(document.activeElement) ? document.activeElement : null;
    const focusedWarning = focused?.dataset.jobWarning;
    const focusedId = focused?.dataset.jobAction || focused?.dataset.jobSecondaryAction || focused?.dataset.jobSelect || focusedWarning;
    const focusedAction = Boolean(focused?.dataset.jobAction || focused?.dataset.jobSecondaryAction);
    const focusedOperation = focused?.dataset.action;
    el["jobs-body"].querySelectorAll(".queue-status-control").forEach(wrapper => window.tabler.Tooltip.getInstance(wrapper)?.dispose());
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
      const controls = [...el["jobs-body"].querySelectorAll("[data-job-action], [data-job-secondary-action], [data-job-select], [data-job-warning]")];
      const target = controls.find(control => (focusedWarning ? control.dataset.jobWarning : focusedAction ? (control.dataset.jobAction || control.dataset.jobSecondaryAction) : control.dataset.jobSelect) === focusedId &&
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
      ["Начало попытки", formatDate(attempt.startedAt)],
      ["Текущая фаза", attempt.phase || "—"],
      ["Завершение в данных попытки", formatDate(attempt.finishedAt)],
      ["Код выхода в данных попытки", attempt.exitCode === null || attempt.exitCode === undefined ? "—" : String(attempt.exitCode)],
      ["Ошибка попытки", attempt.error || "—"]
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
    const capture = attempt.captureSummary, qa = attempt.qa;
    const captureStatus = attempt.captureStatus || (attempt.phase !== "html-media" ? attempt.status : null);
    const issueCount = value => Array.isArray(value) ? value.length : value ? 1 : 0;
    const hasIssues = issueCount(attempt.issues) + issueCount(capture?.issues) + (Number(qa?.issues) || 0) > 0;
    const outcome = captureStatus === "complete" && hasIssues ? "Завершено с замечаниями" : STATUS_LABELS[captureStatus] || captureStatus || "Итог шага ещё не зафиксирован";
    el["summary-output"].textContent = formatValue({
      "Итог скриншотов и QA": outcome,
      "Статус шага": captureStatus || "—",
      ...(capture ? { "Съёмка": capture } : attempt.summary ? { "Сводка прежней версии": attempt.summary } : {}),
      ...(qa ? { "Проверка PNG": { "Всего": qa.total, "Проверено": qa.reviewed, "Принято": qa.passed, "С замечаниями": qa.issues, "Не проверено": qa.unreviewed ?? qa.pending } } : {}),
      "Замечания попытки": issueCount(attempt.issues)
    });
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

    el["logs-card"].classList.toggle("d-none", state.activeStage !== 1);
    renderGallery(job, attempt);
  }

  const STAGE_ERROR_STATUSES = new Set(["needs_review", "incomplete", "failed", "interrupted"]);
  const secondStageAvailable = attempt => attempt?.captureStatus ? attempt.captureStatus === "complete" : attempt?.status === "complete";
  const thirdStageAvailable = attempt => secondStageAvailable(attempt) && ["complete", "ready_with_issues"].includes(attempt?.htmlMedia?.status) && attempt?.status === "complete";
  // Stage 3 is a placeholder and has no completion contract yet.
  const stageAvailable = (stage, attempt) => stage === 1 || stage === 2 && secondStageAvailable(attempt) || stage === 3 && thirdStageAvailable(attempt);
  const defaultStage = attempt => thirdStageAvailable(attempt) ? 3 : secondStageAvailable(attempt) ? 2 : 1;

  function renderMediaTechnical(attempt) {
    const info = attempt?.htmlMedia, source = info?.source;
    const rows = (element, values) => {
      clear(element);
      for (const [label, value] of values) {
        const dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.className = "col-5"; dt.textContent = label;
        dd.className = "col-7 text-break"; dd.textContent = String(value ?? "—");
        element.append(dt, dd);
      }
    };
    rows(el["media-source-meta"], [
      ["Ревизия (revision)", info?.revision], ["Происхождение (origin)", source?.origin],
      ["Размер, байт", source?.bytes], ["SHA-256", source?.sha256],
      ...(source?.status ? [["Статус источника", source.status]] : []), ["Статус этапа", info?.status]
    ]);
    const labels = { ready: "Готово к обработке", complete: "Завершено", ready_with_issues: "Завершено с замечаниями", missing: "HTML не найден", error: "Ошибка", downloading: "Скачивание", running: "Выполняется", paused: "На паузе", interrupted: "Прервано" };
    el["media-outcome-status"].textContent = labels[info?.status] || info?.status || "Обработка ещё не начата";
    const total = Number.isFinite(info?.total) ? Math.max(0, info.total) : null;
    const pending = Number.isFinite(info?.pending) ? Math.max(0, info.pending) : null;
    rows(el["media-outcome-meta"], [
      ["Обработано / всего", total !== null && pending !== null ? `${Math.max(0, total - pending)} / ${total}` : "—"],
      ["Скачано", info?.downloaded], ["Внешние", info?.external], ["Требуют внимания", info?.issues]
    ]);
  }

  function renderStages(job, attempt) {
    const secondAvailable = secondStageAvailable(attempt), thirdAvailable = thirdStageAvailable(attempt);
    const contextKey = job && attempt ? `${job.id}:${attempt.number}` : null;
    if (state.stageContextKey !== contextKey) {
      state.stageContextKey = contextKey;
      state.stageManuallySelected = false;
      state.activeStage = defaultStage(attempt);
    } else if (!state.stageManuallySelected) state.activeStage = defaultStage(attempt);
    if (!stageAvailable(state.activeStage, attempt)) {
      state.activeStage = defaultStage(attempt);
      state.stageManuallySelected = false;
    }
    const steps = [el["stage-step-1"], el["stage-step-2"], el["stage-step-3"]];
    const firstState = attempt?.captureStatus && attempt.captureStatus !== "complete" ? "error" : secondAvailable ? "success" : STAGE_ERROR_STATUSES.has(attempt?.status) ? "error" : "active";
    const builderState = job?.pageBuilder?.status;
    const builderColor = builderState === "system_error" ? "error" : builderState === "failed" ? "review-failed" : builderState === "passed" ? "success" : "active";
    const colors = [firstState, thirdAvailable ? "success" : secondAvailable ? "active" : "inactive", thirdAvailable ? builderColor : "inactive"];
    steps.forEach((step, index) => {
      const stage = index + 1, available = stageAvailable(stage, attempt), selected = state.activeStage === stage;
      step.classList.toggle("active", selected);
      for (const color of ["inactive", "active", "success", "error", "review-failed"]) step.classList.toggle(`step-state-${color}`, colors[index] === color);
      step.setAttribute("aria-selected", String(selected));
      step.setAttribute("aria-disabled", String(!available));
      step.tabIndex = selected ? 0 : -1;
      if (available) step.href = ["#gallery-body", "#stage-two-panel", "#stage-three-panel"][index];
      else step.removeAttribute("href");
    });
    const firstStage = state.activeStage === 1;
    el["media-source-panel"].classList.toggle("d-none", state.activeStage !== 2);
    el["media-outcome-panel"].classList.toggle("d-none", state.activeStage !== 2);
    renderMediaTechnical(attempt);
    el["gallery-body"].classList.toggle("d-none", !firstStage);
    el["metadata-panel"].classList.toggle("d-none", !firstStage);
    el["summary-panel"].classList.toggle("d-none", !firstStage);
    el["logs-card"].classList.toggle("d-none", !firstStage || !attempt);
    el["stage-two-panel"].classList.toggle("d-none", state.activeStage !== 2);
    el["stage-three-panel"].classList.toggle("d-none", state.activeStage !== 3);
    el["qa-progress"].classList.toggle("stage-hidden", !firstStage);
    el["media-progress"].classList.toggle("stage-hidden", state.activeStage !== 2);
    el["builder-progress"].classList.toggle("stage-hidden", state.activeStage !== 3);
    window.HtmlMedia.render(job, attempt, { csrfToken: state.csrfToken, refresh: () => refreshState() });
    if (state.activeStage === 3) window.PageBuilder.render(job, { api, refresh: () => refreshState() });
  }

  function selectStage(stage, { focus = false } = {}) {
    const job = state.jobs.find(candidate => candidate.id === state.selectedJobId), attempt = job && selectedAttempt(job);
    if (!stageAvailable(stage, attempt)) return;
    state.activeStage = stage;
    state.stageManuallySelected = true;
    renderStages(job, attempt);
    if (focus) el[`stage-step-${stage}`].focus({ preventScroll: true });
  }

  function formatDuration(attempt, timestamp = Date.now()) {
    const elapsed = Math.max(0, Number(attempt?.activeDurationMs) || 0);
    const active = ["running", "validating", "pausing", "stopping"].includes(attempt?.status) && Number.isFinite(attempt?.activeSince);
    const seconds = Math.floor((elapsed + (active ? Math.max(0, timestamp - attempt.activeSince) : 0)) / 1000);
    return `${attempt?.durationIncomplete ? "≥" : ""}${[Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":")}`;
  }

  function renderDuration() {
    const job = state.jobs.find(candidate => candidate.id === state.selectedJobId);
    const attempt = job && selectedAttempt(job);
    el["attempt-duration"].textContent = formatDuration(attempt);
    el["attempt-duration"].title = attempt?.durationIncomplete ? "Известное активное время. История ранних интервалов неполна; время на паузе и в очереди не учитывается." : "Активное время работы без пауз и ожидания в очереди";
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
    const detailUrl = el["detail-url"];
    detailUrl.textContent = job.url ? job.url.replace(/^https?:\/\//i, "").replace(/\/+$/, "") : "—";
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
      state.stageContextKey = null;
      state.stageManuallySelected = false;
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
    const recapture = el["recapture-button"];
    recapture.disabled = !job.canRecapture || state.pendingActions.has(job.id);
    recapture.classList.toggle("btn-loading", state.pendingActions.get(job.id)?.action === "retry");
    recapture.setAttribute("aria-busy", String(state.pendingActions.get(job.id)?.action === "retry"));
    recapture.title = "Перезапустить";
    recapture.setAttribute("aria-label", "Перезапустить");
    renderDuration();
    const attempt = selectedAttempt(job);
    renderAttempt(job, attempt);
    renderStages(job, attempt);
  }

  function renderState(data, generation = state.refreshGeneration) {
    state.csrfToken = typeof data.csrfToken === "string" ? data.csrfToken : "";
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const fingerprint = JSON.stringify(jobs);
    const changed = fingerprint !== state.jobsFingerprint;
    let confirmedAction = false;
    for (const [id, pending] of state.pendingActions) {
      if (generation < pending.confirmAfterGeneration) continue;
      state.pendingActions.delete(id);
      confirmedAction = true;
    }
    state.jobs = jobs;
    state.jobsFingerprint = fingerprint;
    // Refresh the tab signal for every state response, even when the queue
    // fingerprint is unchanged and the heavier DOM render is skipped.
    renderFavicon();
    if (Number.isInteger(data.concurrency)) state.concurrency = data.concurrency;
    if (!state.settingsPending && document.activeElement !== el["concurrency-slider"]) renderSettings();
    renderProgress();
    if (changed || confirmedAction) {
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
    state.stageContextKey = null;
    state.stageManuallySelected = false;
    state.logsKey = null;
    renderJobs();
    renderDetail();
    refreshSelectedLogs(true);
  }

  async function writeAction(id, action, button) {
    if (!id || state.pendingActions.has(id)) return;
    const pending = { action, confirmAfterGeneration: Number.POSITIVE_INFINITY };
    state.pendingActions.set(id, pending);
    if (state.selectedJobId === id) {
      const recapture = document.getElementById("recapture-button");
      if (recapture) { recapture.disabled = true; recapture.classList.toggle("btn-loading", recapture === button); recapture.setAttribute("aria-busy", String(recapture === button)); }
    }
    for (const control of el["jobs-body"].querySelectorAll("[data-job-action], [data-job-secondary-action]")) {
      if ((control.dataset.jobAction || control.dataset.jobSecondaryAction) !== id) continue;
      control.disabled = true;
      control.setAttribute("aria-disabled", "true");
      const clicked = control === button;
      control.setAttribute("aria-busy", String(clicked));
      updateActionTooltip(control);
    }
    showGlobalError("");
    let accepted = false;
    try {
      await api(`/api/jobs/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        body: "{}"
      });
      accepted = true;
      if (action === "retry" && state.selectedJobId === id) {
        state.selectedAttemptNumber = null; state.activeStage = 1; state.stageContextKey = null; state.stageManuallySelected = false;
      }
      // A state request that began before this POST succeeded may contain the
      // old action. Keep loading until a later snapshot confirms it.
      pending.confirmAfterGeneration = state.refreshGeneration + 1;
      if (!state.refreshPromise) await refreshState();
    } catch (error) {
      showGlobalError(error instanceof Error ? error.message : String(error));
      if (!accepted) {
        state.pendingActions.delete(id);
        renderJobs();
        renderDetail();
      }
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
    window.ArmEditors.destroy('json-output');
    el["json-modal-title"].textContent = file.name || "JSON";
    window.ModalActions.set('json-modal', null);
    el["json-output"].textContent = "Загрузка…";
    el["json-error"].classList.add("d-none");
    window.tabler.Modal.getOrCreateInstance(el["json-modal"]).show(trigger);
    try {
      const data = await api(href, { signal: state.jsonController.signal });
      if (request === state.jsonRequest) { window.ArmEditors.showJson('json-output', data); window.ModalActions.set('json-modal', { url: href, name: file.name || 'report.json', text: () => window.ArmEditors.text('json-output') }); }
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
    const classes = { unreviewed: "bg-secondary", passed: "bg-green", issues: "bg-yellow", load_error: "bg-red" };
    const span = document.createElement("span");
    span.className = `image-status ${classes[status]}`;
    span.dataset.imageStatus = status;
    span.tabIndex = 0; span.setAttribute('role', 'img'); span.setAttribute('aria-label', labels[status]); span.title = labels[status];
    span.append(actionIcon(status === 'passed' ? 'check' : status === 'unreviewed' ? 'clock' : 'alert'));
    span.addEventListener('click', event => event.stopPropagation());
    // Polling can replace a focused status immediately after blur; avoid a
    // pending hide transition calling into a disposed Tabler tooltip.
    new window.tabler.Tooltip(span, { title: labels[status], trigger: 'hover focus', html: false, animation: false });
    return span;
  }
  function replaceImageStatus(container, file) { container.querySelectorAll('.image-status').forEach(item => window.tabler.Tooltip.getInstance(item)?.dispose()); container.replaceChildren(imageStatusBadge(file)); }

  function qaCounts(attempt) {
    const qa = attempt?.qa && typeof attempt.qa === "object" ? attempt.qa : {};
    const segments = Array.isArray(qa.segments) ? qa.segments.map(segment => ({
      name: typeof segment?.name === "string" ? segment.name : "",
      status: ["passed", "issues", "pending"].includes(segment?.status) ? segment.status : "pending"
    })) : (attempt?.files || []).filter(file => file.kind === "png").map(file => ({ name: file.name, status: "pending" }));
    const passed = segments.filter(segment => segment.status === "passed").length;
    const issues = segments.filter(segment => segment.status === "issues").length;
    const pending = segments.filter(segment => segment.status === "pending").length;
    return { total: segments.length, reviewed: passed + issues, passed, issues, pending, segments };
  }

  function renderQaProgress(attempt) {
    const qa = qaCounts(attempt);
    const percent = qa.total ? Math.min(100, Math.round((qa.reviewed / qa.total) * 100)) : 0;
    el["qa-progress"].classList.remove("d-none");
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
    el["png-modal-title"].title = file.name;
    el["png-counter"].textContent = `${index + 1} / ${state.gallery.length}`;
    el["png-prev"].disabled = index === 0;
    el["png-next"].disabled = index === state.gallery.length - 1;
    if (el["png-modal"].classList.contains("show") && (document.activeElement.disabled || !el["png-modal"].contains(document.activeElement))) el["png-modal"].focus({ preventScroll: true });
    window.ModalActions.set('png-modal', { url: file.href, name: file.name, image: true });
    if (el["png-full"].getAttribute("src") !== file.href) {
      el["png-error"].classList.add("d-none");
      el["png-full"].alt = `Снимок сегмента ${file.name}, попытка ${state.selectedAttemptNumber}`;
      el["png-full"].src = file.href;
      el["png-full"].parentElement.scrollTo(0, 0);
    }
  }

  function drawGallery() {
    el['png-gallery'].querySelectorAll('.image-status').forEach(item => window.tabler.Tooltip.getInstance(item)?.dispose());
    clear(el["png-gallery"]);
    state.gallery.forEach((file, index) => {
      const column = document.createElement("div");
      column.className = "col-12 col-md-6 col-xxl-4";
      const card = document.createElement("div");
      card.className = "card image-card h-100";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "btn w-100";
      open.dataset.fileName = file.name;
      open.dataset.fileHref = file.href;
      open.setAttribute("aria-label", `Просмотреть ${file.name}`);
      const img = document.createElement("img");
      img.className = "gallery-thumb w-100";
      img.src = file.href;
      img.alt = `Снимок сегмента ${file.name}`;
      img.loading = "lazy";
      open.append(img);
      const status = document.createElement("div");
      status.className = "thumbnail-status";
      replaceImageStatus(status, file);
      img.addEventListener("error", () => {
        file.loadError = true;
        replaceImageStatus(status, file);
      });
      card.append(open, status);
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
        const generation = ++state.refreshGeneration;
        const data = await api("/api/state");
        renderState(data || {}, generation);
        if (!state.shutdownRequested) {
          setConnection(true, "Подключено");
          if (!state.shutdownError) showGlobalError("");
        }
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

  function disconnected() {
    state.stopped = true;
    if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
    state.eventSource?.close();
    setConnection(false, "Отключено", "disconnected");
  }

  async function waitForDisconnect() {
    while (state.shutdownRequested && !state.stopped) {
      await new Promise(resolve => window.setTimeout(resolve, 100));
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 1000);
      try {
        await fetch("/api/state", { headers: { Accept: "application/json" }, signal: controller.signal, cache: "no-store" });
      } catch (error) {
        if (error?.name === "AbortError") continue;
        disconnected();
        return;
      } finally {
        window.clearTimeout(timeout);
      }
    }
  }

  async function requestShutdown() {
    if (state.shutdownRequested || state.stopped) return;
    state.shutdownRequested = true;
    if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
    state.eventSource?.close();
    setConnection(false, "Отключение…", "stopping");
    showGlobalError("");
    try {
      await api("/api/shutdown", { method: "POST", body: "{}" });
    } catch (error) {
      if (!error.status) { void waitForDisconnect(); return; }
      if (error.status === 409) { void waitForDisconnect(); return; }
      state.shutdownRequested = false;
      setConnection(true, "Подключено");
      showGlobalError(`Не удалось выключить backend: ${error.message}`);
      state.shutdownError = true;
      connectEvents();
      void poll();
      return;
    }
    void waitForDisconnect();
  }

  async function poll() {
    if (state.stopped) return;
    try {
      await refreshState();
    } catch (error) {
      if (!state.shutdownRequested) {
        setConnection(false, "Переподключение…");
        showGlobalError(`Сервер недоступен: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (!state.stopped && !state.shutdownRequested) state.pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
    }
  }

  function syncStepGeometry() {
    const steps = [...el["result-steps"].querySelectorAll(".step-item")];
    const firstLabel = steps[0].querySelector(".step-label").getBoundingClientRect();
    const lastLabel = steps.at(-1).querySelector(".step-label").getBoundingClientRect();
    const firstMarker = firstLabel.left + firstLabel.width / 2;
    const lastMarker = lastLabel.left + lastLabel.width / 2;
    const spacing = (lastMarker - firstMarker) / (steps.length - 1);
    if (spacing <= 0) return;
    const markers = steps.map((step, index) => {
      const bounds = step.getBoundingClientRect();
      const marker = firstMarker + spacing * index;
      if (index > 0 && index < steps.length - 1) {
        step.style.setProperty("--step-label-offset", `${marker - bounds.left - bounds.width / 2}px`);
        step.style.setProperty("--step-label-max-width", `${Math.max(0, 2 * Math.min(marker - bounds.left, bounds.right - marker))}px`);
      }
      step.style.setProperty("--step-marker-left", `${marker - bounds.left}px`);
      return marker;
    });
    steps.slice(1).forEach((step, index) => {
      const width = markers[index + 1] - markers[index];
      if (width > 0) step.style.setProperty("--step-connector-width", `${width}px`);
    });
  }

  const stepGeometryObserver = new ResizeObserver(syncStepGeometry);
  stepGeometryObserver.observe(el["result-steps"]);
  document.fonts?.ready.then(syncStepGeometry);
  syncStepGeometry();

  el["batch-form"].addEventListener("submit", submitUrl);
  el["connection-control"].addEventListener("click", requestShutdown);
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
    window.ArmEditors.destroy('json-output');
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
    state.stageContextKey = null;
    state.stageManuallySelected = false;
    state.logsKey = null;
    renderDetail();
    refreshSelectedLogs(true);
  });
  el["recapture-button"].addEventListener("click", () => writeAction(state.selectedJobId, "retry", el["recapture-button"]));
  el["stage-step-1"].addEventListener("click", event => { event.preventDefault(); selectStage(1, { focus: false }); });
  el["stage-step-2"].addEventListener("click", event => { event.preventDefault(); selectStage(2, { focus: false }); });
  el["stage-step-3"].addEventListener("click", event => { event.preventDefault(); selectStage(3, { focus: false }); });
  for (const id of ["stage-step-1", "stage-step-2", "stage-step-3"]) el[id].addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const available = [el["stage-step-1"], el["stage-step-2"], el["stage-step-3"]].filter(step => step.getAttribute("aria-disabled") !== "true");
    const current = Math.max(0, available.indexOf(event.currentTarget));
    const index = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
    event.preventDefault();
    selectStage(Number(available[index].id.at(-1)), { focus: true });
  });
  window.addEventListener("beforeunload", () => {
    state.stopped = true;
    stepGeometryObserver.disconnect();
    if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
    state.eventSource?.close();
  });

  connectEvents();
  poll();
})();
