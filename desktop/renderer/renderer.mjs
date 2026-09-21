const MAX_RENDER_LOG_LINES = 800;
const TELEMETRY_INTERVAL_MS = 5000;
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
  bonsaiStatus: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function profileLabel(value) {
  if (value === "default") return "標準";
  if (value === "bonsai-2-27b") return "Bonsai 2 27B";
  return value || "不明";
}

function isBonsaiProfile(value = state.settings?.modelProfile) {
  return value === "bonsai-2-27b";
}

function updateBonsaiVisibility(profile = state.settings?.modelProfile) {
  const visible = isBonsaiProfile(profile);
  $("#bonsaiRuntimeCard").classList.toggle("hidden", !visible);
  $("#bonsaiSettings").classList.toggle("hidden", $("#settingsProfile").value !== "bonsai-2-27b");
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

  if (isBonsaiProfile()) {
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

function showView(name) {
  $$(".nav").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === name));
  if (name === "history") loadHistory();
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

function startTelemetryPolling() {
  if (state.telemetryTimerId) clearInterval(state.telemetryTimerId);
  void refreshTelemetry();
  state.telemetryTimerId = setInterval(() => void refreshTelemetry(), TELEMETRY_INTERVAL_MS);
}

function clearRunOverview() {
  $("#resultOverview")?.classList.add("hidden");
  $("#topFindings").textContent = "";
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
  setText("#batchMetric", "処理単位 —");
  setText("#tokenMetric", "使用トークン —");
  setText("#stage", "開始準備中");
  setText("#estimate", "計測中");
  setText("#finishEstimate", "—");
  setText("#lastUpdate", "—");
  setText("#runHealth", "開始準備中");
  updateSpeedMetrics();
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
    setText("#coverageMode", "新しい全体監査として実行します。");
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
  $(".commands button").forEach((button) => { button.disabled = value; });
  $("#execute").disabled = value;
  $("#chooseRepo").disabled = value;
  $("#updateRepo").disabled = value;
  $("#refresh").disabled = value;
  $("#startBonsai").disabled = value;
  $("#stopBonsai").disabled = value;
  $("#refreshBonsai").disabled = value;
  $("#cancel").classList.toggle("hidden", !value);
  $("#cancel").disabled = !value;
  setText("#runProtection", value ? "スリープ防止中" : "待機中");
  if (!value) state.processAlive = false;
  if (title) setText("#runTitle", title);
  updateOperationalMetrics();
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

  if (isBonsaiProfile() && ["doctor", "coverage", "coverage-synthesize"].includes(command)) {
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
  setText("#runLabel", $("#runId").value.trim() || "—");
  resetRunMetrics();
  startTimer();

  const payload = {
    command,
    repoPath: state.repository,
    goal: $("#goal").value,
    runId: $("#runId").value.trim(),
    modelProfile: state.settings.modelProfile,
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
        void loadRunOverview(stoppedRunId);
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
        void loadRunOverview(completedRunId);
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
  setText("#repoUpdateStatus", "GitHubの最新版を確認しています...");
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

  const canInstall = ["available", "downloaded"].includes(state.updateState.state);
  $("#installUpdate").classList.toggle("hidden", !canInstall);
  $("#installUpdate").disabled = state.running || state.updateState.state === "downloading";
  $("#checkUpdate").disabled = state.updateState.state === "checking" || state.updateState.state === "downloading";
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

async function loadHistory() {
  const list = $("#historyList");
  list.textContent = "";
  list.appendChild(createPanelMessage("読み込み中..."));

  try {
    const items = await window.localAI.listHistory();
    state.history = items;
    populateRunSelect(items);

    state.latestRecoverable = items.find((item) => (
      item.status === "PARTIAL" &&
      (item.coverageComplete || (item.coveragePercent != null && item.coveragePercent < 100))
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
        item.reviewerDecision
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
        item.reviewerDecision ? `レビュー ${reviewerDecisionLabel(item.reviewerDecision)}` : null
      ].filter(Boolean);

      for (const value of metaValues) {
        const span = document.createElement("span");
        span.textContent = value;
        meta.appendChild(span);
      }

      if (item.synthesisError) {
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
        const [result] = await Promise.all([
          window.localAI.readRunResult(item.runId),
          loadRunOverview(item.runId)
        ]);
        state.result = result.content;
        setText("#resultTitle", "結果");
        setText("#result", result.content);
        $("#copy").disabled = false;
        ensureRunOption(item.runId);
        setText("#runLabel", item.runId);
        showView("home");
      });
      actions.appendChild(open);

      if (item.status === "PARTIAL" && item.coverageComplete) {
        const resume = document.createElement("button");
        resume.className = "primary";
        resume.textContent = "統合を再開";
        resume.addEventListener("click", () => prepareSynthesis(item));
        actions.appendChild(resume);
      } else if (item.status === "PARTIAL" && !item.coverageComplete) {
        const resume = document.createElement("button");
        resume.className = "primary";
        resume.textContent = "監査を再開";
        resume.disabled = !item.repoPath || !item.goal;
        resume.title = resume.disabled ? "この実行履歴には再開情報が不足しています" : "";
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
  setText("#profile", profileLabel(state.settings.modelProfile));
  $("#autoCheckUpdates").checked = state.settings.autoCheckUpdates !== false;
  $("#bonsaiDemoPath").value = state.settings.bonsaiDemoPath || "";
  updateBonsaiVisibility();
  window.localAI.onLog(appendLog);
  window.localAI.onUpdateStatus(applyUpdateState);
  window.localAI.onBonsaiStatus(applyBonsaiStatus);
  applyUpdateState(await window.localAI.getUpdateState());
  if (isBonsaiProfile()) await refreshBonsaiStatus();
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
$("#settingsProfile").addEventListener("change", () => updateBonsaiVisibility($("#settingsProfile").value));
$("#refresh").addEventListener("click", () => run("doctor"));
$("#reloadHistory").addEventListener("click", loadHistory);
$("#historyFilter").addEventListener("input", applyHistoryFilter);
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
      autoCheckUpdates: $("#autoCheckUpdates").checked,
      bonsaiDemoPath: $("#bonsaiDemoPath").value
    });
    state.settings = next;
    state.repository = selectedRepository || state.repository;
    setText("#repoPath", state.repository || "未選択");
    setText("#profile", profileLabel(next.modelProfile));
    updateBonsaiVisibility(next.modelProfile);
    if (isBonsaiProfile(next.modelProfile)) await refreshBonsaiStatus();
    setText("#saveMessage", "保存しました");
    setTimeout(() => setText("#saveMessage", ""), 1500);
  } catch (error) {
    setText("#saveMessage", friendlyError(error.message));
  }
});

init().catch((error) => {
  setText("#result", "初期化に失敗しました: " + friendlyError(error.message));
});
