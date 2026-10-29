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
    needs_review: "Проверка не завершена",
    incomplete: "Неполный результат",
    failed: "Ошибка",
    cancelled: "Отменено",
    interrupted: "Прервано",
    builderQueued: "Сборка в очереди",
    builderRunning: "Собирается",
    builderFailed: "Ошибка сборки",
    builderCancelled: "Сборка остановлена"
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
    reasoningKey: null,
    reasoningFollow: true,
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
    localConnection: "reconnecting",
    localFailures: 0,
    polling: false,
    submitting: false,
    pendingActions: new Map(),
    jobDragId: null,
    jobReorderPending: false,
    builderActionError: null
  };

  const el = Object.fromEntries([
    "connection-control", "connection-icon", "connection-message", "concurrency-value", "global-alert",
    "batch-form", "url-input", "clear-url", "url-feedback", "submit-button", "batch-result", "progress-label",
    "progress-bar", "jobs-body", "empty-detail", "concurrency-slider", "settings-error",
    "job-detail", "detail-url", "company-id", "result-steps", "attempt-duration", "detail-id",
    "detail-created", "attempt-meta", "files-list", "recapture-button",
    "stage-step-1", "stage-step-2", "stage-step-3", "gallery-body",
    "metadata-panel", "stage-two-panel", "stage-three-panel", "builder-error", "attempt-header",
    "technical-area", "attempt-panel", "media-source-panel", "media-source-meta", "media-outcome-panel", "media-outcome-status", "media-outcome-meta",
    "reasoning-output", "reasoning-truncated", "png-gallery",
    "qa-progress", "qa-progress-count", "qa-progress-bar", "media-progress", "media-progress-count", "media-progress-bar", "builder-progress", "builder-progress-count", "builder-progress-bar",
    "png-modal", "png-modal-title", "png-counter", "png-remark",
    "png-full", "png-error", "png-prev", "png-next",
    "json-modal", "json-modal-title", "json-output", "json-error"
  ].map((id) => [id, document.getElementById(id)]));

  const CONNECTION_ICONS = {
    "plug-connected": '<path d="M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5"/><path d="M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5"/><path d="M3 21l2.5 -2.5"/><path d="M18.5 5.5l2.5 -2.5"/><path d="M10 11l-2 2"/><path d="M13 14l-2 2"/>',
    "plug-connected-x": '<path d="M20 16l-4 4"/><path d="M7 12l5 5l-1.5 1.5a3.536 3.536 0 1 1 -5 -5l1.5 -1.5"/><path d="M17 12l-5 -5l1.5 -1.5a3.536 3.536 0 1 1 5 5l-1.5 1.5"/><path d="M3 21l2.5 -2.5"/><path d="M18.5 5.5l2.5 -2.5"/><path d="M10 11l-2 2"/><path d="M13 14l-2 2"/><path d="M16 16l4 4"/>',
    "wifi-off": '<path d="M12 18l.01 0"/><path d="M9.172 15.172a4 4 0 0 1 5.656 0"/><path d="M6.343 12.343a7.963 7.963 0 0 1 3.864 -2.14m4.163 .155a7.965 7.965 0 0 1 3.287 2"/><path d="M3.515 9.515a12 12 0 0 1 3.544 -2.455m3.101 -.92a12 12 0 0 1 10.325 3.374"/><path d="M3 3l18 18"/>',
    spinner: '<path d="M12 3a9 9 0 1 1 -9 9"/>',
    "server-off": '<path d="M12 12h-6a3 3 0 0 1 -3 -3v-2c0 -1.083 .574 -2.033 1.435 -2.56m3.565 -.44h10a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-2"/><path d="M16 12h2a3 3 0 0 1 3 3v2m-1.448 2.568a2.986 2.986 0 0 1 -1.552 .432h-12a3 3 0 0 1 -3 -3v-2a3 3 0 0 1 3 -3h6"/><path d="M7 8v.01"/><path d="M7 16v.01"/><path d="M3 3l18 18"/>'
  };

  function renderConnection() {
    let phase = state.localConnection;
    if (phase === "connected") {
      phase = navigator.onLine === false ? "offline" : begetConnection?.connection === "online" ? "connected" : "beget-unavailable";
    }
    const icons = { connected: "plug-connected", offline: "wifi-off", "beget-unavailable": "plug-connected-x", reconnecting: "spinner", stopping: "spinner", stopped: "server-off", unavailable: "server-off" };
    const labels = {
      connected: "Отключить АРМ",
      offline: "Нет интернета · Отключить АРМ",
      "beget-unavailable": "Beget недоступен · Отключить АРМ",
      reconnecting: "Подключение…",
      stopping: "Отключение…",
      stopped: "Запустите АРМ через лаунчер",
      unavailable: "Повторить подключение"
    };
    const control = el["connection-control"];
    control.dataset.state = phase;
    control.dataset.icon = icons[phase];
    control.setAttribute("aria-label", labels[phase]);
    control.title = labels[phase];
    control.setAttribute("aria-disabled", String(phase === "reconnecting" || phase === "stopping" || phase === "stopped"));
    control.setAttribute("aria-busy", String(phase === "reconnecting" || phase === "stopping"));
    el["connection-message"].textContent = labels[phase];
    el["connection-icon"].innerHTML = CONNECTION_ICONS[icons[phase]];
  }

  function setConnection(phase) {
    state.localConnection = phase;
    renderConnection();
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

  function currentAttempt(job) {
    const attempts = Array.isArray(job?.attempts) ? job.attempts : [];
    return attempts.length ? attempts[attempts.length - 1] : null;
  }

  function effectiveStatus(job) {
    const attempt = currentAttempt(job);
    return String(job.status || (attempt && attempt.status) || "unknown").toLowerCase();
  }

  // Only a stable step 3 failure counts as an error: an auto-retry (retryAt)
  // and pending block reviews are waiting states, not failures.
  function stableBuilderFailure(job) {
    const builder = currentAttempt(job)?.builder;
    return effectiveStatus(job) === "complete" && builder?.status === "failed" && builder.retryAt === undefined;
  }

  function renderFavicon() {
    const icon = document.getElementById("dynamic-favicon");
    if (!icon) return;
    // isActive comes from the server's live child-process map and decides whether
    // the blue state is active. Its number is the current workload: each live or
    // queued job once, including the unlikely overlap of both signals.
    const active = state.jobs.some((job) => job.isActive === true);
    const workload = state.jobs.filter((job) => job.isActive === true || effectiveStatus(job) === "queued").length;
    const errors = state.jobs.filter((job) => ERROR_STATUSES.has(effectiveStatus(job)) || stableBuilderFailure(job)).length;
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
    const timeout = window.setTimeout(() => controller.abort(new DOMException("Превышено время ожидания", "TimeoutError")), options.timeoutMs || 10000);
    headers.set("Accept", "application/json");
    if (options.body !== undefined) {
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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
    const ready = state.jobs.filter(fullyReady).length;
    const percent = total ? Math.round((ready / total) * 100) : 0;
    el["progress-label"].textContent = `${ready} / ${total}`;
    el["progress-label"].setAttribute("aria-label", `Готово ${ready} из ${total}`);
    el["progress-bar"].style.width = `${percent}%`;
    el["progress-bar"].parentElement.setAttribute("aria-valuenow", String(percent));
  }

  function actionIcon(name) {
    if (name === "running") {
      const graphic = document.createElement("span");
      graphic.className = "icon queue-status-pulse-icon";
      graphic.setAttribute("aria-hidden", "true");
      const indicator = document.createElement("span");
      indicator.className = "status-dot status-dot-animated bg-blue";
      graphic.append(indicator);
      return graphic;
    }
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ class: "icon", width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
    const shapes = {
      pause: [["path", { d: "M6 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12" }], ["path", { d: "M14 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12" }]],
      clock: [["path", { d: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" }], ["path", { d: "M12 7v5l3 3" }]],
      check: [["path", { d: "M5 12l5 5l10 -10" }]],
      alert: [["path", { d: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" }], ["path", { d: "M12 8v4" }], ["path", { d: "M12 16h.01" }]],
      imageClock: [["path", { d: "M12 5v7l5 3" }]],
      imageCheck: [["path", { d: "M5 12l5 5l10 -10" }]],
      imageAlert: [["path", { d: "M12 5v10" }], ["path", { d: "M12 19h.01" }]],
      square: [["path", { d: "M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -10" }]]
    };
    for (const [tag, attributes] of shapes[name] || shapes.alert) {
      const node = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      svg.append(node);
    }
    return svg;
  }

  function actionButton(job, action, label, icon, color, secondary = false, statusKey = null) {
    const status = statusKey || effectiveStatus(job);
    const pending = state.pendingActions.get(job.id) || state.pendingActions.get(`assemble:${job.id}`);
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
    if (icon === "running") graphic.firstElementChild.className = `status-dot status-dot-animated bg-${color}`;
    button.append(graphic);
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (!action) return;
      if (action.startsWith("assemble")) {
        if (!state.pendingActions.has(`assemble:${job.id}`)) void writeBuilderAction(job, action, button);
        return;
      }
      if (!state.pendingActions.has(job.id)) writeAction(job.id, action, button);
    });
    button.addEventListener("keydown", event => event.stopPropagation());
    const wrapper = document.createElement("span");
    wrapper.className = "queue-status-control";
    wrapper.append(button);
    wrapper.addEventListener("click", event => { if (button.disabled) event.stopPropagation(); });
    wrapper.addEventListener("keydown", event => { if (button.disabled) event.stopPropagation(); });
    updateActionTooltip(button);
    return wrapper;
  }

  function updateActionTooltip(button) {
    const title = button.dataset.problem || `${STATUS_LABELS[button.dataset.status] || button.dataset.status} · ${button.disabled ? "Недоступно" : button.dataset.actionLabel}`;
    button.title = title;
    button.setAttribute("aria-label", `${title} · ${button.dataset.jobUrl}`);
    const wrapper = button.parentElement;
    window.tabler.Tooltip.getInstance(wrapper)?.dispose();
    const informational = Boolean(button.dataset.problem || !button.dataset.action);
    if (informational) { wrapper.tabIndex = 0; wrapper.setAttribute("role", "img"); wrapper.setAttribute("aria-label", title); }
    new window.tabler.Tooltip(wrapper, { trigger: informational ? "hover focus" : "hover", title, html: false, animation: false });
  }

  // Step 3 statuses of a complete attempt; the first match top-down wins.
  // assemble-pause cannot pause a scheduled auto-retry (the backend answers
  // 409), so that substate looks identical but clicks assemble-cancel.
  function builderQueueControl(job, attempt) {
    const builder = attempt?.builder;
    const autoRetry = builder?.status === "failed" && builder.retryAt !== undefined;
    let action, label, icon, color, statusKey = "complete", problem = "";
    if (!builder) [action, label, icon, color, statusKey] = ["assemble", "Продолжить", "pause", "secondary", "paused"];
    else if (builder.status === "queued" || autoRetry) [action, label, icon, color, statusKey] = [autoRetry ? "assemble-cancel" : "assemble-pause", "Приостановить", "clock", "blue", "builderQueued"];
    else if (builder.status === "running") [action, label, icon, color, statusKey] = ["assemble-pause", "Приостановить", "running", "blue", "builderRunning"];
    else if (builder.status === "pausing") [action, label, icon, color, statusKey] = [null, "Недоступно", "running", "secondary", "pausing"];
    else if (builder.status === "paused") [action, label, icon, color, statusKey] = ["assemble-resume", "Продолжить", "pause", "secondary", "paused"];
    else if (builder.status === "failed") [action, label, icon, color, statusKey] = ["assemble", "Пересобрать", "alert", "red", "builderFailed"];
    else if (builder.status === "cancelled") [action, label, icon, color, statusKey] = ["assemble", "Собрать страницу", "square", "secondary", "builderCancelled"];
    else if (attempt?.pageBuilder?.status === "failed") [action, label, icon, color, problem] = [null, "Проверка не пройдена", "alert", "yellow", "Проверка не пройдена"];
    else if (fullyReady(job)) [action, label, icon, color] = [job.canRecapture ? "retry" : null, "Перезапустить", "check", "green"];
    else [action, label, icon, color, problem] = [null, "Ждёт проверки", "check", "secondary", "Ждёт проверки"];
    if (builder?.finalizationError) action = null; // вердикт ещё не записан: ручные действия сборки отвечают 409
    const control = actionButton(job, action, label, icon, color, false, statusKey);
    if (problem) {
      control.dataset.jobWarning = job.id;
      const button = control.querySelector("button");
      button.dataset.problem = problem;
      updateActionTooltip(button);
    }
    return control;
  }

  // A fully finished task is exactly the queue checkmark: the attempt completed
  // steps 1-2, no assembly is in flight and every block passed review. The
  // progress bar counts only these, so the bar and the checkmark cannot diverge.
  function fullyReady(job) {
    const attempt = currentAttempt(job), builder = attempt?.builder;
    return effectiveStatus(job) === "complete" && Boolean(builder)
      && !["queued", "running", "pausing", "paused", "failed", "cancelled"].includes(builder.status)
      && attempt.pageBuilder?.status === "passed";
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
    if (status === "complete") return [builderQueueControl(job, attempt)];
    const mapping = {
      paused: [job.canResume ? "resume" : null, "Продолжить", "pause", "secondary"],
      queued: ["pause", "Приостановить", "clock", "blue"],
      running: [job.canPause ? "pause" : null, "Приостановить", "running", "blue"],
      pausing: [null, "Недоступно", "running", "secondary"],
      validating: [job.canPause ? "pause" : null, "Приостановить", "running", "blue"],
      stopping: [null, "Недоступно", "running", "secondary"],
      needs_review: [job.canRecapture ? "retry" : null, "Перезапустить", "alert", "red"],
      incomplete: [job.canRecapture ? "retry" : null, "Перезапустить", "alert", "red"],
      failed: [job.canRecapture ? "retry" : null, "Перезапустить", "alert", "red"],
      interrupted: [job.canResume ? "resume" : job.canRecapture ? "retry" : null, job.canResume ? "Продолжить" : "Перезапустить", "alert", "red"],
      cancelled: [job.canRecapture ? "retry" : null, "Перезапустить", "square", "secondary"]
    };
    const action = mapping[status] || [null, "Недоступно", "alert", "secondary"];
    return [actionButton(job, ...action)];
  }

  function renderJobs() {
    if (state.jobDragId || state.jobReorderPending) return;
    const focused = el["jobs-body"].contains(document.activeElement) ? document.activeElement : null;
    const focusedWarning = focused?.dataset.jobWarning;
    const focusedDrag = focused?.dataset.jobDrag;
    const focusedId = focused?.dataset.jobAction || focused?.dataset.jobSecondaryAction || focused?.dataset.jobSelect || focusedWarning;
    const focusedAction = Boolean(focused?.dataset.jobAction || focused?.dataset.jobSecondaryAction);
    const focusedOperation = focused?.dataset.action;
    el["jobs-body"].querySelectorAll(".queue-status-control").forEach(wrapper => window.tabler.Tooltip.getInstance(wrapper)?.dispose());
    clear(el["jobs-body"]);
    if (!state.jobs.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 3;
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

      const handleCell = document.createElement("td");
      handleCell.className = "job-drag-cell";
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "job-drag-handle";
      handle.draggable = true;
      handle.dataset.jobDrag = job.id;
      handle.setAttribute("aria-label", `Переставить задачу ${job.url || job.id}`);
      handle.title = "Перетащить задачу; стрелки вверх и вниз меняют порядок";
      handle.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/></svg>';
      handle.addEventListener("click", event => event.stopPropagation());
      handle.addEventListener("keydown", event => {
        event.stopPropagation();
        if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const rows = [...el["jobs-body"].querySelectorAll("tr[data-job-id]")];
        const index = rows.findIndex(item => item.dataset.jobId === job.id);
        const neighbour = rows[index + (event.key === "ArrowUp" ? -1 : 1)];
        if (neighbour) void moveJob(job.id, neighbour.dataset.jobId, event.key === "ArrowDown", true);
      });
      handle.addEventListener("dragstart", event => {
        if (state.jobReorderPending) { event.preventDefault(); return; }
        state.jobDragId = job.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", job.id);
      });
      handle.addEventListener("dragend", () => { state.jobDragId = null; renderJobs(); });
      handleCell.append(handle);

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
      // The live thought line runs under the title while the task is at work.
      if (attempt?.reasoningLine && ACTIVE_STATUSES.has(effectiveStatus(job))) {
        const thought = document.createElement("div");
        thought.className = "small text-secondary job-reasoning-line";
        thought.textContent = attempt.reasoningLine;
        thought.title = attempt.reasoningLine;
        urlCell.append(thought);
      }

      const statusCell = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "d-inline-flex gap-1";
      actions.append(...queueActions(job));
      statusCell.append(actions);

      statusCell.className = "text-end";
      row.append(handleCell, urlCell, statusCell);
      row.addEventListener("dragover", event => {
        if (!state.jobDragId || state.jobDragId === job.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.classList.toggle("job-drop-after", event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
        row.classList.toggle("job-drop-before", !row.classList.contains("job-drop-after"));
      });
      row.addEventListener("dragleave", () => row.classList.remove("job-drop-before", "job-drop-after"));
      row.addEventListener("drop", event => {
        if (!state.jobDragId || state.jobDragId === job.id) return;
        event.preventDefault(); event.stopPropagation();
        const sourceId = state.jobDragId;
        const after = event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
        state.jobDragId = null;
        row.classList.remove("job-drop-before", "job-drop-after");
        void moveJob(sourceId, job.id, after, false);
      });
      const select = () => selectJob(job.id);
      row.addEventListener("click", select);
      row.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select();
      });
      el["jobs-body"].append(row);
    });
    if (focusedDrag) el["jobs-body"].querySelector(`[data-job-drag="${focusedDrag}"]`)?.focus({ preventScroll: true });
    if (focusedId) {
      const controls = [...el["jobs-body"].querySelectorAll("[data-job-action], [data-job-secondary-action], [data-job-select], [data-job-warning]")];
      const target = controls.find(control => (focusedWarning ? control.dataset.jobWarning : focusedAction ? (control.dataset.jobAction || control.dataset.jobSecondaryAction) : control.dataset.jobSelect) === focusedId &&
        (!focusedAction || control.dataset.action === focusedOperation) && !control.disabled) || controls.find(control => control.dataset.jobSelect === focusedId);
      target?.focus({ preventScroll: true });
    }
  }

  async function moveJob(sourceId, targetId, after, restoreFocus) {
    if (state.jobReorderPending) return;
    const expected = state.jobs.map(job => job.id).reverse();
    const order = expected.filter(id => id !== sourceId);
    const targetIndex = order.indexOf(targetId);
    if (targetIndex < 0 || !expected.includes(sourceId)) return;
    order.splice(targetIndex + (after ? 1 : 0), 0, sourceId);
    if (order.every((id, index) => id === expected[index])) { renderJobs(); return; }
    state.jobReorderPending = true;
    showGlobalError("");
    let reorderError = null;
    try {
      await api("/api/jobs/reorder", { method: "POST", body: JSON.stringify({ expected, order }) });
    } catch (error) {
      reorderError = error;
    } finally {
      if (state.refreshPromise) {
        try { await state.refreshPromise; } catch (error) { reorderError ||= error; }
      }
      state.jobReorderPending = false;
      try { await refreshState(); }
      catch (error) { reorderError ||= error; renderJobs(); }
      if (reorderError) showGlobalError(`Не удалось переставить задачу: ${reorderError.message}`);
      if (restoreFocus) el["jobs-body"].querySelector(`[data-job-drag="${sourceId}"]`)?.focus({ preventScroll: true });
    }
  }

  function renderAttempt(job, attempt) {
    clear(el["attempt-meta"]);
    clear(el["files-list"]);
    if (!attempt) {
      el["attempt-meta"].textContent = "Данных ещё нет.";
      renderQaProgress(null);
      return;
    }

    const list = document.createElement("dl");
    list.className = "row mb-0";
    [
      ["Начало", formatDate(attempt.startedAt)],
      ["Текущая фаза", attempt.phase || "—"],
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

  // The header restart button is contextual: step 1 keeps the full retry, step 2
  // restarts from the captured materials, step 3 assembles the page (a click
  // during a live assembly stops it and starts a fresh one). Every action
  // targets the latest attempt whatever attempt the detail view selects.
  const RESTART_HINTS = { 1: "Перезапустить задачу", 2: "Перезапустить с шага 2", 3: "Пересобрать страницу" };

  function renderRecapture(job, attempt) {
    const recapture = el["recapture-button"];
    const hint = RESTART_HINTS[state.activeStage] || RESTART_HINTS[1];
    recapture.title = hint;
    recapture.setAttribute("aria-label", hint);
    const pendingJob = job ? state.pendingActions.get(job.id) : null;
    const pendingAssemble = job ? state.pendingActions.get(`assemble:${job.id}`) : null;
    const busy = Boolean(pendingJob) || Boolean(pendingAssemble);
    let loading = false;
    if (state.activeStage === 3) {
      loading = pendingAssemble?.action === "assemble";
      recapture.disabled = !job || busy;
    } else if (state.activeStage === 2) {
      const target = currentAttempt(job);
      const eligible = target?.phase === "html-media" && target?.captureStatus === "complete";
      loading = pendingJob?.action === "retry-stage";
      recapture.disabled = !job || !eligible || busy;
    } else {
      loading = pendingJob?.action === "retry";
      recapture.disabled = !job || !job.canRecapture || busy;
    }
    recapture.classList.toggle("btn-loading", loading);
    recapture.setAttribute("aria-busy", String(loading));
  }

  // Assembly failures belong to the step 3 panel of the selected attempt, like
  // step 1-2 errors stay inside their stage; the global alert stays app-level.
  function renderBuilderError(job, attempt) {
    const builder = attempt?.builder;
    const failure = builder?.status === "failed" && builder.error ? `Ошибка сборки: ${builder.error}` : "";
    const actionError = state.builderActionError && state.builderActionError.jobId === job?.id ? state.builderActionError.message : "";
    const message = failure || actionError;
    el["builder-error"].textContent = message;
    el["builder-error"].classList.toggle("d-none", !message);
  }

  // Every builder action shares the assemble:<id> pending key: one in-flight
  // request fences the queue button, the header restart button and repeats.
  async function writeBuilderAction(job, action, button) {
    if (!job || state.pendingActions.has(`assemble:${job.id}`) || state.pendingActions.has(job.id)) return;
    const attempts = Array.isArray(job.attempts) ? job.attempts : [];
    if (!attempts.length) return; // сборка действует только на последнюю попытку
    const pending = { action, confirmAfterGeneration: Number.POSITIVE_INFINITY };
    state.pendingActions.set(`assemble:${job.id}`, pending);
    state.builderActionError = null;
    renderDetail();
    if (state.selectedJobId === job.id) {
      const recapture = document.getElementById("recapture-button");
      if (recapture) { recapture.disabled = true; recapture.classList.toggle("btn-loading", recapture === button); recapture.setAttribute("aria-busy", String(recapture === button)); }
    }
    for (const control of el["jobs-body"].querySelectorAll("[data-job-action], [data-job-secondary-action]")) {
      if ((control.dataset.jobAction || control.dataset.jobSecondaryAction) !== job.id) continue;
      control.disabled = true;
      control.setAttribute("aria-disabled", "true");
      const clicked = control === button;
      control.setAttribute("aria-busy", String(clicked));
      updateActionTooltip(control);
    }
    let accepted = false;
    try {
      await api(`/api/page-builder/${encodeURIComponent(job.id)}/${action}`, {
        method: "POST",
        body: action === "assemble" ? JSON.stringify({ force: true }) : "{}"
      });
      accepted = true;
      // A state request that began before this POST succeeded may contain the
      // old action. Keep loading until a later snapshot confirms it.
      pending.confirmAfterGeneration = state.refreshGeneration + 1;
      if (!state.refreshPromise) await refreshState();
    } catch (error) {
      state.builderActionError = { jobId: job.id, message: error instanceof Error ? error.message : String(error) };
      if (!accepted) {
        state.pendingActions.delete(`assemble:${job.id}`);
        renderJobs();
        renderDetail();
      }
    }
  }

  async function assemblePage(job) {
    await writeBuilderAction(job, "assemble", el["recapture-button"]);
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
    const builderState = attempt?.pageBuilder?.status;
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
    // The reasoning journal belongs to the step's agent: visible on steps 1
    // (QA) and 3 (builder); step 2 has no agent and hides the card.
    el["attempt-panel"].classList.toggle("d-none", state.activeStage === 2);
    el["stage-two-panel"].classList.toggle("d-none", state.activeStage !== 2);
    el["stage-three-panel"].classList.toggle("d-none", state.activeStage !== 3);
    el["qa-progress"].classList.toggle("stage-hidden", !firstStage);
    el["media-progress"].classList.toggle("stage-hidden", state.activeStage !== 2);
    el["builder-progress"].classList.toggle("stage-hidden", state.activeStage !== 3);
    renderBuilderError(job, attempt);
    window.HtmlMedia.render(job, attempt, { csrfToken: state.csrfToken, refresh: () => refreshState() });
    renderRecapture(job, attempt);
    if (state.activeStage === 3) window.PageBuilder.render(job, { api, attempt, refresh: () => refreshState() });
  }

  function selectStage(stage, { focus = false } = {}) {
    const job = state.jobs.find(candidate => candidate.id === state.selectedJobId), attempt = job && currentAttempt(job);
    if (!stageAvailable(stage, attempt)) return;
    state.activeStage = stage;
    state.stageManuallySelected = true;
    renderStages(job, attempt);
    refreshSelectedReasoning(true);
    if (focus) el[`stage-step-${stage}`].focus({ preventScroll: true });
  }

  function formatDuration(attempt, timestamp = Date.now()) {
    const elapsed = Math.max(0, Number(attempt?.activeDurationMs) || 0);
    // Same predicate as the backend timer: a step 3 assembly keeps a complete
    // attempt at work, so its interval is extrapolated like a running one.
    const timed = ["running", "validating", "pausing", "stopping"].includes(attempt?.status) || ["running", "pausing"].includes(attempt?.builder?.status);
    const active = timed && Number.isFinite(attempt?.activeSince);
    const seconds = Math.floor((elapsed + (active ? Math.max(0, timestamp - attempt.activeSince) : 0)) / 1000);
    return `${attempt?.durationIncomplete ? "≥" : ""}${[Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":")}`;
  }

  function renderDuration() {
    const job = state.jobs.find(candidate => candidate.id === state.selectedJobId);
    const attempt = job && currentAttempt(job);
    el["attempt-duration"].textContent = formatDuration(attempt);
    el["attempt-duration"].title = "Активное время работы";
  }

  function renderDetail() {
    const job = state.jobs.find((candidate) => candidate.id === state.selectedJobId);
    if (!job) {
      state.selectedJobId = null;
      state.reasoningKey = null;
      el["empty-detail"].classList.remove("d-none");
      el["job-detail"].classList.add("d-none");
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
    const attempt = currentAttempt(job);
    const companyId = Number(attempt?.pageBuilder?.companyId);
    const companyIdAvailable = Number.isSafeInteger(companyId) && companyId > 0;
    const companyIdControl = el["company-id"];
    companyIdControl.textContent = companyIdAvailable ? `ID: ${companyId}` : "ID: —";
    companyIdControl.classList.toggle("disabled", !companyIdAvailable);
    companyIdControl.setAttribute("aria-disabled", String(!companyIdAvailable));
    if (companyIdAvailable) {
      companyIdControl.href = `http://reestr35.seperb3i.beget.tech/company/?company=${companyId}`;
      companyIdControl.target = "_blank";
      companyIdControl.rel = "noopener noreferrer";
      companyIdControl.removeAttribute("tabindex");
      companyIdControl.setAttribute("aria-label", `Открыть новую страницу компании ID ${companyId}`);
      companyIdControl.title = `Открыть новую страницу компании ID ${companyId}`;
    } else {
      companyIdControl.removeAttribute("href");
      companyIdControl.removeAttribute("target");
      companyIdControl.removeAttribute("rel");
      companyIdControl.tabIndex = -1;
      companyIdControl.setAttribute("aria-label", "ID компании ещё не получен");
      companyIdControl.title = "ID компании ещё не получен";
    }
    el["detail-id"].textContent = String(job.id || "—");
    el["detail-created"].textContent = formatDate(job.createdAt);

    renderDuration();
    renderAttempt(job, attempt);
    renderStages(job, attempt);
  }

  let begetConnection = null;
  window.addEventListener('online', renderConnection);
  window.addEventListener('offline', renderConnection);
  function renderState(data, generation = state.refreshGeneration) {
    begetConnection = data.beget || null; renderConnection();
    if (state.jobDragId || state.jobReorderPending) return;
    state.csrfToken = typeof data.csrfToken === "string" ? data.csrfToken : "";
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    // The backend checkpoints active duration every second. Duration is drawn
    // separately below; keeping it out of this fingerprint preserves animated
    // status nodes while all actual status/action changes still rerender.
    const fingerprint = JSON.stringify(jobs, (key, value) => key === "activeDurationMs" || key === "activeSince" ? undefined : value);
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
    } else if (state.activeStage === 3) {
      const job = jobs.find(item => item.id === state.selectedJobId), attempt = job && currentAttempt(job);
      if (job && thirdStageAvailable(attempt)) void window.PageBuilder.render(job, { api, attempt, refresh: () => refreshState() });
    }
    renderDuration();
  }

  function selectJob(id) {
    state.selectedJobId = id;
    state.stageContextKey = null;
    state.stageManuallySelected = false;
    state.reasoningKey = null;
    renderJobs();
    renderDetail();
    refreshSelectedReasoning(true);
  }

  async function writeAction(id, action, button, requestBody = "{}") {
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
        body: requestBody
      });
      accepted = true;
      if ((action === "retry" || action === "retry-stage") && state.selectedJobId === id) {
        state.activeStage = action === "retry" ? 1 : 2; state.stageContextKey = null; state.stageManuallySelected = false;
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

  // A review remark belongs to its image: it replaces the generic "Есть
  // замечания" label wherever the badge is shown, cut with an ellipsis when
  // too long for a tooltip or the frame modal footer.
  function imageRemark(file, limit = 300) {
    if (file?.qaStatus !== "issues") return "";
    const text = (Array.isArray(file.qaIssues) ? file.qaIssues.filter(item => typeof item === "string" && item.trim()) : []).join("; ").trim();
    return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
  }

  function imageStatusBadge(file) {
    const qaStatus = ["unreviewed", "passed", "issues"].includes(file.qaStatus) ? file.qaStatus : "unreviewed";
    const status = file.loadError ? "load_error" : qaStatus;
    const labels = { unreviewed: "Не проверено", passed: "Проверено", issues: "Есть замечания", load_error: "PNG не загружен" };
    const classes = { unreviewed: "bg-secondary", passed: "bg-green", issues: "bg-yellow", load_error: "bg-red" };
    const label = status === "issues" ? imageRemark(file) || labels.issues : labels[status];
    const span = document.createElement("span");
    span.className = `image-status ${classes[status]}`;
    span.dataset.imageStatus = status;
    span.tabIndex = 0; span.setAttribute('role', 'img'); span.setAttribute('aria-label', label); span.title = label;
    span.append(actionIcon(status === 'passed' ? 'imageCheck' : status === 'unreviewed' ? 'imageClock' : 'imageAlert'));
    span.addEventListener('click', event => event.stopPropagation());
    // Polling can replace a focused status immediately after blur; avoid a
    // pending hide transition calling into a disposed Tabler tooltip.
    new window.tabler.Tooltip(span, { title: label, trigger: 'hover focus', html: false, animation: false });
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
    const remark = imageRemark(file, 1000);
    el["png-remark"].textContent = remark ? `Замечание: ${remark}` : "";
    el["png-remark"].title = remark;
    el["png-remark"].classList.toggle("d-none", !remark);
    if (el["png-modal"].classList.contains("show") && (document.activeElement.disabled || !el["png-modal"].contains(document.activeElement))) el["png-modal"].focus({ preventScroll: true });
    window.ModalActions.set('png-modal', { url: file.href, name: file.name, image: true });
    if (el["png-full"].getAttribute("src") !== file.href) {
      el["png-error"].classList.add("d-none");
      el["png-full"].alt = `Снимок сегмента ${file.name}`;
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

  async function fetchReasoning(jobId, attemptNumber, stage) {
    return api(`/api/reasoning/${encodeURIComponent(jobId)}/${encodeURIComponent(attemptNumber)}?stage=${stage}`);
  }

  // The journal shows the full reasoning stream of the current step's agent:
  // step 1 reads the QA reasoning.log, step 3 the builder's builder-reasoning.log;
  // step 2 has no agent, its hidden card is never fetched.
  async function refreshSelectedReasoning(force = false) {
    const job = state.jobs.find((candidate) => candidate.id === state.selectedJobId);
    const attempt = job && currentAttempt(job);
    const output = el["reasoning-output"];
    if (!job || !attempt || state.activeStage === 2) {
      if (!job || !attempt) {
        output.textContent = "Нет данных";
        el["reasoning-truncated"].classList.add("d-none");
      }
      return;
    }
    const stage = state.activeStage === 3 ? 3 : 1;
    const key = `${job.id}:${attempt.number}:${stage}`;
    if (force || state.reasoningKey !== key) {
      state.reasoningKey = key;
      state.reasoningFollow = true;
      output.textContent = "Загрузка…";
      output.scrollTop = 0;
    }
    let data;
    try {
      data = await fetchReasoning(job.id, attempt.number, stage);
    } catch (error) {
      if (state.reasoningKey !== key) return;
      output.textContent = `Не удалось загрузить журнал: ${error instanceof Error ? error.message : String(error)}`;
      el["reasoning-truncated"].classList.add("d-none");
      return;
    }
    if (state.reasoningKey !== key) return;
    output.textContent = data && data.text ? data.text : "Журнал пуст";
    el["reasoning-truncated"].classList.toggle("d-none", !(data && data.truncated));
    if (state.reasoningFollow) output.scrollTop = output.scrollHeight;
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
          state.localFailures = 0;
          setConnection("connected");
          if (!state.shutdownError) showGlobalError("");
        }
        await refreshSelectedReasoning();
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
    state.eventSource.addEventListener("builder", () => {
      refreshState().catch(() => {});
    });
  }

  function disconnected() {
    state.stopped = true;
    if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
    state.eventSource?.close();
    setConnection("stopped");
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
    setConnection("stopping");
    showGlobalError("");
    try {
      await api("/api/shutdown", { method: "POST", body: "{}" });
    } catch (error) {
      if (!error.status) { void waitForDisconnect(); return; }
      if (error.status === 409) { void waitForDisconnect(); return; }
      state.shutdownRequested = false;
      setConnection("connected");
      showGlobalError(`Не удалось выключить backend: ${error.message}`);
      state.shutdownError = true;
      connectEvents();
      void poll();
      return;
    }
    void waitForDisconnect();
  }

  async function poll() {
    if (state.stopped || state.polling) return;
    state.polling = true;
    if (state.pollTimer !== null) window.clearTimeout(state.pollTimer);
    try {
      await refreshState();
    } catch (error) {
      if (!state.shutdownRequested) {
        state.localFailures++;
        setConnection(state.localFailures >= 3 ? "unavailable" : "reconnecting");
        showGlobalError(`Сервер недоступен: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      state.polling = false;
      if (!state.stopped && !state.shutdownRequested) state.pollTimer = window.setTimeout(poll, POLL_INTERVAL_MS);
    }
  }

  function activateConnection() {
    if (state.localConnection === "connected") { void requestShutdown(); return; }
    if (state.localConnection === "unavailable") {
      if (state.polling) { void refreshState().catch(() => {}); return; }
      void poll();
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
  el["connection-control"].addEventListener("click", activateConnection);
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
  el["reasoning-output"].addEventListener("scroll", () => {
    const box = el["reasoning-output"];
    state.reasoningFollow = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  });
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
  el["recapture-button"].addEventListener("click", () => {
    const job = state.jobs.find(candidate => candidate.id === state.selectedJobId);
    if (!job || el["recapture-button"].disabled) return;
    if (state.activeStage === 3) { void assemblePage(job); return; }
    if (state.activeStage === 2) { void writeAction(job.id, "retry-stage", el["recapture-button"], JSON.stringify({ stage: 2 })); return; }
    void writeAction(job.id, "retry", el["recapture-button"]);
  });
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
