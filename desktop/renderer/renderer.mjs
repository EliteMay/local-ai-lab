const MAX_RENDER_LOG_LINES = 800;
const TELEMETRY_ACTIVE_INTERVAL_MS = 5000;
const TELEMETRY_IDLE_INTERVAL_MS = 45000;
const RESPONSE_WAIT_SECONDS = 15;
const LONG_WAIT_SECONDS = 600;

const COMMAND_META = {
  doctor: { label: "接続確認", execute: "接続確認を実行" },
  inspect: { label: "フォルダ確認", execute: "フォルダ確認を実行" },
  coverage: { label: "全体監査", execute: "全体監査を実行" },
  "coverage-synthesize": { label: "結果を統合", execute: "結果の統合を実行" },
  test: { label: "テスト", execute: "テストを実行" }
};

const state = {
  settings: null,
  repository: "",
  selectedCommand: "coverage",
  running: false,
  result: "",
  completedBatches: 0,
  totalBatches: 0,
  completedBatchIds: new Set(),
  batchDurations: [],
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  startedAt: null,
  timerId: null,
  history: [],
  resume: false,
  latestRecoverable: null,
  currentBatch: null,
  currentStage: "実行待ち",
  planFiles: 0,
  planChunks: 0,
  lastOutputAt: null,
  processAlive: null,
  lastBatchDuration: null,
  tokenRates: [],
  telemetryTimerId: null,
  systemMetrics: null,
  updateState: null,
  bonsaiStatus: null,
  currentRunDetails: null,
  currentResultTab: "issues",
  modelCatalogSnapshot: null,
  currentRoutedModel: "",
  currentModelTask: "",
  modelUsageCounts: {},
  modelFallbacks: 0,
  reusedBatches: 0,
  reuseSourceRunId: "",
  modelPollTimerId: null,
  compareBaselineRunId: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function profileLabel(value, routingMode = state.settings?.modelRoutingMode) {
  if (routingMode === "auto") return "自動振り分け";
  if (value === "default") return "標準";
  if (value === "bonsai-2-27b") return "Bonsai 2 27B";
  return value || "不明";
}

function isAutoRouting(mode = state.settings?.modelRoutingMode) {
  return (mode || "auto") === "auto";
}

function isBonsaiProfile(value = state.settings?.modelProfile) {
  return value === "bonsai-2-27b";
}

function updateRoutingSettingsUi() {
  const mode = $("#modelRoutingMode")?.value || state.settings?.modelRoutingMode || "auto";
  const profile = $("#settingsProfile")?.value || state.settings?.modelProfile || "default";
  $("#fixedProfileSetting")?.classList.toggle("hidden", mode !== "fixed");
  if ($("#autoManageModels")) $("#autoManageModels").disabled = mode !== "auto";
  const bonsaiVisible = mode === "auto" || isBonsaiProfile(profile);
  $("#bonsaiRuntimeCard").classList.toggle("hidden", !bonsaiVisible);
  $("#bonsaiSettings").classList.toggle("hidden", !bonsaiVisible);
  setText("#profile", profileLabel(profile, mode));
  updateModelRoutingMetrics();
}

function updateBonsaiVisibility() {
  updateRoutingSettingsUi();
}

function applyBonsaiStatus(next) {
  if (!next) return;
  state.bonsaiStatus = next;

  const labels = {
    stopped: "停止中",
    starting: "起動処理中",
    running: "起動中",
    "external-running": "外部で起動中",
    stopping: "停止処理中",
    error: "エラー"
  };
  setText("#bonsaiRuntimeTitle", labels[next.status] || "状態不明");
  setText("#bonsaiRuntimeMessage", next.message || "");
  const dot = $("#bonsaiRuntimeDot");
  dot.className = "runtime-state-dot " + (next.status || "stopped");

  const active = next.status === "running" || next.status === "external-running";
  $("#startBonsai").classList.toggle("hidden", active || next.status === "starting" || next.status === "stopping");
  $("#stopBonsai").classList.toggle("hidden", !(next.status === "running" && next.managed));
  $("#refreshBonsai").disabled = next.status === "starting" || next.status === "stopping";

  if (!isAutoRouting() && isBonsaiProfile()) {
    setText("#runtime", "PrismML llama.cpp");
    setText("#model", "bonsai-2-27b");
    setText("#connection", active ? "接続中" : next.status === "starting" ? "起動中" : "停止中");
    $("#dot").classList.toggle("online", active);
    $("#dot").classList.toggle("offline", !active);
    setText("#runtimeMini", active ? "AI接続中" : "Bonsai停止中");
  }
}

async function refreshBonsaiStatus() {
  try {
    applyBonsaiStatus(await window.localAI.getBonsaiStatus());
  } catch (error) {
    setText("#bonsaiRuntimeMessage", friendlyError(error.message));
  }
}

async function startBonsaiRuntime() {
  $("#startBonsai").disabled = true;
  setText("#bonsaiRuntimeTitle", "起動中...");
  setText("#bonsaiRuntimeMessage", "Bonsaiの起動を待っています。");
  try {
    applyBonsaiStatus(await window.localAI.startBonsai());
    state.result = "Bonsaiを起動しました。";
    setText("#result", state.result);
  } catch (error) {
    state.result = friendlyError(error.message);
    setText("#result", state.result);
    setText("#bonsaiRuntimeTitle", "起動失敗");
    setText("#bonsaiRuntimeMessage", state.result);
  } finally {
    $("#startBonsai").disabled = false;
  }
}

async function stopBonsaiRuntime() {
  $("#stopBonsai").disabled = true;
  try {
    applyBonsaiStatus(await window.localAI.stopBonsai());
    state.result = "Bonsaiを停止しました。";
    setText("#result", state.result);
  } catch (error) {
    state.result = friendlyError(error.message);
    setText("#result", state.result);
  } finally {
    $("#stopBonsai").disabled = false;
  }
}

async function chooseBonsaiFolder() {
  const path = await window.localAI.selectBonsaiFolder();
  if (!path) return;
  $("#bonsaiDemoPath").value = path;
}


const MODEL_TASK_LABELS = {
  "coverage-general": "一般監査",
  "coverage-code": "コード監査",
  "synthesis-reduction": "結果圧縮",
  planner: "改善案",
  reviewer: "最終レビュー",
  director: "作業計画",
  researcher: "調査",
  auditor: "監査",
  "improvement-planner": "改善案"
};

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return gb.toFixed(gb >= 10 ? 1 : 2) + " GB";
  return (bytes / (1024 ** 2)).toFixed(0) + " MB";
}

function updateModelRoutingMetrics() {
  const mode = $("#modelRoutingMode")?.value || state.settings?.modelRoutingMode || "auto";
  setText("#routingMode", mode === "auto" ? "自動振り分け" : "1モデル固定");
  setText("#currentRoutedModel", state.currentRoutedModel || (mode === "fixed" ? profileLabel(state.settings?.modelProfile, "fixed") : "待機中"));
  setText("#currentModelTask", state.currentModelTask ? (MODEL_TASK_LABELS[state.currentModelTask] || state.currentModelTask) : "—");
  const calls = Object.entries(state.modelUsageCounts)
    .map(([label, count]) => label + " " + count + "回")
    .join(" · ");
  setText("#modelUsageMetric", calls || "—");
  setText("#modelFallbackMetric", state.modelFallbacks + "回");
}

function createModelButton(label, className, handler, disabled = false) {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", handler);
  return button;
}

function renderModelCatalog(snapshot) {
  state.modelCatalogSnapshot = snapshot;
  const list = $("#modelCatalog");
  if (!list) return;
  list.textContent = "";
  setText("#modelProviderStatus", snapshot?.providerMessage || "モデル状態を確認できません。");

  const models = Array.isArray(snapshot?.models) ? snapshot.models : [];
  if (!models.length) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = "モデル一覧を取得できませんでした。";
    list.appendChild(empty);
    return;
  }

  for (const model of models) {
    const card = document.createElement("article");
    card.className = "model-card";

    const top = document.createElement("div");
    top.className = "model-card-head";
    const titleWrap = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = model.label;
    const use = document.createElement("p");
    use.className = "subtle";
    use.textContent = model.useCase || "";
    titleWrap.append(title, use);

    const badges = document.createElement("div");
    badges.className = "model-badges";
    const routeBadge = document.createElement("span");
    routeBadge.className = "badge";
    routeBadge.textContent = model.autoRoute ? "自動候補" : "手動のみ";
    badges.appendChild(routeBadge);

    if (model.runtime === "lm-studio") {
      const stateBadge = document.createElement("span");
      stateBadge.className = "badge " + (model.loaded ? "completed" : model.installed ? "partial" : "");
      stateBadge.textContent = model.loaded ? "読み込み中" : model.installed ? "導入済み" : model.installed === false ? "未導入" : "状態不明";
      badges.appendChild(stateBadge);
    } else {
      const external = document.createElement("span");
      external.className = "badge";
      external.textContent = "専用Runtime";
      badges.appendChild(external);
    }
    top.append(titleWrap, badges);

    const meta = document.createElement("p");
    meta.className = "model-meta";
    meta.textContent = [model.resourceNote, model.quantization, formatBytes(model.sizeBytes)].filter(Boolean).join(" · ");

    const actions = document.createElement("div");
    actions.className = "model-actions";
    const job = model.downloadJob;

    if (job?.status === "downloading") {
      const total = Number(job.total_size_bytes) || 0;
      const done = Number(job.downloaded_bytes) || 0;
      const percent = total > 0 ? Math.round((done / total) * 100) : null;
      const progress = document.createElement("span");
      progress.className = "mini-status";
      progress.textContent = percent == null ? "ダウンロード中" : "ダウンロード中 " + percent + "%";
      actions.appendChild(progress);
    } else if (model.runtime === "lm-studio") {
      if (model.loaded) {
        actions.appendChild(createModelButton("解放", "ghost", async () => {
          await modelAction(() => window.localAI.unloadModel(model.id));
        }, state.running));
      } else if (model.installed) {
        actions.appendChild(createModelButton("読み込み", "ghost", async () => {
          await modelAction(() => window.localAI.loadModel(model.id));
        }, state.running));
      } else if (model.installed === false) {
        actions.appendChild(createModelButton("ダウンロード", "primary", async () => {
          await modelAction(() => window.localAI.downloadModel(model.id));
        }, state.running || snapshot?.providerAvailable === false));
      } else {
        const unavailable = document.createElement("span");
        unavailable.className = "mini-status";
        unavailable.textContent = "LM Studio接続待ち";
        actions.appendChild(unavailable);
      }
    } else {
      const note = document.createElement("span");
      note.className = "mini-status";
      note.textContent = "Bonsaiの起動・停止から管理";
      actions.appendChild(note);
    }

    card.append(top, meta, actions);
    list.appendChild(card);
  }
}

async function modelAction(action) {
  try {
    await action();
    await refreshModels();
  } catch (error) {
    setText("#modelProviderStatus", friendlyError(error.message));
  }
}

async function refreshModels() {
  try {
    renderModelCatalog(await window.localAI.listModels());
  } catch (error) {
    setText("#modelProviderStatus", friendlyError(error.message));
  }
}

function startModelPolling() {
  if (state.modelPollTimerId) clearTimeout(state.modelPollTimerId);
  const tick = async () => {
    if ($("#settings")?.classList.contains("active")) await refreshModels();
    state.modelPollTimerId = setTimeout(() => void tick(), 5000);
  };
  state.modelPollTimerId = setTimeout(() => void tick(), 5000);
}

function isHistoryResumeCompatible(item) {
  const currentMode = state.settings?.modelRoutingMode || "auto";
  const savedMode = item.modelRoutingMode || (item.modelProfile === "auto" ? "auto" : "fixed");
  if (currentMode === "auto") return savedMode === "auto";
  return savedMode === "fixed" && Boolean(item.modelProfile) && item.modelProfile === state.settings?.modelProfile;
}

function showView(name) {
  $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === name));
  if (name === "history") loadHistory();
  if (name === "settings") void refreshModels();
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}秒`;
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  if (minutes < 60) return remainder ? `${minutes}分${remainder}秒` : `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}時間${mins}分` : `${hours}時間`;
}

function parseDurationText(value) {
  const text = String(value || "").trim();
  let seconds = 0;
  const hours = Number(text.match(/(\d+(?:\.\d+)?)h/)?.[1] || 0);
  const minutes = Number(text.match(/(\d+(?:\.\d+)?)m/)?.[1] || 0);
  const secs = Number(text.match(/(\d+(?:\.\d+)?)s/)?.[1] || 0);
  const ms = Number(text.match(/(\d+(?:\.\d+)?)ms/)?.[1] || 0);
  seconds += hours * 3600 + minutes * 60 + secs;
  if (!seconds && ms) seconds = ms / 1000;
  return seconds || null;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function estimateRemainingSeconds() {
  if (state.totalBatches > 0 && state.batchDurations.length > 0 && state.completedBatches < state.totalBatches) {
    return average(state.batchDurations) * (state.totalBatches - state.completedBatches);
  }
  return null;
}

function estimateRemainingText() {
  if (!state.running) return "—";
  const seconds = estimateRemainingSeconds();
  if (seconds != null) return "約 " + formatDuration(seconds);
  if (state.running && state.totalBatches > 0 && state.completedBatches >= state.totalBatches) {
    return "監査完了・結果統合中";
  }
  if (state.running && state.totalBatches > 0) return "最初の処理完了後に推定";
  if (state.running) return "計測中";
  return "—";
}

function formatClock(value, { seconds = false } = {}) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      ...(seconds ? { second: "2-digit" } : {})
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

function finishEstimateText() {
  if (!state.running) return "—";
  const seconds = estimateRemainingSeconds();
  return seconds == null ? "—" : `${formatClock(Date.now() + (seconds * 1000))}ごろ`;
}

function secondsSince(value) {
  if (!value) return null;
  return Math.max(0, (Date.now() - value) / 1000);
}

function lastUpdateText() {
  const age = secondsSince(state.lastOutputAt);
  if (age == null) return "—";
  return `${formatClock(state.lastOutputAt, { seconds: true })}（${formatDuration(age)}前）`;
}

function runHealth() {
  if (!state.running) return { text: "待機中", state: "idle" };
  const silence = secondsSince(state.lastOutputAt) ?? 0;
  if (state.processAlive === true && silence >= LONG_WAIT_SECONDS) {
    return { text: "プロセス動作中・長時間応答待ち", state: "warning" };
  }
  if (state.processAlive === true && silence >= RESPONSE_WAIT_SECONDS) {
    return { text: "プロセス動作中・応答待ち", state: "waiting" };
  }
  if (state.processAlive === false) {
    return { text: "開始・終了処理中", state: "waiting" };
  }
  return { text: "処理中", state: "working" };
}

function updateSpeedMetrics() {
  const batchAverage = average(state.batchDurations);
  const tokenAverage = average(state.tokenRates);
  setText("#averageBatch", batchAverage == null ? (state.running ? "計測中" : "—") : `${formatDuration(batchAverage)} / 処理`);
  setText("#lastBatch", state.lastBatchDuration == null ? "—" : formatDuration(state.lastBatchDuration));
  setText("#tokenRate", tokenAverage == null ? "—" : `約 ${tokenAverage.toFixed(1)} トークン/秒`);
  const wait = state.running && state.lastOutputAt ? secondsSince(state.lastOutputAt) : null;
  setText("#responseWait", wait == null ? "—" : formatDuration(wait));
}

function formatMemory(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  return `${(value / (1024 ** 3)).toFixed(1)} GB`;
}

function applySystemMetrics(metrics) {
  if (!metrics) return;
  state.systemMetrics = metrics;
  setText("#cpuMetric", metrics.cpuPercent == null ? "計測中" : `${metrics.cpuPercent.toFixed(1)}%`);
  setText(
    "#memoryMetric",
    metrics.memoryTotalBytes > 0
      ? `${formatMemory(metrics.memoryUsedBytes)} / ${formatMemory(metrics.memoryTotalBytes)}`
      : "取得不可"
  );
  setText("#gpuMetric", metrics.gpuPercent == null ? "取得不可" : `${metrics.gpuPercent.toFixed(1)}%`);
  setText(
    "#vramMetric",
    metrics.vramTotalBytes > 0
      ? `${formatMemory(metrics.vramUsedBytes)} / ${formatMemory(metrics.vramTotalBytes)}`
      : "取得不可"
  );
}

function updateOperationalMetrics() {
  const health = runHealth();
  setText("#finishEstimate", finishEstimateText());
  setText("#lastUpdate", lastUpdateText());
  setText("#runHealth", health.text);
  $("#runHealth")?.setAttribute("data-state", health.state);
  updateSpeedMetrics();
  updateModelRoutingMetrics();
}

async function refreshTelemetry() {
  const requests = [
    window.localAI.getCommandStatus(),
    window.localAI.getSystemMetrics()
  ];
  const [commandResult, metricsResult] = await Promise.allSettled(requests);

  if (commandResult.status === "fulfilled") {
    const status = commandResult.value || {};
    state.processAlive = Boolean(status.processAlive);
    if (status.lastOutputAt) state.lastOutputAt = Number(status.lastOutputAt);
  }
  if (metricsResult.status === "fulfilled") applySystemMetrics(metricsResult.value);
  updateOperationalMetrics();
  updateLiveResult();
}

async function telemetryTick() {
  await refreshTelemetry();
  const delay = state.running ? TELEMETRY_ACTIVE_INTERVAL_MS : TELEMETRY_IDLE_INTERVAL_MS;
  state.telemetryTimerId = setTimeout(() => void telemetryTick(), delay);
}

function startTelemetryPolling() {
  if (state.telemetryTimerId) clearTimeout(state.telemetryTimerId);
  state.telemetryTimerId = null;
  void telemetryTick();
}

function restartTelemetryPolling() {
  if (state.telemetryTimerId) clearTimeout(state.telemetryTimerId);
  state.telemetryTimerId = setTimeout(() => void telemetryTick(), 0);
}

function clearRunOverview() {
  $("#resultOverview")?.classList.add("hidden");
  $("#topFindings").textContent = "";
  $("#resultTabs")?.classList.add("hidden");
  $("#resultDetailView")?.classList.add("hidden");
  if ($("#resultDetailView")) $("#resultDetailView").textContent = "";
  state.currentRunDetails = null;
}

function severityLabel(value) {
  const labels = { critical: "重大", high: "高", medium: "中", low: "低" };
  return labels[value] || value || "不明";
}

function renderRunOverview(overview) {
  if (!overview) return;
  $("#resultOverview").classList.remove("hidden");
  setText("#resultCoverage", overview.coveragePercent == null ? "—" : `${overview.coveragePercent}%`);
  const files = overview.auditableFiles == null ? "—" : overview.auditableFiles;
  const excluded = overview.excludedFiles == null ? "—" : overview.excludedFiles;
  setText("#resultFiles", `${files}（除外 ${excluded}）`);
  setText("#resultFindings", String(overview.findingCount ?? 0));
  setText("#resultReviewer", overview.reviewerDecision ? reviewerDecisionLabel(overview.reviewerDecision) : "—");
  const modelUsage = Array.isArray(overview.modelUsage) ? overview.modelUsage : [];
  setText(
    "#resultModels",
    modelUsage.length
      ? modelUsage.map((item) => `${item.label} ${item.calls}回${item.failures ? `（失敗 ${item.failures}）` : ""}`).join(" · ")
      : "固定モデル / 記録なし"
  );
  setText("#severityCritical", String(overview.severity?.critical ?? 0));
  setText("#severityHigh", String(overview.severity?.high ?? 0));
  setText("#severityMedium", String(overview.severity?.medium ?? 0));
  setText("#severityLow", String(overview.severity?.low ?? 0));

  const list = $("#topFindings");
  list.textContent = "";
  const findings = Array.isArray(overview.topFindings) ? overview.topFindings : [];
  if (!findings.length) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.textContent = "重要な指摘はありません。";
    list.appendChild(empty);
    return;
  }

  for (const finding of findings) {
    const row = document.createElement("div");
    row.className = "finding-summary";

    const severity = document.createElement("span");
    severity.className = "finding-severity";
    severity.textContent = severityLabel(finding.severity);

    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = finding.title || "名称のない指摘";
    body.appendChild(title);

    if (finding.evidence?.file) {
      const evidence = document.createElement("small");
      const start = finding.evidence.lineStart;
      const end = finding.evidence.lineEnd;
      evidence.textContent = start
        ? `${finding.evidence.file} · ${start === end ? `L${start}` : `L${start}-L${end}`}`
        : finding.evidence.file;
      body.appendChild(evidence);
    }

    row.append(severity, body);
    list.appendChild(row);
  }
}

async function loadRunOverview(runId) {
  if (!runId || runId === "—") {
    clearRunOverview();
    return;
  }
  try {
    renderRunOverview(await window.localAI.readRunOverview(runId));
  } catch {
    clearRunOverview();
  }
}

function appendDetailMessage(container, text, className = "subtle") {
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = text;
  container.appendChild(paragraph);
}

function appendDetailKeyValue(container, label, value) {
  const row = document.createElement("div");
  row.className = "detail-kv-row";
  const key = document.createElement("span");
  key.textContent = label;
  const data = document.createElement("strong");
  data.textContent = value == null || value === "" ? "—" : String(value);
  row.append(key, data);
  container.appendChild(row);
}

function renderFindingList(container, findings) {
  if (!findings.length) {
    appendDetailMessage(container, "保存されている指摘はありません。");
    return;
  }

  for (const finding of findings) {
    const card = document.createElement("article");
    card.className = "result-detail-card";

    const head = document.createElement("div");
    head.className = "result-detail-card-head";
    const severity = document.createElement("span");
    severity.className = "finding-severity";
    severity.textContent = severityLabel(finding.severity);
    const title = document.createElement("strong");
    title.textContent = finding.title || "名称のない指摘";
    head.append(severity, title);
    card.appendChild(head);

    const confidence = document.createElement("p");
    confidence.className = "detail-meta";
    confidence.textContent = "確度: " + (finding.confidence || "不明");
    card.appendChild(confidence);

    for (const evidence of Array.isArray(finding.evidence) ? finding.evidence : []) {
      const evidenceBox = document.createElement("div");
      evidenceBox.className = "evidence-box";
      const location = document.createElement("code");
      const start = evidence.lineStart;
      const end = evidence.lineEnd;
      location.textContent = start
        ? `${evidence.file || "不明"} · ${start === end ? `L${start}` : `L${start}-L${end}`}`
        : (evidence.file || "不明");
      const claim = document.createElement("p");
      claim.textContent = evidence.claim || "根拠説明なし";
      evidenceBox.append(location, claim);
      card.appendChild(evidenceBox);
    }
    container.appendChild(card);
  }
}

function renderEvidenceList(container, findings) {
  const evidenceItems = [];
  for (const finding of findings) {
    for (const evidence of Array.isArray(finding.evidence) ? finding.evidence : []) {
      evidenceItems.push({ finding, evidence });
    }
  }
  if (!evidenceItems.length) {
    appendDetailMessage(container, "保存されている根拠はありません。");
    return;
  }

  for (const item of evidenceItems) {
    const card = document.createElement("article");
    card.className = "result-detail-card";
    const title = document.createElement("strong");
    title.textContent = item.finding.title || "名称のない指摘";
    const location = document.createElement("code");
    const start = item.evidence.lineStart;
    const end = item.evidence.lineEnd;
    location.textContent = start
      ? `${item.evidence.file || "不明"} · ${start === end ? `L${start}` : `L${start}-L${end}`}`
      : (item.evidence.file || "不明");
    const claim = document.createElement("p");
    claim.textContent = item.evidence.claim || "根拠説明なし";
    card.append(title, location, claim);
    container.appendChild(card);
  }
}

function renderAgentResult(container, value, emptyMessage) {
  if (!value || typeof value !== "object" || Object.keys(value).length === 0) {
    appendDetailMessage(container, emptyMessage);
    return;
  }

  if (value.decision) appendDetailKeyValue(container, "判定", reviewerDecisionLabel(value.decision));
  if (value.status) appendDetailKeyValue(container, "状態", value.status);
  if (value.summary) appendDetailMessage(container, value.summary, "detail-summary");

  const findings = Array.isArray(value.findings) ? value.findings : [];
  if (findings.length) {
    const heading = document.createElement("h3");
    heading.textContent = "提案・指摘";
    container.appendChild(heading);
    for (const item of findings) {
      const card = document.createElement("article");
      card.className = "result-detail-card";
      const text = document.createElement("pre");
      text.className = "structured-json";
      text.textContent = JSON.stringify(item, null, 2);
      card.appendChild(text);
      container.appendChild(card);
    }
  }

  const uncertainties = Array.isArray(value.uncertainties) ? value.uncertainties : [];
  if (uncertainties.length) {
    const heading = document.createElement("h3");
    heading.textContent = "未確定事項";
    container.appendChild(heading);
    for (const item of uncertainties) appendDetailMessage(container, item);
  }

  const actions = Array.isArray(value.recommendedNextActions) ? value.recommendedNextActions : [];
  if (actions.length) {
    const heading = document.createElement("h3");
    heading.textContent = "次の行動";
    container.appendChild(heading);
    const list = document.createElement("ul");
    for (const item of actions) {
      const li = document.createElement("li");
      li.textContent = item;
      list.appendChild(li);
    }
    container.appendChild(list);
  }
}

function renderResultTab(tabName) {
  const details = state.currentRunDetails;
  const view = $("#resultDetailView");
  if (!details || !view) return;

  state.currentResultTab = tabName;
  view.textContent = "";
  $$("#resultTabs .result-tab").forEach((button) => {
    const active = button.dataset.resultTab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  const findings = Array.isArray(details.findings) ? details.findings : [];
  if (tabName === "issues") {
    renderFindingList(view, findings);
    return;
  }
  if (tabName === "evidence") {
    renderEvidenceList(view, findings);
    return;
  }
  if (tabName === "planner") {
    renderAgentResult(view, details.planner, "保存されている改善案はありません。");
    return;
  }
  if (tabName === "reviewer") {
    renderAgentResult(view, details.reviewer, "保存されているレビュー結果はありません。");
    return;
  }
  if (tabName === "excluded") {
    const excluded = Array.isArray(details.excluded) ? details.excluded : [];
    if (!excluded.length) {
      appendDetailMessage(view, "除外されたファイルはありません。");
      return;
    }
    for (const item of excluded) {
      const card = document.createElement("article");
      card.className = "result-detail-card";
      const path = document.createElement("code");
      path.textContent = item.path || "不明";
      const reason = document.createElement("strong");
      reason.textContent = "理由: " + (item.reason || "不明");
      const detail = document.createElement("p");
      detail.textContent = item.detail || "";
      card.append(path, reason, detail);
      view.appendChild(card);
    }
    return;
  }
  if (tabName === "technical") {
    const identity = details.run?.executionIdentity || {};
    const coverage = details.coverage || {};
    const rows = document.createElement("div");
    rows.className = "detail-kv";
    appendDetailKeyValue(rows, "実行ID", details.runId);
    appendDetailKeyValue(rows, "状態", details.run?.status || "不明");
    appendDetailKeyValue(rows, "アプリ版", identity.appVersion || "旧版 / 記録なし");
    appendDetailKeyValue(rows, "モデル", identity.model || "記録なし");
    appendDetailKeyValue(rows, "モデル設定", identity.modelProfile || "記録なし");
    appendDetailKeyValue(rows, "モデル運用", identity.modelRoutingMode === "auto" ? "自動振り分け" : "1モデル固定");
    appendDetailKeyValue(rows, "モデル振り分けRule", identity.routingHash || "固定 / 記録なし");
    appendDetailKeyValue(rows, "モデルCatalog", identity.routingCatalogHash || "固定 / 記録なし");
    appendDetailKeyValue(rows, "Prompt/Schema版", identity.promptSchemaVersion || "記録なし");
    appendDetailKeyValue(rows, "設定Hash", identity.configHash || "記録なし");
    appendDetailKeyValue(rows, "監査進捗", coverage.coveragePercent == null ? "—" : coverage.coveragePercent + "%");
    appendDetailKeyValue(rows, "処理単位", `${coverage.completedBatches ?? "—"} / ${coverage.totalBatches ?? "—"}`);
    appendDetailKeyValue(rows, "対象分割", `${coverage.completedChunks ?? "—"} / ${coverage.totalChunks ?? "—"}`);
    appendDetailKeyValue(rows, "作成", formatDate(details.run?.createdAt));
    appendDetailKeyValue(rows, "完了/中断", formatDate(details.run?.completedAt || details.run?.interruptedAt));
    const savedUsage = details.modelUsage || details.run?.modelRouting || {};
    appendDetailKeyValue(rows, "用途別固定", savedUsage.pins ? JSON.stringify(savedUsage.pins) : "記録なし");
    const modelSummary = Array.isArray(savedUsage.models)
      ? savedUsage.models.map((item) => `${item.label || item.modelId}: ${item.calls || 0}回 / 失敗 ${item.failures || 0}`).join(" · ")
      : "記録なし";
    appendDetailKeyValue(rows, "モデル別実行", modelSummary);
    view.appendChild(rows);
    return;
  }
  if (tabName === "log") {
    const pre = document.createElement("pre");
    pre.className = "saved-run-log";
    pre.textContent = details.consoleLog || "このRunの保存済み生ログはありません。v0.2.10以降のDesktop実行から保存されます。";
    view.appendChild(pre);
  }
}

function renderRunDetails(details) {
  if (!details) return;
  state.currentRunDetails = details;
  $("#resultTabs")?.classList.remove("hidden");
  $("#resultDetailView")?.classList.remove("hidden");
  renderResultTab("issues");
  if (details.summary) {
    state.result = details.summary;
    setText("#result", details.summary);
  }
}

async function loadRunDetails(runId) {
  if (!runId || runId === "—") return;
  try {
    renderRunDetails(await window.localAI.readRunDetails(runId));
  } catch (error) {
    $("#resultTabs")?.classList.add("hidden");
    $("#resultDetailView")?.classList.add("hidden");
    state.currentRunDetails = null;
  }
}

function updateLiveResult() {
  if (!state.running) return;

  const elapsed = state.startedAt
    ? formatDuration((Date.now() - state.startedAt) / 1000)
    : "—";
  const estimate = estimateRemainingText();
  const health = runHealth();
  const lines = [
    "実行中",
    `処理: ${COMMAND_META[state.selectedCommand]?.label || state.selectedCommand}`,
    `モデル運用: ${isAutoRouting() ? "自動振り分け" : "1モデル固定"}`,
    `使用モデル: ${state.currentRoutedModel || (isAutoRouting() ? "選択中" : profileLabel(state.settings?.modelProfile, "fixed"))}`,
    `現在の作業: ${state.currentStage || "開始準備中"}`,
    `状態: ${health.text}`
  ];

  if (state.totalBatches > 0) {
    const percent = Math.min(100, Math.round((state.completedBatches / state.totalBatches) * 100));
    lines.push(`進捗: ${state.completedBatches} / ${state.totalBatches} 処理（${percent}%）`);
  } else {
    lines.push("進捗: 準備中");
  }

  if (state.planFiles || state.planChunks) {
    lines.push(`対象: ${state.planFiles || "—"} ファイル / ${state.planChunks || "—"} 分割`);
  }
  if (state.currentBatch) lines.push(`処理中の単位: ${state.currentBatch}`);

  lines.push(`経過時間: ${elapsed}`);
  lines.push(`推定残り: ${estimate}`);
  lines.push(`終了予想: ${finishEstimateText()}`);
  lines.push(`最終更新: ${lastUpdateText()}`);

  const batchAverage = average(state.batchDurations);
  if (batchAverage != null) lines.push(`平均処理時間: ${formatDuration(batchAverage)} / 処理`);
  if (state.lastBatchDuration != null) lines.push(`直近処理時間: ${formatDuration(state.lastBatchDuration)}`);
  const tokenAverage = average(state.tokenRates);
  if (tokenAverage != null) lines.push(`生成速度: 約 ${tokenAverage.toFixed(1)} トークン/秒`);

  if (state.promptTokens || state.completionTokens || state.reasoningTokens) {
    const tokenParts = [`入力 ${state.promptTokens}`, `出力 ${state.completionTokens}`];
    if (state.reasoningTokens > 0) tokenParts.push(`推論 ${state.reasoningTokens}`);
    lines.push("使用トークン: " + tokenParts.join(" / "));
  }

  const runId = $("#runLabel")?.textContent?.trim();
  if (runId && runId !== "—") lines.push(`実行ID: ${runId}`);

  if (state.totalBatches > 0 && state.batchDurations.length > 0) {
    lines.push("※ 推定残りと終了予想は、完了済み処理の平均時間をもとにした目安です。");
  }
  if (health.state === "warning") {
    lines.push("※ 出力が長時間ありません。プロセスは動作中ですが、モデル応答を待っています。");
  }

  setText("#resultTitle", "実行中");
  setText("#result", lines.join("\n"));
}

function updateTiming() {
  if (!state.startedAt) {
    setText("#elapsed", "—");
    setText("#estimate", "—");
    updateOperationalMetrics();
    return;
  }

  setText("#elapsed", formatDuration((Date.now() - state.startedAt) / 1000));
  setText("#estimate", estimateRemainingText());
  updateOperationalMetrics();
  updateLiveResult();
}

function startTimer() {
  stopTimer();
  state.startedAt = Date.now();
  updateTiming();
  state.timerId = setInterval(updateTiming, 1000);
}

function stopTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
}

function resetRunMetrics() {
  state.completedBatches = 0;
  state.totalBatches = 0;
  state.completedBatchIds = new Set();
  state.batchDurations = [];
  state.promptTokens = 0;
  state.completionTokens = 0;
  state.reasoningTokens = 0;
  state.currentBatch = null;
  state.currentStage = "開始準備中";
  state.planFiles = 0;
  state.planChunks = 0;
  state.lastOutputAt = Date.now();
  state.processAlive = null;
  state.lastBatchDuration = null;
  state.tokenRates = [];
  state.currentRoutedModel = "";
  state.currentModelTask = "";
  state.modelUsageCounts = {};
  state.modelFallbacks = 0;
  state.reusedBatches = 0;
  state.reuseSourceRunId = "";
  setText("#batchMetric", "処理単位 —");
  setText("#tokenMetric", "使用トークン —");
  setText("#stage", "開始準備中");
  setText("#estimate", "計測中");
  setText("#finishEstimate", "—");
  setText("#lastUpdate", "—");
  setText("#runHealth", "開始準備中");
  updateSpeedMetrics();
  updateModelRoutingMetrics();
}

function updateTokenMetric() {
  const parts = [
    `入力 ${state.promptTokens}`,
    `出力 ${state.completionTokens}`
  ];
  if (state.reasoningTokens > 0) parts.push(`推論 ${state.reasoningTokens}`);
  setText("#tokenMetric", parts.join(" · "));
}

function updateCoverageMode() {
  if (state.selectedCommand !== "coverage") return;
  if (state.resume) {
    setText("#coverageMode", `保存済みの実行 ${$("#runId").value || ""} の未完了部分から再開します。`);
    setText("#execute", "全体監査を再開");
  } else {
    const reuse = state.settings?.reuseCoverage !== false;
    setText(
      "#coverageMode",
      reuse
        ? "新しい全体監査として実行します。内容が同じ監査部分は互換性を確認して前回結果を再利用します。"
        : "新しい全体監査として実行します。前回結果は再利用せず、すべてAIへ再確認します。"
    );
    setText("#execute", COMMAND_META.coverage.execute);
  }
}

function selectCommand(command, { preserveResume = false } = {}) {
  if (!COMMAND_META[command]) return;
  state.selectedCommand = command;
  if (command !== "coverage" || !preserveResume) state.resume = false;

  $$(".commands button").forEach((button) => {
    button.classList.toggle("selected", button.dataset.command === command);
    button.setAttribute("aria-pressed", button.dataset.command === command ? "true" : "false");
  });

  $("#coverageOptions").classList.toggle("hidden", command !== "coverage");
  $("#synthOptions").classList.toggle("hidden", command !== "coverage-synthesize");
  setText("#selectedTask", COMMAND_META[command].label);
  setText("#execute", COMMAND_META[command].execute);
  updateCoverageMode();
}

function setRunning(value, title) {
  state.running = value;
  $$(".commands button").forEach((button) => { button.disabled = value; });
  $("#execute").disabled = value;
  $("#chooseRepo").disabled = value;
  $("#updateRepo").disabled = value;
  $("#refresh").disabled = value;
  $("#startBonsai").disabled = value;
  $("#stopBonsai").disabled = value;
  $("#refreshBonsai").disabled = value;
  if ($("#refreshModels")) $("#refreshModels").disabled = value;
  document.querySelectorAll("#modelCatalog button").forEach((button) => { button.disabled = value; });
  $("#modelRoutingMode").disabled = value;
  $("#autoManageModels").disabled = value;
  $("#reuseCoverage").disabled = value;
  $("#settingsProfile").disabled = value;
  $("#settingsRepoButton").disabled = value;
  $("#bonsaiFolderButton").disabled = value;
  $("#autoCheckUpdates").disabled = value;
  $("#save").disabled = value;
  $("#cancel").classList.toggle("hidden", !value);
  $("#cancel").disabled = !value;
  setText("#runProtection", value ? "スリープ防止中" : "待機中");
  if (!value) state.processAlive = false;
  if (title) setText("#runTitle", title);
  updateOperationalMetrics();
  applyUpdateState(state.updateState);
  restartTelemetryPolling();
}

function ensureRunOption(runId, label = runId) {
  if (!runId) return;
  const select = $("#runId");
  if (![...select.options].some((option) => option.value === runId)) {
    const option = document.createElement("option");
    option.value = runId;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = runId;
}

function setStage(value, { updateResult = true } = {}) {
  state.currentStage = value;
  setText("#stage", value);
  if (updateResult) updateLiveResult();
}

function appendLog(payload) {
  state.lastOutputAt = Date.now();
  state.processAlive = true;
  const line = document.createElement("div");
  if (payload.channel === "stderr") line.className = "err";
  line.textContent = payload.line;
  const log = $("#log");
  log.appendChild(line);
  while (log.childElementCount > MAX_RENDER_LOG_LINES) {
    log.firstElementChild?.remove();
  }
  log.scrollTop = log.scrollHeight;

  const progress = payload.progress;
  if (!progress) {
    updateOperationalMetrics();
    updateLiveResult();
    return;
  }

  if (progress.type === "model-prepare") {
    state.currentRoutedModel = (progress.label || progress.modelId || "不明") + " を準備中";
    state.currentModelTask = progress.taskType || "";
    updateModelRoutingMetrics();
    setStage("モデルを準備中: " + (progress.label || progress.modelId || "不明"), { updateResult: false });
    return;
  }

  if (progress.type === "model-route") {
    state.currentRoutedModel = progress.label || progress.modelId || "不明";
    state.currentModelTask = progress.taskType || "";
    const label = state.currentRoutedModel;
    state.modelUsageCounts[label] = (state.modelUsageCounts[label] || 0) + 1;
    setText("#model", label);
    const taskLabel = MODEL_TASK_LABELS[state.currentModelTask] || state.currentModelTask || "処理";
    setStage(label + " で" + taskLabel + "を処理中", { updateResult: false });
    updateModelRoutingMetrics();
    updateLiveResult();
    return;
  }

  if (progress.type === "model-pin") {
    state.currentRoutedModel = progress.label || progress.modelId || state.currentRoutedModel;
    state.currentModelTask = progress.taskType || state.currentModelTask;
    updateModelRoutingMetrics();
    return;
  }

  if (progress.type === "model-fallback") {
    state.modelFallbacks += 1;
    state.currentModelTask = progress.taskType || state.currentModelTask;
    updateModelRoutingMetrics();
    return;
  }

  if (progress.type === "model-route-plan") {
    state.currentModelTask = progress.taskType || "";
    updateModelRoutingMetrics();
    return;
  }

  if (progress.type === "run-id") {
    setText("#runLabel", progress.runId);
    ensureRunOption(progress.runId);
    updateLiveResult();
    return;
  }

  if (progress.type === "plan") {
    state.totalBatches = progress.batches;
    state.completedBatches = 0;
    state.planFiles = progress.files || 0;
    state.planChunks = progress.chunks || 0;
    setStage("監査計画を作成しました");
    setText("#progress", `0 / ${progress.batches} 処理 · ${progress.files} ファイル · ${progress.chunks} 分割`);
    updateTiming();
    return;
  }

  if (progress.type === "reuse-plan") {
    state.reuseSourceRunId = progress.sourceRunId || "";
    setStage(
      progress.reusableBatches > 0
        ? `前回の監査から ${progress.reusableBatches} 処理を再利用できます`
        : "再利用できる前回結果はありません",
      { updateResult: false }
    );
    return;
  }

  if (progress.type === "batch-reused") {
    if (!state.completedBatchIds.has(progress.batchId)) {
      state.completedBatchIds.add(progress.batchId);
      state.completedBatches += 1;
      state.reusedBatches += 1;
    }
    const percent = state.totalBatches
      ? Math.round((state.completedBatches / state.totalBatches) * 100)
      : 0;
    $("#bar").style.width = percent + "%";
    setText(
      "#progress",
      state.totalBatches
        ? `${state.completedBatches} / ${state.totalBatches} 処理 · 再利用 ${state.reusedBatches}`
        : "前回の監査結果を再利用中"
    );
    setText(
      "#batchMetric",
      `${progress.batchId} 再利用 · 指摘 ${progress.findings ?? 0} · 元 ${progress.sourceRunId || "前回Run"}`
    );
    setStage(`${progress.batchId} は変更なし · 前回結果を再利用`, { updateResult: false });
    updateTiming();
    return;
  }

  if (progress.type === "batch-start") {
    state.currentBatch = progress.batchId;
    setStage(`${progress.batchId} を監査中`);
    setText("#batchMetric", `${progress.batchId} · ${progress.chunks} 分割 · ${progress.chars} 文字`);
    return;
  }

  if (progress.type === "batch-done") {
    if (!state.completedBatchIds.has(progress.batchId)) {
      state.completedBatchIds.add(progress.batchId);
      state.completedBatches += 1;
      const seconds = parseDurationText(progress.durationText);
      if (seconds) {
        state.batchDurations.push(seconds);
        state.lastBatchDuration = seconds;
        if ((progress.completionTokens || 0) > 0) {
          state.tokenRates.push(progress.completionTokens / seconds);
          state.tokenRates = state.tokenRates.slice(-10);
        }
      }
      state.promptTokens += progress.promptTokens || 0;
      state.completionTokens += progress.completionTokens || 0;
      state.reasoningTokens += progress.reasoningTokens || 0;
    }

    const percent = state.totalBatches
      ? Math.round((state.completedBatches / state.totalBatches) * 100)
      : 0;
    $("#bar").style.width = percent + "%";
    setText(
      "#progress",
      state.totalBatches
        ? `${state.completedBatches} / ${state.totalBatches} 処理`
        : "全体監査を処理中"
    );
    setText(
      "#batchMetric",
      `${progress.batchId} 完了 · ${progress.durationText}${progress.findings == null ? "" : ` · 指摘 ${progress.findings}`}`
    );
    updateTokenMetric();
    updateTiming();
    return;
  }

  if (progress.type === "coverage") {
    $("#bar").style.width = Math.max(0, Math.min(100, progress.percent)) + "%";
    setText("#progress", `監査進捗 ${progress.percent}%`);
    updateLiveResult();
    return;
  }

  if (progress.type === "stage") {
    setStage(progress.stage);
    if (progress.stage.includes("統合") || progress.stage.includes("改善案") || progress.stage.includes("レビュー")) {
      $("#bar").style.width = "100%";
    }
  }
}

function applyDoctor(text) {
  const provider = text.match(/^(.+?) API: OK/m)?.[1] || "接続済み";
  const model = text.match(/^Configured model:\s*(.+)$/m)?.[1] || "不明";
  const loaded = text.match(/^Configured model loaded:\s*(.+)$/m)?.[1] || "不明";
  setText("#runtime", provider);
  setText("#model", model);
  setText("#connection", loaded === "yes" ? "接続中" : "モデル未読み込み");
  $("#dot").classList.toggle("online", loaded === "yes");
  $("#dot").classList.toggle("offline", loaded !== "yes");
  setText("#runtimeMini", loaded === "yes" ? "AI接続中" : "接続要確認");
}

function friendlyError(message) {
  const text = String(message || "不明なエラー");
  if (text.includes("ECONNREFUSED 127.0.0.1:8080") || (text.includes("fetch failed") && isBonsaiProfile())) {
    return "Bonsaiが停止しているか、まだ起動が完了していません。「Bonsaiを起動」を押してから再実行してください。";
  }
  if (text.includes("ECONNREFUSED 127.0.0.1:1234")) {
    return "LM Studioのローカルサーバーへ接続できません。LM Studio側でサーバーとモデルを起動してください。";
  }
  if (text.includes("Another command is already running")) {
    return "別の処理が実行中です。完了または停止してから実行してください。";
  }
  if (text.includes("未コミットの変更")) {
    return text;
  }
  if (text.includes("spawn git ENOENT")) {
    return "Gitが見つかりません。Git for Windowsをインストールしてから再実行してください。";
  }
  return text;
}

function validateBeforeRun(command) {
  if ((command === "inspect" || command === "coverage") && !state.repository) {
    throw new Error("対象フォルダを選択してください。");
  }
  if (command === "coverage" && !$("#goal").value.trim()) {
    throw new Error("監査目的を入力してください。");
  }
  if (command === "coverage-synthesize" && !$("#runId").value.trim()) {
    throw new Error("統合する実行履歴を選択してください。");
  }
}

async function run(command = state.selectedCommand, stateOverride = {}) {
  if (state.running) return;

  try {
    validateBeforeRun(command);
  } catch (error) {
    state.result = error.message;
    setText("#result", error.message);
    return;
  }

  if (!isAutoRouting() && isBonsaiProfile() && ["doctor", "coverage", "coverage-synthesize"].includes(command)) {
    const runtime = await window.localAI.getBonsaiStatus();
    applyBonsaiStatus(runtime);
    if (!["running", "external-running"].includes(runtime.status)) {
      state.result = "Bonsaiが停止中です。先に「Bonsaiを起動」を押してください。";
      setText("#result", state.result);
      return;
    }
  }

  $("#log").textContent = "";
  clearRunOverview();
  setText("#resultTitle", "実行中");
  setText("#result", "開始準備中...");
  $("#copy").disabled = true;
  $("#bar").style.width = "0%";
  setText("#progress", "開始しています...");
  const selectedRunId = $("#runId").value.trim();
  const runIdForCommand = command === "coverage-synthesize" || (command === "coverage" && state.resume)
    ? selectedRunId
    : "";
  setText("#runLabel", runIdForCommand || "—");
  resetRunMetrics();
  startTimer();

  const payload = {
    command,
    repoPath: state.repository,
    goal: $("#goal").value,
    runId: runIdForCommand,
    modelProfile: state.settings.modelProfile,
    modelRoutingMode: state.settings.modelRoutingMode || "auto",
    autoManageModels: state.settings.autoManageModels !== false,
    reuseCoverage: state.settings.reuseCoverage !== false,
    resume: command === "coverage" ? state.resume : false,
    ...stateOverride
  };

  setRunning(true, COMMAND_META[command]?.label || command);
  updateLiveResult();
  let succeeded = false;

  try {
    const result = await window.localAI.runCommand(payload);

    if (result?.cancelled) {
      state.result = command === "coverage"
        ? "処理を停止しました。保存済みのCheckpointがある場合は、履歴から続きへ戻れます。"
        : "処理を停止しました。";
      setText("#resultTitle", "結果");
      setText("#result", state.result);
      $("#copy").disabled = false;
      setText("#progress", "停止");
      setStage("手動停止", { updateResult: false });
      const stoppedRunId = $("#runLabel").textContent?.trim();
      if (["coverage", "coverage-synthesize"].includes(command) && stoppedRunId && stoppedRunId !== "—") {
        void Promise.all([loadRunOverview(stoppedRunId), loadRunDetails(stoppedRunId)]);
      }
    } else {
      succeeded = true;
      state.result = result.output || "完了しました。";
      setText("#resultTitle", "結果");
      setText("#result", state.result);
      $("#copy").disabled = false;
      $("#bar").style.width = "100%";
      setText("#progress", "完了");
      setStage(command === "doctor" ? "接続確認完了" : "処理完了", { updateResult: false });
      if (command === "doctor") applyDoctor(state.result);
      const completedRunId = $("#runLabel").textContent?.trim() || payload.runId;
      if (["coverage", "coverage-synthesize"].includes(command) && completedRunId && completedRunId !== "—") {
        void Promise.all([loadRunOverview(completedRunId), loadRunDetails(completedRunId)]);
      }
    }
  } catch (error) {
    state.result = friendlyError(error.message);
    setText("#resultTitle", "結果");
    setText("#result", state.result);
    $("#copy").disabled = false;
    setText("#progress", "失敗");
    setStage("エラー", { updateResult: false });
  } finally {
    stopTimer();
    setRunning(false);
    updateTiming();
    if (succeeded && command === "coverage") {
      state.resume = false;
      updateCoverageMode();
    }
    await loadHistory();
  }
}

async function updateRepositoryFromGitHub() {
  if (state.running) return;
  if (!state.repository) {
    setText("#repoUpdateStatus", "先に対象フォルダを選択してください。");
    return;
  }

  $("#updateRepo").disabled = true;
  setText("#repoUpdateStatus", "リモートの最新版を確認しています...");
  try {
    const result = await window.localAI.updateRepository(state.repository);
    setText("#repoUpdateStatus", result.message);
  } catch (error) {
    setText("#repoUpdateStatus", friendlyError(error.message));
  } finally {
    $("#updateRepo").disabled = state.running;
  }
}

function applyUpdateState(next) {
  if (!next) return;
  state.updateState = { ...(state.updateState || {}), ...next };
  const currentVersion = state.updateState.currentVersion || "不明";
  setText("#appVersion", `現在 v${currentVersion}`);
  setText("#updateStatusText", state.updateState.message || "更新状態を確認できます。");
  const progress = Math.max(0, Math.min(100, Number(state.updateState.progress) || 0));
  $("#updateBar").style.width = progress + "%";

  const updateActionStates = ["available", "downloading", "downloaded", "installing"];
  const showUpdateAction = updateActionStates.includes(state.updateState.state);
  $("#installUpdate").classList.toggle("hidden", !showUpdateAction);

  const actionLabels = {
    available: "ダウンロード",
    downloading: `ダウンロード中 ${progress.toFixed(0)}%`,
    downloaded: "再起動して更新",
    installing: "再起動中..."
  };
  if (actionLabels[state.updateState.state]) {
    setText("#installUpdate", actionLabels[state.updateState.state]);
  }

  $("#installUpdate").disabled =
    state.running ||
    state.updateState.state === "downloading" ||
    state.updateState.state === "installing";
  $("#checkUpdate").disabled =
    state.running ||
    state.updateState.state === "checking" ||
    state.updateState.state === "downloading" ||
    state.updateState.state === "installing";
}

async function checkForAppUpdate() {
  $("#checkUpdate").disabled = true;
  try {
    const result = await window.localAI.checkForUpdate();
    applyUpdateState(result);
  } catch (error) {
    setText("#updateStatusText", friendlyError(error.message));
  } finally {
    if (state.updateState?.state !== "downloading") $("#checkUpdate").disabled = false;
  }
}

async function installAppUpdate() {
  $("#installUpdate").disabled = true;
  try {
    const result = await window.localAI.installUpdate();
    if (result?.message) setText("#updateStatusText", result.message);
  } catch (error) {
    setText("#updateStatusText", friendlyError(error.message));
  } finally {
    if (state.updateState?.state !== "installing") $("#installUpdate").disabled = false;
  }
}

async function chooseRepository(settingsMode) {
  const path = await window.localAI.selectRepository();
  if (!path) return;

  if (settingsMode) {
    $("#settingsRepo").value = path;
    return;
  }

  state.repository = path;
  setText("#repoPath", path);
  setText("#repoUpdateStatus", "未コミット変更がある場合は更新しません。");
  state.settings.defaultRepository = path;
  state.settings = await window.localAI.saveSettings(state.settings);
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  } catch {
    return value || "不明";
  }
}

function reviewerDecisionLabel(value) {
  const labels = {
    APPROVE: "承認",
    REJECT: "差し戻し",
    NEED_MORE_EVIDENCE: "追加の根拠が必要"
  };
  return labels[value] ?? value;
}

function createStatusBadge(item) {
  const badge = document.createElement("span");
  badge.className = "badge " + String(item.status || "UNKNOWN").toLowerCase();
  if (item.status === "PARTIAL" && item.coverageComplete) {
    badge.textContent = "統合待ち";
  } else if (item.status === "PARTIAL") {
    badge.textContent = "途中";
  } else if (item.status === "INTERRUPTED") {
    badge.textContent = "中断";
  } else if (item.status === "COMPLETED") {
    badge.textContent = "完了";
  } else {
    badge.textContent = item.status || "不明";
  }
  return badge;
}

function createPanelMessage(text) {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.textContent = text;
  return panel;
}

function prepareSynthesis(item) {
  showView("home");
  void loadRunOverview(item.runId);
  selectCommand("coverage-synthesize");
  ensureRunOption(item.runId, `${item.runId} · 監査 ${item.coveragePercent ?? "—"}%`);
  state.result = `${item.runId} の保存済み監査結果から統合を再開する準備ができました。`;
  setText("#result", state.result);
  setText("#runLabel", item.runId);
}

function prepareCoverageResume(item) {
  if (!item.repoPath || !item.goal) {
    state.result = "この実行履歴には再開に必要な対象フォルダまたは監査目的の情報がありません。";
    setText("#result", state.result);
    showView("home");
    return;
  }

  showView("home");
  void loadRunOverview(item.runId);
  selectCommand("coverage");
  state.resume = true;
  state.repository = item.repoPath;
  setText("#repoPath", item.repoPath);
  $("#goal").value = item.goal;
  ensureRunOption(item.runId, `${item.runId} · 監査 ${item.coveragePercent ?? "—"}%`);
  setText("#runLabel", item.runId);
  updateCoverageMode();
  state.result = `${item.runId} の未完了の全体監査から再開する準備ができました。`;
  setText("#result", state.result);
}

function updateResumeCard() {
  const item = state.latestRecoverable;
  const card = $("#resumeCard");
  if (!item) {
    card.classList.add("hidden");
    return;
  }

  card.classList.remove("hidden");
  if (item.coverageComplete) {
    setText("#resumeTitle", "監査完了 · 結果の統合を再開できます");
    setText(
      "#resumeDescription",
      `${item.runId} · 指摘 ${item.findingCount}${item.synthesisError ? " · 前回は統合処理で停止" : ""}`
    );
    setText("#resumeAction", "統合の再開準備");
  } else {
    setText("#resumeTitle", "途中の全体監査があります");
    setText(
      "#resumeDescription",
      `${item.runId} · 監査 ${item.coveragePercent ?? "—"}% · ${item.completedChunks ?? "—"}/${item.totalChunks ?? "—"} 分割`
    );
    setText("#resumeAction", "監査の再開準備");
  }
}

function populateRunSelect(items) {
  const select = $("#runId");
  const selected = select.value;
  select.textContent = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "履歴から実行を選択してください";
  select.appendChild(placeholder);

  for (const item of items.filter((entry) => entry.coverageComplete)) {
    const option = document.createElement("option");
    option.value = item.runId;
    const stateLabel = item.status === "COMPLETED" ? "完了" : "統合待ち";
    option.textContent = `${item.runId} · ${stateLabel} · 指摘 ${item.findingCount}`;
    select.appendChild(option);
  }

  if (selected && [...select.options].some((option) => option.value === selected)) {
    select.value = selected;
  }
}

function applyHistoryFilter() {
  const query = String($("#historyFilter")?.value || "").trim().toLowerCase();
  const rows = [...document.querySelectorAll("#historyList .history-item")];
  let visible = 0;

  for (const row of rows) {
    const match = !query || String(row.dataset.searchText || "").includes(query);
    row.classList.toggle("hidden", !match);
    if (match) visible += 1;
  }

  $("#historyNoMatches")?.remove();
  setText("#historyCount", query ? `${visible} / ${state.history.length}件` : `${state.history.length}件`);

  if (query && state.history.length > 0 && visible === 0) {
    const empty = createPanelMessage("検索条件に一致する履歴はありません。");
    empty.id = "historyNoMatches";
    $("#historyList").appendChild(empty);
  }
}

async function cancelCurrentRun() {
  if (!state.running) return;
  $("#cancel").disabled = true;
  setStage("停止処理中");
  setText("#progress", "停止しています...");
  try {
    const result = await window.localAI.cancelCommand();
    if (!result?.cancelled) {
      setText("#progress", "すでに終了しています");
    }
  } catch (error) {
    state.result = friendlyError(error.message);
    setText("#result", state.result);
    $("#cancel").disabled = false;
  }
}

function comparisonRepoKey(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function comparisonGoalKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function signedNumber(value, suffix = "") {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${number > 0 ? "+" : ""}${number}${suffix}`;
}

function comparisonFindingText(item) {
  const evidence = item?.evidence;
  const location = evidence?.file
    ? ` · ${evidence.file}${evidence.lineStart ? `:${evidence.lineStart}` : ""}`
    : "";
  return `[${severityLabel(item?.severity)}] ${item?.title || "名称のない指摘"}${location}`;
}

function renderRunComparison(comparison) {
  const panel = $("#historyComparePanel");
  const output = $("#historyCompareOutput");
  if (!panel || !output || !comparison) return;
  panel.classList.remove("hidden");
  setText("#historyCompareTitle", `${comparison.baseline.runId} → ${comparison.current.runId}`);

  const severity = comparison.delta?.severity || {};
  const lines = [
    `指摘数: ${comparison.baseline.findingCount} → ${comparison.current.findingCount}（${signedNumber(comparison.delta?.findingCount)}）`,
    `監査進捗: ${comparison.baseline.coveragePercent ?? "—"}% → ${comparison.current.coveragePercent ?? "—"}%（${signedNumber(comparison.delta?.coveragePercent, "%")}）`,
    `Model呼出し: ${comparison.baseline.modelCalls ?? "—"} → ${comparison.current.modelCalls ?? "—"}（${signedNumber(comparison.delta?.modelCalls)}）`,
    "",
    `重要度の増減: 重大 ${signedNumber(severity.critical)} / 高 ${signedNumber(severity.high)} / 中 ${signedNumber(severity.medium)} / 低 ${signedNumber(severity.low)}`,
    `新しく見つかった指摘: ${comparison.added?.length ?? 0}`,
    `解消または消えた指摘: ${comparison.resolved?.length ?? 0}`,
    `継続している指摘: ${comparison.persisting?.length ?? 0}`
  ];

  if (comparison.added?.length) {
    lines.push("", "新しく見つかった指摘");
    for (const item of comparison.added.slice(0, 12)) lines.push("＋ " + comparisonFindingText(item));
    if (comparison.added.length > 12) lines.push(`…ほか ${comparison.added.length - 12}件`);
  }
  if (comparison.resolved?.length) {
    lines.push("", "解消または消えた指摘");
    for (const item of comparison.resolved.slice(0, 12)) lines.push("－ " + comparisonFindingText(item));
    if (comparison.resolved.length > 12) lines.push(`…ほか ${comparison.resolved.length - 12}件`);
  }

  output.textContent = lines.join("\n");
}

function clearRunComparison() {
  state.compareBaselineRunId = null;
  setText("#compareBaselineStatus", "比較元: 未選択");
  $("#historyComparePanel")?.classList.add("hidden");
  if ($("#historyCompareOutput")) $("#historyCompareOutput").textContent = "";
  void loadHistory();
}

function setComparisonBaseline(item) {
  state.compareBaselineRunId = item.runId;
  setText("#compareBaselineStatus", `比較元: ${item.runId}`);
  $("#historyComparePanel")?.classList.add("hidden");
  if ($("#historyCompareOutput")) $("#historyCompareOutput").textContent = "";
  void loadHistory();
}

async function compareWithBaseline(item) {
  const baselineId = state.compareBaselineRunId;
  if (!baselineId || baselineId === item.runId) return;
  try {
    const comparison = await window.localAI.compareRuns(baselineId, item.runId);
    renderRunComparison(comparison);
  } catch (error) {
    const panel = $("#historyComparePanel");
    panel?.classList.remove("hidden");
    setText("#historyCompareTitle", "比較できませんでした");
    setText("#historyCompareOutput", friendlyError(error.message));
  }
}

async function exportHistoryRun(item, button) {
  const original = button.textContent;
  button.disabled = true;
  try {
    const result = await window.localAI.exportRun(item.runId);
    button.textContent = result?.canceled ? original : "書き出しました";
  } catch (error) {
    button.textContent = "失敗";
    button.title = friendlyError(error.message);
  } finally {
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1400);
  }
}

async function loadHistory() {
  const list = $("#historyList");
  list.textContent = "";
  list.appendChild(createPanelMessage("読み込み中..."));

  try {
    const items = await window.localAI.listHistory();
    state.history = items;
    if (state.compareBaselineRunId && !items.some((item) => item.runId === state.compareBaselineRunId)) {
      state.compareBaselineRunId = null;
    }
    const baselineItem = items.find((item) => item.runId === state.compareBaselineRunId);
    setText("#compareBaselineStatus", baselineItem ? `比較元: ${baselineItem.runId}` : "比較元: 未選択");
    populateRunSelect(items);

    state.latestRecoverable = items.find((item) => (
      ["PARTIAL", "INTERRUPTED"].includes(item.status) &&
      (item.coverageComplete || (
        item.coveragePercent != null &&
        item.coveragePercent < 100 &&
        isHistoryResumeCompatible(item)
      ))
    )) || null;
    updateResumeCard();

    list.textContent = "";
    if (!items.length) {
      setText("#historyCount", "0件");
      list.appendChild(createPanelMessage("まだ保存済みの実行履歴はありません。"));
      return;
    }

    for (const item of items) {
      const row = document.createElement("article");
      row.className = "history-item";
      row.dataset.searchText = [
        item.runId,
        item.repoName,
        item.repoPath,
        item.goal,
        item.status,
        item.reviewerDecision,
        item.model,
        item.modelProfile,
        item.modelRoutingMode,
        item.appVersion
      ].filter(Boolean).join(" ").toLowerCase();

      const left = document.createElement("div");
      const heading = document.createElement("div");
      heading.className = "history-heading";

      const title = document.createElement("h3");
      title.textContent = item.runId;
      heading.append(title, createStatusBadge(item));

      const meta = document.createElement("div");
      meta.className = "history-meta";
      const metaValues = [
        formatDate(item.updatedAt || item.createdAt),
        item.repoName || "対象フォルダ不明",
        `監査 ${item.coveragePercent ?? "—"}%`,
        `指摘 ${item.findingCount}`,
        item.modelRoutingMode === "auto" ? "モデル 自動振り分け" : item.model ? `モデル ${item.model}` : null,
        item.appVersion ? `v${item.appVersion}` : null,
        item.reviewerDecision ? `レビュー ${reviewerDecisionLabel(item.reviewerDecision)}` : null
      ].filter(Boolean);

      for (const value of metaValues) {
        const span = document.createElement("span");
        span.textContent = value;
        meta.appendChild(span);
      }

      if (item.status === "INTERRUPTED") {
        const note = document.createElement("p");
        note.className = "history-context warning";
        note.textContent = item.coverageComplete
          ? "前回の実行は中断されました。保存済み監査結果から統合を再開できます。"
          : isHistoryResumeCompatible(item)
            ? "前回の実行は中断されました。記録済みのモデル振り分けを維持して再開できます。"
            : "現在のモデル運用と整合しないため通常再開はできません。結果は閲覧できます。";
        left.append(heading, meta, note);
      } else if (item.synthesisError) {
        const note = document.createElement("p");
        note.className = "history-context warning";
        note.textContent = "結果の統合が未完了: " + item.synthesisError;
        left.append(heading, meta, note);
      } else {
        left.append(heading, meta);
      }

      const actions = document.createElement("div");
      actions.className = "actions";

      const open = document.createElement("button");
      open.className = "ghost";
      open.textContent = "結果を見る";
      open.addEventListener("click", async () => {
        const [result, details] = await Promise.all([
          window.localAI.readRunResult(item.runId),
          window.localAI.readRunDetails(item.runId),
          loadRunOverview(item.runId)
        ]);
        state.result = result.content;
        setText("#resultTitle", "監査結果");
        setText("#result", result.content);
        renderRunDetails(details);
        $("#copy").disabled = false;
        ensureRunOption(item.runId);
        setText("#runLabel", item.runId);
        showView("home");
      });
      actions.appendChild(open);

      const baseline = document.createElement("button");
      baseline.className = state.compareBaselineRunId === item.runId ? "primary" : "ghost";
      baseline.textContent = state.compareBaselineRunId === item.runId ? "比較元" : "比較元にする";
      baseline.disabled = state.compareBaselineRunId === item.runId || !item.coverageComplete || !item.goal;
      baseline.title = !item.coverageComplete
        ? "監査が100%完了した履歴だけ比較できます"
        : !item.goal
          ? "監査目的を確認できない履歴は比較できません"
          : "";
      baseline.addEventListener("click", () => setComparisonBaseline(item));
      actions.appendChild(baseline);

      if (state.compareBaselineRunId && state.compareBaselineRunId !== item.runId) {
        const compare = document.createElement("button");
        compare.className = "ghost";
        compare.textContent = "比較";
        const baselineItem = state.history.find((entry) => entry.runId === state.compareBaselineRunId);
        const differentRepository = Boolean(
          baselineItem?.repoPath &&
          item.repoPath &&
          comparisonRepoKey(baselineItem.repoPath) !== comparisonRepoKey(item.repoPath)
        );
        const incomplete = !baselineItem?.coverageComplete || !item.coverageComplete;
        const missingGoal = !baselineItem?.goal || !item.goal;
        const differentGoal = !missingGoal && comparisonGoalKey(baselineItem.goal) !== comparisonGoalKey(item.goal);
        compare.disabled = differentRepository || incomplete || missingGoal || differentGoal;
        compare.title = differentRepository
          ? "別の対象フォルダの実行履歴とは比較できません"
          : incomplete
            ? "監査が100%完了した履歴だけ比較できます"
            : missingGoal
              ? "監査目的を確認できない履歴は比較できません"
              : differentGoal
                ? "監査目的が異なる履歴は比較できません"
                : "";
        compare.addEventListener("click", () => compareWithBaseline(item));
        actions.appendChild(compare);
      }

      const exportButton = document.createElement("button");
      exportButton.className = "ghost";
      exportButton.textContent = "書き出す";
      exportButton.addEventListener("click", () => exportHistoryRun(item, exportButton));
      actions.appendChild(exportButton);

      if (["PARTIAL", "INTERRUPTED"].includes(item.status) && item.coverageComplete) {
        const resume = document.createElement("button");
        resume.className = "primary";
        resume.textContent = "統合を再開";
        resume.addEventListener("click", () => prepareSynthesis(item));
        actions.appendChild(resume);
      } else if (["PARTIAL", "INTERRUPTED"].includes(item.status) && !item.coverageComplete) {
        const resume = document.createElement("button");
        resume.className = "primary";
        resume.textContent = "監査を再開";
        const incompatibleProfile = !isHistoryResumeCompatible(item);
        resume.disabled = !item.repoPath || !item.goal || incompatibleProfile;
        resume.title = incompatibleProfile
          ? "前回と同じモデル運用を確認できないため再開できません"
          : resume.disabled
            ? "この実行履歴には再開情報が不足しています"
            : "";
        resume.addEventListener("click", () => prepareCoverageResume(item));
        actions.appendChild(resume);
      } else if (item.status === "COMPLETED" && item.coverageComplete) {
        const synth = document.createElement("button");
        synth.className = "ghost";
        synth.textContent = "再統合";
        synth.addEventListener("click", () => prepareSynthesis(item));
        actions.appendChild(synth);
      }

      const folder = document.createElement("button");
      folder.className = "ghost";
      folder.textContent = "保存先";
      folder.addEventListener("click", async () => {
        const original = folder.textContent;
        folder.disabled = true;
        try {
          await window.localAI.openRunFolder(item.runId);
          folder.textContent = "開きました";
        } catch (error) {
          folder.textContent = "開けません";
          folder.title = friendlyError(error.message);
        } finally {
          setTimeout(() => {
            folder.textContent = original;
            folder.disabled = false;
          }, 1200);
        }
      });
      actions.appendChild(folder);

      const copy = document.createElement("button");
      copy.className = "ghost";
      copy.textContent = "コピー";
      copy.addEventListener("click", async () => {
        const result = await window.localAI.readRunResult(item.runId);
        await window.localAI.copyText(result.content);
        copy.textContent = "コピー済み";
        setTimeout(() => { copy.textContent = "コピー"; }, 1200);
      });
      actions.appendChild(copy);

      row.append(left, actions);
      list.appendChild(row);
    }

    applyHistoryFilter();
  } catch (error) {
    list.textContent = "";
    list.appendChild(createPanelMessage("履歴を読み込めませんでした: " + friendlyError(error.message)));
  }
}

async function copyDiagnostics() {
  try {
    const diagnostics = await window.localAI.listDiagnostics();
    await window.localAI.copyText(JSON.stringify(diagnostics, null, 2));
    setText("#saveMessage", "診断ログをコピーしました");
  } catch (error) {
    setText("#saveMessage", friendlyError(error.message));
  }
}

async function clearDiagnostics() {
  try {
    await window.localAI.clearDiagnostics();
    setText("#saveMessage", "診断ログを消去しました");
  } catch (error) {
    setText("#saveMessage", friendlyError(error.message));
  }
}

async function init() {
  state.settings = await window.localAI.getSettings();
  state.repository = state.settings.defaultRepository;
  setText("#repoPath", state.repository || "未選択");
  $("#settingsRepo").value = state.repository;
  $("#settingsProfile").value = state.settings.modelProfile;
  $("#modelRoutingMode").value = state.settings.modelRoutingMode || "auto";
  $("#autoManageModels").checked = state.settings.autoManageModels !== false;
  $("#reuseCoverage").checked = state.settings.reuseCoverage !== false;
  setText("#profile", profileLabel(state.settings.modelProfile, state.settings.modelRoutingMode));
  $("#autoCheckUpdates").checked = state.settings.autoCheckUpdates !== false;
  $("#bonsaiDemoPath").value = state.settings.bonsaiDemoPath || "";
  updateRoutingSettingsUi();
  window.localAI.onLog(appendLog);
  window.localAI.onUpdateStatus(applyUpdateState);
  window.localAI.onBonsaiStatus(applyBonsaiStatus);
  applyUpdateState(await window.localAI.getUpdateState());
  if (isAutoRouting() || isBonsaiProfile()) await refreshBonsaiStatus();
  await refreshModels();
  startModelPolling();
  startTelemetryPolling();
  selectCommand("coverage");
  await loadHistory();
}

$$(".nav").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$$(".commands button").forEach((button) => button.addEventListener("click", () => selectCommand(button.dataset.command)));
$("#execute").addEventListener("click", () => run(state.selectedCommand));
$("#chooseRepo").addEventListener("click", () => chooseRepository(false));
$("#updateRepo").addEventListener("click", updateRepositoryFromGitHub);
$("#settingsRepoButton").addEventListener("click", () => chooseRepository(true));
$("#bonsaiFolderButton").addEventListener("click", chooseBonsaiFolder);
$("#startBonsai").addEventListener("click", startBonsaiRuntime);
$("#stopBonsai").addEventListener("click", stopBonsaiRuntime);
$("#refreshBonsai").addEventListener("click", refreshBonsaiStatus);
$("#settingsProfile").addEventListener("change", updateRoutingSettingsUi);
$("#modelRoutingMode").addEventListener("change", updateRoutingSettingsUi);
$("#reuseCoverage").addEventListener("change", () => {
  if (state.settings) state.settings.reuseCoverage = $("#reuseCoverage").checked;
  updateCoverageMode();
});
$("#refreshModels").addEventListener("click", refreshModels);
$("#refresh").addEventListener("click", () => run("doctor"));
$("#reloadHistory").addEventListener("click", loadHistory);
$("#historyFilter").addEventListener("input", applyHistoryFilter);
$("#clearComparison").addEventListener("click", clearRunComparison);
$$("#resultTabs .result-tab").forEach((button) => {
  button.addEventListener("click", () => renderResultTab(button.dataset.resultTab));
});
$("#cancel").addEventListener("click", cancelCurrentRun);
$("#resumeAction").addEventListener("click", () => {
  const item = state.latestRecoverable;
  if (!item) return;
  if (item.coverageComplete) prepareSynthesis(item);
  else prepareCoverageResume(item);
});
$("#copy").addEventListener("click", async () => {
  await window.localAI.copyText(state.result);
  setText("#copy", "コピー済み");
  setTimeout(() => setText("#copy", "結果をコピー"), 1200);
});
$("#copyDiagnostics").addEventListener("click", copyDiagnostics);
$("#clearDiagnostics").addEventListener("click", clearDiagnostics);
$("#checkUpdate").addEventListener("click", checkForAppUpdate);
$("#installUpdate").addEventListener("click", installAppUpdate);
$("#openRelease").addEventListener("click", () => window.localAI.openReleasePage());
$("#save").addEventListener("click", async () => {
  try {
    const selectedRepository = $("#settingsRepo").value;
    const next = await window.localAI.saveSettings({
      defaultRepository: selectedRepository,
      modelProfile: $("#settingsProfile").value,
      modelRoutingMode: $("#modelRoutingMode").value,
      autoManageModels: $("#autoManageModels").checked,
      reuseCoverage: $("#reuseCoverage").checked,
      autoCheckUpdates: $("#autoCheckUpdates").checked,
      bonsaiDemoPath: $("#bonsaiDemoPath").value
    });
    state.settings = next;
    state.repository = selectedRepository || state.repository;
    setText("#repoPath", state.repository || "未選択");
    setText("#profile", profileLabel(next.modelProfile, next.modelRoutingMode));
    updateRoutingSettingsUi();
    if (next.modelRoutingMode === "auto" || isBonsaiProfile(next.modelProfile)) await refreshBonsaiStatus();
    await refreshModels();
    setText("#saveMessage", "保存しました");
    setTimeout(() => setText("#saveMessage", ""), 1500);
  } catch (error) {
    setText("#saveMessage", friendlyError(error.message));
  }
});

init().catch((error) => {
  setText("#result", "初期化に失敗しました: " + friendlyError(error.message));
});
