const COMMAND_META = {
  doctor: { label: "Doctor", execute: "Doctorを実行" },
  inspect: { label: "Inspect", execute: "Inspectを実行" },
  coverage: { label: "Coverage Audit", execute: "Coverage Auditを実行" },
  "coverage-synthesize": { label: "Synthesize", execute: "Synthesisを実行" },
  test: { label: "Tests", execute: "Testsを実行" }
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
  currentBatch: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

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

function updateTiming() {
  if (!state.startedAt) {
    setText("#elapsed", "—");
    setText("#estimate", "—");
    return;
  }

  setText("#elapsed", formatDuration((Date.now() - state.startedAt) / 1000));

  if (state.totalBatches > 0 && state.batchDurations.length > 0 && state.completedBatches < state.totalBatches) {
    const average = state.batchDurations.reduce((sum, value) => sum + value, 0) / state.batchDurations.length;
    const remaining = state.totalBatches - state.completedBatches;
    setText("#estimate", "約 " + formatDuration(average * remaining));
  } else if (state.running && state.totalBatches > 0 && state.completedBatches >= state.totalBatches) {
    setText("#estimate", "統合処理中");
  } else if (state.running) {
    setText("#estimate", "計測中");
  } else {
    setText("#estimate", "—");
  }
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
  setText("#batchMetric", "Batch —");
  setText("#tokenMetric", "Tokens —");
  setText("#stage", "開始準備中");
  setText("#estimate", "計測中");
}

function updateTokenMetric() {
  const parts = [
    `Prompt ${state.promptTokens}`,
    `Completion ${state.completionTokens}`
  ];
  if (state.reasoningTokens > 0) parts.push(`Reasoning ${state.reasoningTokens}`);
  setText("#tokenMetric", parts.join(" · "));
}

function updateCoverageMode() {
  if (state.selectedCommand !== "coverage") return;
  if (state.resume) {
    setText("#coverageMode", `保存済みRun ${$("#runId").value || ""} の未完了Batchから再開します。`);
    setText("#execute", "Coverageを再開");
  } else {
    setText("#coverageMode", "新しいCoverage Auditとして実行します。");
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
  $("#refresh").disabled = value;
  $("#cancel").classList.toggle("hidden", !value);
  if (title) setText("#runTitle", title);
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

function setStage(value) {
  setText("#stage", value);
}

function appendLog(payload) {
  const line = document.createElement("div");
  if (payload.channel === "stderr") line.className = "err";
  line.textContent = payload.line;
  $("#log").appendChild(line);
  $("#log").scrollTop = $("#log").scrollHeight;

  const progress = payload.progress;
  if (!progress) return;

  if (progress.type === "run-id") {
    setText("#runLabel", progress.runId);
    ensureRunOption(progress.runId);
    return;
  }

  if (progress.type === "plan") {
    state.totalBatches = progress.batches;
    state.completedBatches = 0;
    setStage("Coverage計画作成済み");
    setText("#progress", `0 / ${progress.batches} batches · ${progress.files} files · ${progress.chunks} chunks`);
    updateTiming();
    return;
  }

  if (progress.type === "batch-start") {
    state.currentBatch = progress.batchId;
    setStage(`${progress.batchId} 監査中`);
    setText("#batchMetric", `${progress.batchId} · ${progress.chunks} chunks · ${progress.chars} chars`);
    return;
  }

  if (progress.type === "batch-done") {
    if (!state.completedBatchIds.has(progress.batchId)) {
      state.completedBatchIds.add(progress.batchId);
      state.completedBatches += 1;
      const seconds = parseDurationText(progress.durationText);
      if (seconds) state.batchDurations.push(seconds);
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
        ? `${state.completedBatches} / ${state.totalBatches} batches`
        : "Coverage処理中"
    );
    setText(
      "#batchMetric",
      `${progress.batchId} 完了 · ${progress.durationText}${progress.findings == null ? "" : ` · Findings ${progress.findings}`}`
    );
    updateTokenMetric();
    updateTiming();
    return;
  }

  if (progress.type === "coverage") {
    $("#bar").style.width = Math.max(0, Math.min(100, progress.percent)) + "%";
    setText("#progress", `Coverage ${progress.percent}%`);
    return;
  }

  if (progress.type === "stage") {
    setStage(progress.stage);
    if (progress.stage.includes("Synthesis") || progress.stage.includes("Planner") || progress.stage.includes("Reviewer")) {
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
  setText("#connection", loaded === "yes" ? "接続中" : "Model未Load");
  $("#dot").classList.toggle("online", loaded === "yes");
  $("#dot").classList.toggle("offline", loaded !== "yes");
  setText("#runtimeMini", loaded === "yes" ? "Runtime 接続中" : "Runtime 要確認");
}

function friendlyError(message) {
  const text = String(message || "不明なエラー");
  if (text.includes("ECONNREFUSED 127.0.0.1:8080")) {
    return "Bonsai Runtimeが起動していません。Bonsai serverを起動してから「接続状態を更新」を実行してください。";
  }
  if (text.includes("ECONNREFUSED 127.0.0.1:1234")) {
    return "LM StudioのLocal Serverへ接続できません。LM Studio側でServerとModelを起動してください。";
  }
  if (text.includes("Another command is already running")) {
    return "別の処理が実行中です。完了または停止してから実行してください。";
  }
  return text;
}

function validateBeforeRun(command) {
  if (command === "coverage" && !$("#goal").value.trim()) {
    throw new Error("監査目的を入力してください。");
  }
  if (command === "coverage-synthesize" && !$("#runId").value.trim()) {
    throw new Error("Synthesis対象Runを選択してください。");
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

  $("#log").textContent = "";
  setText("#result", "実行中...");
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
  let succeeded = false;

  try {
    const result = await window.localAI.runCommand(payload);
    succeeded = true;
    state.result = result.output || "完了しました。";
    setText("#result", state.result);
    $("#copy").disabled = false;
    $("#bar").style.width = "100%";
    setText("#progress", "完了");
    setStage(command === "doctor" ? "接続確認完了" : "処理完了");
    if (command === "doctor") applyDoctor(state.result);
  } catch (error) {
    state.result = friendlyError(error.message);
    setText("#result", state.result);
    $("#copy").disabled = false;
    setText("#progress", "失敗");
    setStage("エラー");
  } finally {
    stopTimer();
    updateTiming();
    setRunning(false);
    if (succeeded && command === "coverage") {
      state.resume = false;
      updateCoverageMode();
    }
    await loadHistory();
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
  if (state.settings.rememberRepository) {
    state.settings.defaultRepository = path;
    state.settings = await window.localAI.saveSettings(state.settings);
  }
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

function createStatusBadge(item) {
  const badge = document.createElement("span");
  badge.className = "badge " + String(item.status || "UNKNOWN").toLowerCase();
  if (item.status === "PARTIAL" && item.coverageComplete) {
    badge.textContent = "Synthesis待ち";
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
  selectCommand("coverage-synthesize");
  ensureRunOption(item.runId, `${item.runId} · Coverage ${item.coveragePercent ?? "—"}%`);
  state.result = `${item.runId} の保存済みEvidenceからSynthesisを再開する準備ができました。`;
  setText("#result", state.result);
  setText("#runLabel", item.runId);
}

function prepareCoverageResume(item) {
  if (!item.repoPath || !item.goal) {
    state.result = "このRunには再開に必要なRepositoryまたはGoal情報がありません。";
    setText("#result", state.result);
    showView("home");
    return;
  }

  showView("home");
  selectCommand("coverage");
  state.resume = true;
  state.repository = item.repoPath;
  setText("#repoPath", item.repoPath);
  $("#goal").value = item.goal;
  ensureRunOption(item.runId, `${item.runId} · Coverage ${item.coveragePercent ?? "—"}%`);
  setText("#runLabel", item.runId);
  updateCoverageMode();
  state.result = `${item.runId} の未完了Coverageから再開する準備ができました。`;
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
    setText("#resumeTitle", "Coverage 100% · Synthesisを再開できます");
    setText(
      "#resumeDescription",
      `${item.runId} · Findings ${item.findingCount}${item.synthesisError ? " · 前回のSynthesisで停止" : ""}`
    );
    setText("#resumeAction", "Synthesis再開準備");
  } else {
    setText("#resumeTitle", "途中のCoverageがあります");
    setText(
      "#resumeDescription",
      `${item.runId} · Coverage ${item.coveragePercent ?? "—"}% · ${item.completedChunks ?? "—"}/${item.totalChunks ?? "—"} chunks`
    );
    setText("#resumeAction", "Coverage再開準備");
  }
}

function populateRunSelect(items) {
  const select = $("#runId");
  const selected = select.value;
  select.textContent = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "履歴からRunを選択してください";
  select.appendChild(placeholder);

  for (const item of items.filter((entry) => entry.coverageComplete)) {
    const option = document.createElement("option");
    option.value = item.runId;
    const stateLabel = item.status === "COMPLETED" ? "完了" : "Synthesis待ち";
    option.textContent = `${item.runId} · ${stateLabel} · Findings ${item.findingCount}`;
    select.appendChild(option);
  }

  if (selected && [...select.options].some((option) => option.value === selected)) {
    select.value = selected;
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
      list.appendChild(createPanelMessage("まだ保存済みRunはありません。"));
      return;
    }

    for (const item of items) {
      const row = document.createElement("article");
      row.className = "history-item";

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
        item.repoName || "Repository不明",
        `Coverage ${item.coveragePercent ?? "—"}%`,
        `Findings ${item.findingCount}`,
        item.reviewerDecision ? `Reviewer ${item.reviewerDecision}` : null
      ].filter(Boolean);

      for (const value of metaValues) {
        const span = document.createElement("span");
        span.textContent = value;
        meta.appendChild(span);
      }

      if (item.synthesisError) {
        const note = document.createElement("p");
        note.className = "history-context warning";
        note.textContent = "Synthesis未完了: " + item.synthesisError;
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
        const result = await window.localAI.readRunResult(item.runId);
        state.result = result.content;
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
        resume.textContent = "Synthesis再開";
        resume.addEventListener("click", () => prepareSynthesis(item));
        actions.appendChild(resume);
      } else if (item.status === "PARTIAL" && !item.coverageComplete) {
        const resume = document.createElement("button");
        resume.className = "primary";
        resume.textContent = "Coverage再開";
        resume.disabled = !item.repoPath || !item.goal;
        resume.title = resume.disabled ? "このRunには再開情報が不足しています" : "";
        resume.addEventListener("click", () => prepareCoverageResume(item));
        actions.appendChild(resume);
      } else if (item.status === "COMPLETED" && item.coverageComplete) {
        const synth = document.createElement("button");
        synth.className = "ghost";
        synth.textContent = "再Synthesis";
        synth.addEventListener("click", () => prepareSynthesis(item));
        actions.appendChild(synth);
      }

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
  setText("#repoPath", state.repository);
  $("#settingsRepo").value = state.repository;
  $("#settingsProfile").value = state.settings.modelProfile;
  setText("#profile", state.settings.modelProfile);
  $("#rememberRepo").checked = state.settings.rememberRepository;
  window.localAI.onLog(appendLog);
  selectCommand("coverage");
  await loadHistory();
}

$$(".nav").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$$(".commands button").forEach((button) => button.addEventListener("click", () => selectCommand(button.dataset.command)));
$("#execute").addEventListener("click", () => run(state.selectedCommand));
$("#chooseRepo").addEventListener("click", () => chooseRepository(false));
$("#settingsRepoButton").addEventListener("click", () => chooseRepository(true));
$("#refresh").addEventListener("click", () => run("doctor"));
$("#reloadHistory").addEventListener("click", loadHistory);
$("#cancel").addEventListener("click", () => window.localAI.cancelCommand());
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
$("#save").addEventListener("click", async () => {
  try {
    const next = await window.localAI.saveSettings({
      defaultRepository: $("#settingsRepo").value,
      modelProfile: $("#settingsProfile").value,
      rememberRepository: $("#rememberRepo").checked
    });
    state.settings = next;
    state.repository = next.defaultRepository;
    setText("#repoPath", state.repository);
    setText("#profile", next.modelProfile);
    setText("#saveMessage", "保存しました");
    setTimeout(() => setText("#saveMessage", ""), 1500);
  } catch (error) {
    setText("#saveMessage", friendlyError(error.message));
  }
});

init().catch((error) => {
  setText("#result", "初期化に失敗しました: " + friendlyError(error.message));
});
