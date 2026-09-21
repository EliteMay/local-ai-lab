import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, powerSaveBlocker, shell } from "electron";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createUpdaterController } from "./updater.mjs";
import { createBonsaiRuntimeController } from "./bonsai-runtime.mjs";
import { createSystemMetricsSampler } from "./system-metrics.mjs";
import { buildRunOverview } from "./run-overview.mjs";
import { atomicWriteJson, readJsonWithBackup, readTextWithBackup } from "../src/core/atomic-file.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const rendererUrl = pathToFileURL(join(__dirname, "renderer", "index.html")).href;
const allowedCommands = new Set(["doctor", "inspect", "coverage", "coverage-synthesize", "test"]);
const MAX_GOAL_CHARS = 4000;
const MAX_CLIPBOARD_CHARS = 2_000_000;
const MAX_DIAGNOSTIC_EVENTS = 100;
const MAX_COMMAND_OUTPUT_CHARS = 2_000_000;
const COMMAND_LABELS = new Map([
  ["doctor", "接続確認"],
  ["inspect", "フォルダ確認"],
  ["coverage", "全体監査"],
  ["coverage-synthesize", "結果の統合"],
  ["test", "テスト"]
]);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow = null;
let activeProcess = null;
let activeProcessCommand = null;
let activeProcessCancelled = false;
let activePowerBlockerId = null;
let pendingQuitAfterCancel = false;
let allowWindowClose = false;
let updaterController = null;
let bonsaiRuntimeController = null;
let activeProcessStartedAt = null;
let activeProcessLastOutputAt = null;
const sampleSystemMetrics = createSystemMetricsSampler();

function safeProfile(value) {
  const profile = String(value || "default");
  if (profile === "default") return profile;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(profile)) throw new Error("モデル設定の値が不正です");
  return profile;
}

function safeRunId(value) {
  const runId = String(value || "");
  if (!/^run-[a-zA-Z0-9._-]+$/.test(runId)) throw new Error("実行IDが不正です");
  return runId;
}

function safeGoal(value) {
  const goal = String(value || "").trim();
  if (!goal) throw new Error("監査目的を入力してください");
  if (goal.length > MAX_GOAL_CHARS) throw new Error(`監査目的が長すぎます（最大${MAX_GOAL_CHARS}文字）`);
  return goal;
}

function validateRepository(repoPath) {
  const raw = String(repoPath || "").trim();
  if (!raw) throw new Error("対象フォルダを選択してください");
  const target = resolve(raw);
  if (!existsSync(target)) throw new Error("対象フォルダが見つかりません");
  try {
    if (!statSync(target).isDirectory()) throw new Error("対象フォルダではありません");
  } catch (error) {
    if (error?.message === "対象フォルダではありません") throw error;
    throw new Error("対象フォルダを確認できません");
  }
  return target;
}

function assertTrustedSender(event) {
  const senderUrl = event?.senderFrame?.url || "";
  if (senderUrl !== rendererUrl) {
    throw new Error("Rejected IPC request from an untrusted renderer");
  }
}

function registerIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    return handler(...args);
  });
}

function settingsPath() {
  return join(app.getPath("userData"), "settings.json");
}

function settingsBackupPath() {
  return join(app.getPath("userData"), "settings.backup.json");
}

function runsRoot() {
  return app.isPackaged
    ? join(app.getPath("userData"), "runtime-data", "runs")
    : join(projectRoot, "runtime-data", "runs");
}

function cliScriptPath() {
  return join(projectRoot, "src", "index.mjs");
}

function diagnosticsPath() {
  return join(app.getPath("userData"), "diagnostics.json");
}

function isUsableRepositoryPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const target = resolve(raw);
    return existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

async function findLastRepositoryFromHistory() {
  try {
    const items = await listHistory();
    for (const item of items) {
      if (isUsableRepositoryPath(item.repoPath)) return resolve(item.repoPath);
    }
  } catch {}
  return "";
}

async function writeSettings(next) {
  await mkdir(dirname(settingsPath()), { recursive: true });
  await atomicWriteJson(settingsPath(), next, { backupPath: settingsBackupPath() });
}

async function readSettings() {
  const defaults = {
    defaultRepository: app.isPackaged ? "" : projectRoot,
    modelProfile: "default",
    autoCheckUpdates: true,
    bonsaiDemoPath: existsSync("D:\\AI\\Bonsai-demo") ? "D:\\AI\\Bonsai-demo" : ""
  };

  let parsed = {};
  try {
    parsed = await readJsonWithBackup(settingsPath(), { backupPath: settingsBackupPath() });
  } catch {}

  const { rememberRepository: _legacyRememberRepository, ...current } = parsed || {};
  const merged = { ...defaults, ...current };
  let recoveredFromHistory = false;

  if (!isUsableRepositoryPath(merged.defaultRepository)) {
    const recovered = await findLastRepositoryFromHistory();
    if (recovered) {
      merged.defaultRepository = recovered;
      recoveredFromHistory = true;
    } else if (app.isPackaged) {
      merged.defaultRepository = "";
    }
  } else {
    merged.defaultRepository = resolve(merged.defaultRepository);
  }

  if (_legacyRememberRepository !== undefined || recoveredFromHistory) {
    try { await writeSettings(merged); } catch {}
  }

  return merged;
}

async function saveSettings(input) {
  const requestedRepository = String(input?.defaultRepository || "").trim();
  const next = {
    defaultRepository: requestedRepository ? validateRepository(requestedRepository) : "",
    modelProfile: safeProfile(input?.modelProfile),
    autoCheckUpdates: input?.autoCheckUpdates !== false,
    bonsaiDemoPath: String(input?.bonsaiDemoPath || "").trim()
  };
  await writeSettings(next);
  await appendDiagnostic({ type: "settings.saved", profile: next.modelProfile });
  return next;
}

async function readDiagnostics() {
  try {
    const parsed = await readJsonWithBackup(diagnosticsPath());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compactError(error) {
  return String(error?.message || error || "unknown").slice(0, 500);
}

async function appendDiagnostic(event) {
  try {
    const current = await readDiagnostics();
    const next = [
      ...current,
      {
        at: new Date().toISOString(),
        ...event
      }
    ].slice(-MAX_DIAGNOSTIC_EVENTS);
    await mkdir(dirname(diagnosticsPath()), { recursive: true });
    await atomicWriteJson(diagnosticsPath(), next);
  } catch {
    // Diagnostics must never break the primary task.
  }
}

async function clearDiagnostics() {
  await mkdir(dirname(diagnosticsPath()), { recursive: true });
  await atomicWriteJson(diagnosticsPath(), []);
  return true;
}

function buildCommand(input) {
  if (!input || typeof input !== "object") throw new Error("実行内容が不正です");
  const command = String(input.command || "");
  if (!allowedCommands.has(command)) throw new Error("この処理は実行できません");
  const profile = safeProfile(input.modelProfile);
  const profileArgs = profile === "default" ? [] : ["--model-profile", profile];

  if (command === "test") {
    return {
      command,
      profile,
      file: process.execPath,
      args: ["--test"],
      nodeMode: true
    };
  }

  const args = [cliScriptPath(), command, ...profileArgs];
  if (command === "inspect") {
    args.push("--repo", validateRepository(input.repoPath));
  }
  if (command === "coverage") {
    args.push("--repo", validateRepository(input.repoPath), "--goal", safeGoal(input.goal));
    if (input.runId) args.push("--run-id", safeRunId(input.runId));
    if (input.resume) args.push("--resume");
  }
  if (command === "coverage-synthesize") {
    args.push("--run-id", safeRunId(input.runId));
  }
  return { command, profile, file: process.execPath, args, nodeMode: true };
}

function startRunProtection() {
  if (activePowerBlockerId != null && powerSaveBlocker.isStarted(activePowerBlockerId)) {
    return activePowerBlockerId;
  }
  try {
    activePowerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    void appendDiagnostic({ type: "command.sleep-protection.started" });
  } catch (error) {
    activePowerBlockerId = null;
    void appendDiagnostic({
      type: "command.sleep-protection.error",
      error: compactError(error)
    });
  }
  return activePowerBlockerId;
}

function stopRunProtection() {
  if (activePowerBlockerId == null) return;
  try {
    if (powerSaveBlocker.isStarted(activePowerBlockerId)) {
      powerSaveBlocker.stop(activePowerBlockerId);
    }
  } catch {}
  activePowerBlockerId = null;
  void appendDiagnostic({ type: "command.sleep-protection.stopped" });
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    killer.unref();
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

function appendBoundedOutput(current, chunk) {
  const next = current + chunk;
  if (next.length <= MAX_COMMAND_OUTPUT_CHARS) {
    return { text: next, truncated: false };
  }
  return {
    text: next.slice(-MAX_COMMAND_OUTPUT_CHARS),
    truncated: true
  };
}

function showCommandNotification(command, ok) {
  if (!Notification.isSupported() || !mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  const label = COMMAND_LABELS.get(command) || "処理";
  const notification = new Notification({
    title: "Local AI Lab",
    body: ok ? `${label}が完了しました。` : `${label}でエラーが発生しました。`,
    silent: false
  });
  notification.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  notification.show();
}

async function cancelActiveCommand({ quitAfter = false } = {}) {
  if (!activeProcess) return { cancelled: false };
  activeProcessCancelled = true;
  pendingQuitAfterCancel = pendingQuitAfterCancel || quitAfter;
  const command = activeProcessCommand || "active command";
  const pid = activeProcess.pid;
  await appendDiagnostic({
    type: "command.cancel.requested",
    command,
    quitAfter,
    pid
  });
  killProcessTree(pid);
  return { cancelled: true };
}

function commandStatus() {
  return {
    running: Boolean(activeProcess),
    command: activeProcessCommand,
    startedAt: activeProcessStartedAt,
    lastOutputAt: activeProcessLastOutputAt,
    processAlive: Boolean(activeProcess && !activeProcess.killed)
  };
}

async function openRunFolder(runId) {
  const id = safeRunId(runId);
  const directory = join(runsRoot(), id);
  let info;
  try {
    info = await stat(directory);
  } catch {
    throw new Error("この実行履歴の保存フォルダが見つかりません。");
  }
  if (!info.isDirectory()) throw new Error("実行履歴の保存先が不正です。");
  const error = await shell.openPath(directory);
  if (error) throw new Error(`保存フォルダを開けませんでした: ${error}`);
  return { ok: true, runId: id };
}

function parseProgress(line) {
  const run = line.match(/(?:Coverage\] Run|Coverage run:|Synthesis run:|Stored run:)\s+(run-[\w.-]+)/);
  if (run) return { type: "run-id", runId: run[1] };

  const plan = line.match(/Files=(\d+).*chunks=(\d+).*batches=(\d+)/);
  if (plan) {
    return {
      type: "plan",
      files: Number(plan[1]),
      chunks: Number(plan[2]),
      batches: Number(plan[3])
    };
  }

  const start = line.match(/\[Coverage\]\s+START\s+(batch-[\w.-]+).*chunks=(\d+).*chars=(\d+)/);
  if (start) {
    return {
      type: "batch-start",
      batchId: start[1],
      chunks: Number(start[2]),
      chars: Number(start[3])
    };
  }

  const done = line.match(/\[Coverage\]\s+DONE\s+(batch-[\w.-]+)\s+\(([^)]+)\)(?:\s+\/\s+findings=(\d+))?(.*)$/);
  if (done) {
    const suffix = done[4] || "";
    return {
      type: "batch-done",
      batchId: done[1],
      durationText: done[2],
      findings: done[3] ? Number(done[3]) : null,
      promptTokens: Number(suffix.match(/prompt=(\d+)/)?.[1] || 0),
      completionTokens: Number(suffix.match(/completion=(\d+)/)?.[1] || 0),
      reasoningTokens: Number(suffix.match(/reasoning=(\d+)/)?.[1] || 0)
    };
  }

  const coverage = line.match(/coverage=(\d+(?:\.\d+)?)%/i);
  if (coverage) return { type: "coverage", percent: Number(coverage[1]) };

  if (/\[Synthesis\]\s+START/.test(line)) return { type: "stage", stage: "結果の統合を準備中" };
  if (/\[Synthesis\]\s+Planner START/.test(line)) return { type: "stage", stage: "改善案を作成中" };
  if (/\[Synthesis\]\s+Planner DONE/.test(line)) return { type: "stage", stage: "改善案の作成完了" };
  if (/\[Synthesis\]\s+Reviewer START/.test(line)) return { type: "stage", stage: "レビュー中" };
  if (/\[Synthesis\]\s+Reviewer DONE/.test(line)) return { type: "stage", stage: "レビュー完了" };
  if (/\[Synthesis\]\s+Run COMPLETED/.test(line)) return { type: "stage", stage: "結果の統合完了" };
  if (/\[Coverage\]\s+Run PARTIAL/.test(line)) return { type: "stage", stage: "監査完了 / 結果の統合を再開可能" };
  if (/\[Coverage\]\s+Run COMPLETED/.test(line)) return { type: "stage", stage: "監査完了" };
  return null;
}

async function runCommand(input) {
  if (activeProcess) throw new Error("Another command is already running");
  const spec = buildCommand(input);
  const startedAt = Date.now();
  await appendDiagnostic({ type: "command.started", command: spec.command, profile: spec.profile });

  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    let outputTruncated = false;
    let settled = false;
    const pendingLines = { stdout: "", stderr: "" };

    const child = spawn(spec.file, spec.args, {
      cwd: projectRoot,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        ...(spec.nodeMode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        LOCAL_AI_RUNTIME_DATA_ROOT: runsRoot()
      }
    });

    activeProcess = child;
    activeProcessCommand = spec.command;
    activeProcessStartedAt = Date.now();
    activeProcessLastOutputAt = Date.now();
    activeProcessCancelled = false;
    pendingQuitAfterCancel = false;
    startRunProtection();

    const sendLine = (channel, line) => {
      if (!line) return;
      mainWindow?.webContents.send("command:log", {
        channel,
        line,
        progress: parseProgress(line)
      });
    };

    const emit = (channel, chunk) => {
      activeProcessLastOutputAt = Date.now();
      const text = chunk.toString();
      const bounded = appendBoundedOutput(output, text);
      output = bounded.text;
      outputTruncated = outputTruncated || bounded.truncated;

      const combined = pendingLines[channel] + text;
      const lines = combined.split(/\r?\n/);
      pendingLines[channel] = lines.pop() || "";
      for (const line of lines) sendLine(channel, line);
    };

    const flushPendingLines = () => {
      for (const channel of ["stdout", "stderr"]) {
        const line = pendingLines[channel];
        pendingLines[channel] = "";
        if (line) sendLine(channel, line);
      }
    };

    const cleanup = () => {
      if (activeProcess === child) {
        activeProcess = null;
        activeProcessCommand = null;
        activeProcessStartedAt = null;
        activeProcessLastOutputAt = null;
      }
      stopRunProtection();
    };

    const finishQuitIfRequested = () => {
      if (!pendingQuitAfterCancel) return;
      pendingQuitAfterCancel = false;
      allowWindowClose = true;
      setTimeout(() => app.quit(), 0);
    };

    child.stdout.on("data", (chunk) => emit("stdout", chunk));
    child.stderr.on("data", (chunk) => emit("stderr", chunk));

    child.on("error", async (error) => {
      if (settled) return;
      settled = true;
      flushPendingLines();
      const cancelled = activeProcessCancelled;
      cleanup();

      if (cancelled) {
        const result = {
          ok: false,
          cancelled: true,
          code: null,
          output: output.trim(),
          outputTruncated,
          elapsedMs: Date.now() - startedAt
        };
        await appendDiagnostic({
          type: "command.cancelled",
          command: spec.command,
          profile: spec.profile,
          elapsedMs: result.elapsedMs
        });
        resolvePromise(result);
        finishQuitIfRequested();
        return;
      }

      await appendDiagnostic({
        type: "command.error",
        command: spec.command,
        profile: spec.profile,
        error: compactError(error)
      });
      showCommandNotification(spec.command, false);
      rejectPromise(error);
      finishQuitIfRequested();
    });

    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      flushPendingLines();

      const cancelled = activeProcessCancelled;
      const elapsedMs = Date.now() - startedAt;
      cleanup();

      const resultOutput = outputTruncated
        ? "[ログ前半は長さ上限のため省略しました]\n" + output.trim()
        : output.trim();

      const result = {
        ok: code === 0 && !cancelled,
        cancelled,
        code,
        output: resultOutput,
        outputTruncated,
        elapsedMs
      };

      if (cancelled) {
        await appendDiagnostic({
          type: "command.cancelled",
          command: spec.command,
          profile: spec.profile,
          elapsedMs
        });
        resolvePromise(result);
        finishQuitIfRequested();
        return;
      }

      await appendDiagnostic({
        type: "command.finished",
        command: spec.command,
        profile: spec.profile,
        ok: result.ok,
        code,
        elapsedMs,
        outputTruncated
      });

      showCommandNotification(spec.command, result.ok);

      if (code === 0) resolvePromise(result);
      else rejectPromise(new Error(result.output || ("処理に失敗しました。終了コード: " + code)));

      finishQuitIfRequested();
    });
  });
}

async function readOptionalJsonFile(path, fallback) {
  try {
    return await readJsonWithBackup(path);
  } catch {
    return fallback;
  }
}

async function listHistory() {
  const root = runsRoot();
  if (!existsSync(root)) return [];
  const names = await readdir(root);
  const items = [];

  for (const name of names) {
    if (!/^run-[a-zA-Z0-9._-]+$/.test(name)) continue;
    const directory = join(root, name);
    const info = await stat(directory);
    const [run, coverage, findings, synthesis] = await Promise.all([
      readOptionalJsonFile(join(directory, "run.json"), {}),
      readOptionalJsonFile(join(directory, "coverage.json"), {}),
      readOptionalJsonFile(join(directory, "findings.json"), []),
      readOptionalJsonFile(join(directory, "synthesis.json"), {})
    ]);

    const status = run.status || coverage.status || (coverage.complete ? "COMPLETED" : "UNKNOWN");
    const coveragePercent = coverage.coveragePercent ?? null;
    const synthesisError = run.synthesisError || synthesis.error || null;
    const identity = run.executionIdentity || {};
    items.push({
      runId: name,
      createdAt: run.createdAt || info.birthtime?.toISOString?.() || info.mtime.toISOString(),
      updatedAt: run.completedAt || run.interruptedAt || info.mtime.toISOString(),
      status,
      coveragePercent,
      coverageComplete: coverage.complete === true,
      completedChunks: coverage.completedChunks ?? null,
      totalChunks: coverage.totalChunks ?? null,
      findingCount: Array.isArray(findings) ? findings.length : (findings.findings?.length ?? 0),
      synthesisError,
      reviewerDecision: run.reviewerDecision || synthesis.reviewer?.result?.decision || null,
      repoPath: typeof run.repoPath === "string" ? run.repoPath : "",
      repoName: typeof run.repoPath === "string" && run.repoPath ? basename(run.repoPath) : "",
      goal: typeof run.goal === "string" ? run.goal : "",
      model: identity.model || "",
      modelProfile: identity.modelProfile || "",
      appVersion: identity.appVersion || "",
      interruptionReason: run.interruptionReason || ""
    });
  }

  return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function readRunResult(runId) {
  const id = safeRunId(runId);
  const directory = join(runsRoot(), id);
  for (const name of ["summary.md", "synthesis.json", "review.json", "findings.json", "coverage.json"]) {
    try {
      return {
        runId: id,
        fileName: name,
        content: await readTextWithBackup(join(directory, name))
      };
    } catch {}
  }
  throw new Error("読み込める結果ファイルが見つかりません");
}

async function readRunDetails(runId) {
  const id = safeRunId(runId);
  const directory = join(runsRoot(), id);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new Error("この実行履歴が見つかりません");

  const [run, coverage, findings, synthesis, review, plan, batches] = await Promise.all([
    readOptionalJsonFile(join(directory, "run.json"), {}),
    readOptionalJsonFile(join(directory, "coverage.json"), {}),
    readOptionalJsonFile(join(directory, "findings.json"), []),
    readOptionalJsonFile(join(directory, "synthesis.json"), {}),
    readOptionalJsonFile(join(directory, "review.json"), {}),
    readOptionalJsonFile(join(directory, "coverage-plan.json"), {}),
    readOptionalJsonFile(join(directory, "batch-results.json"), [])
  ]);

  let summary = "";
  try { summary = await readTextWithBackup(join(directory, "summary.md")); } catch {}

  return {
    runId: id,
    run,
    coverage,
    findings: Array.isArray(findings) ? findings : (findings.findings || []),
    planner: synthesis?.planner?.result || synthesis?.planner || null,
    reviewer: synthesis?.reviewer?.result || review?.result || synthesis?.reviewer || review || null,
    reduction: synthesis?.reduction || null,
    excluded: Array.isArray(plan?.excluded) ? plan.excluded : [],
    files: Array.isArray(plan?.files) ? plan.files : [],
    batchResults: Array.isArray(batches) ? batches : [],
    summary
  };
}

async function readOptionalRunJson(directory, name, fallback) {
  return readOptionalJsonFile(join(directory, name), fallback);
}

async function readRunOverview(runId) {
  const id = safeRunId(runId);
  const directory = join(runsRoot(), id);
  let info;
  try {
    info = await stat(directory);
  } catch {
    throw new Error("この実行履歴が見つかりません");
  }
  if (!info.isDirectory()) throw new Error("実行履歴の保存先が不正です");

  const [run, coverage, findings, synthesis] = await Promise.all([
    readOptionalRunJson(directory, "run.json", {}),
    readOptionalRunJson(directory, "coverage.json", {}),
    readOptionalRunJson(directory, "findings.json", []),
    readOptionalRunJson(directory, "synthesis.json", {})
  ]);

  return {
    runId: id,
    ...buildRunOverview({ run, coverage, findings, synthesis })
  };
}

async function runGit(repoPath, args) {
  const cwd = validateRepository(repoPath);
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("git", ["-C", cwd, ...args], {
      windowsHide: true,
      shell: false
    });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0) resolvePromise(result);
      else rejectPromise(new Error(result.stderr || result.stdout || `Git処理に失敗しました。終了コード: ${code}`));
    });
  });
}

async function updateRepository(repoPath) {
  if (activeProcess) throw new Error("処理実行中は対象フォルダを更新できません。");
  const repository = validateRepository(repoPath);

  const inside = await runGit(repository, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.stdout !== "true") throw new Error("選択したフォルダはGitリポジトリではありません。");

  const dirty = await runGit(repository, ["status", "--porcelain"]);
  if (dirty.stdout) {
    throw new Error("未コミットの変更があるため更新を中止しました。変更を保存・退避・破棄してから再実行してください。");
  }

  const branch = await runGit(repository, ["symbolic-ref", "--short", "HEAD"]);
  if (!branch.stdout) throw new Error("現在のGit状態では安全に更新できません。通常のブランチへ戻してから再実行してください。");

  const before = (await runGit(repository, ["rev-parse", "HEAD"])).stdout;
  await runGit(repository, ["fetch", "--prune", "origin"]);
  const pull = await runGit(repository, ["pull", "--ff-only", "origin", branch.stdout]);
  const after = (await runGit(repository, ["rev-parse", "HEAD"])).stdout;
  const updated = before !== after;

  await appendDiagnostic({
    type: "repository.updated",
    updated,
    branch: branch.stdout,
    before: before.slice(0, 12),
    after: after.slice(0, 12)
  });

  return {
    ok: true,
    updated,
    branch: branch.stdout,
    before,
    after,
    message: updated
      ? `GitHubの最新版へ更新しました（${before.slice(0, 7)} → ${after.slice(0, 7)}）。`
      : "すでに最新版です。",
    detail: pull.stdout
  };
}

async function isLocalAiLabRepository(repoPath) {
  if (!repoPath) return false;
  try {
    const pkg = JSON.parse(await readFile(join(repoPath, "package.json"), "utf8"));
    return pkg?.name === "local-ai-lab";
  } catch {
    return false;
  }
}

async function migrateLegacyRunsIfNeeded() {
  if (!app.isPackaged) return { migrated: false };
  const destination = runsRoot();
  try {
    const existing = await readdir(destination);
    if (existing.length) return { migrated: false };
  } catch {}

  const settings = await readSettings();
  if (!(await isLocalAiLabRepository(settings.defaultRepository))) return { migrated: false };

  const source = join(settings.defaultRepository, "runtime-data", "runs");
  if (!existsSync(source)) return { migrated: false };

  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: false, force: false });
  await appendDiagnostic({ type: "runtime-data.migrated", source: "legacy-local-ai-lab-repository" });
  return { migrated: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    name: "main-window",
    windowStatePersistence: true,
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#0b0d10",
    title: "Local AI Lab",
    icon: join(__dirname, "assets", "generated", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });

  mainWindow.on("close", (event) => {
    if (!activeProcess || allowWindowClose) return;
    event.preventDefault();

    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      title: "処理を実行中です",
      message: "実行中の処理があります。",
      detail: "このまま終了すると現在の処理を停止します。保存済みのCheckpointがある全体監査は、次回起動後に履歴から再開できます。",
      buttons: ["処理を続ける", "停止して終了"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });

    if (choice === 1) {
      void cancelActiveCommand({ quitAfter: true });
    }
  });
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId("local.elitemay.localailab");
  }
  await migrateLegacyRunsIfNeeded();
  registerIpc("settings:get", () => readSettings());
  registerIpc("settings:save", (input) => saveSettings(input));
  registerIpc("repository:select", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  registerIpc("runtime:bonsai-select-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Bonsai-demoフォルダを選択",
      properties: ["openDirectory"]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  registerIpc("repository:update", (repoPath) => updateRepository(repoPath));
  registerIpc("command:run", (input) => runCommand(input));
  registerIpc("command:cancel", () => cancelActiveCommand());
  registerIpc("command:status", () => commandStatus());
  registerIpc("system:metrics", () => sampleSystemMetrics());
  registerIpc("history:list", () => listHistory());
  registerIpc("history:result", (id) => readRunResult(id));
  registerIpc("history:overview", (id) => readRunOverview(id));
  registerIpc("history:open-folder", (id) => openRunFolder(id));
  registerIpc("diagnostics:list", () => readDiagnostics());
  registerIpc("diagnostics:clear", () => clearDiagnostics());
  registerIpc("clipboard:write", (value) => {
    const text = String(value || "");
    if (text.length > MAX_CLIPBOARD_CHARS) throw new Error("コピーする内容が大きすぎます");
    clipboard.writeText(text);
    return true;
  });
  bonsaiRuntimeController = createBonsaiRuntimeController({
    registerIpc,
    readSettings,
    appendDiagnostic,
    getMainWindow: () => mainWindow
  });
  updaterController = createUpdaterController({
    registerIpc,
    readSettings,
    appendDiagnostic,
    getMainWindow: () => mainWindow,
    isBusy: () => Boolean(activeProcess)
  });
  createWindow();
  await updaterController.scheduleAutoCheck();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
