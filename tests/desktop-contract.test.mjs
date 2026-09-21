import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("desktop Electron boundary keeps renderer isolated", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /preload\.cjs/);
  assert.match(main, /setWindowOpenHandler/);
});

test("desktop command runner is allowlisted and does not enable shell execution", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /allowedCommands\s*=\s*new Set/);
  assert.match(main, /shell:\s*false/);
  assert.doesNotMatch(main, /exec\(/);
});

test("sandboxed desktop preload uses CommonJS and exposes only the narrow bridge", async () => {
  const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /require\("electron"\)/);
  assert.doesNotMatch(preload, /^\s*import\s/m);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("localAI"/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/);
});


test("desktop validates privileged IPC senders and prevents renderer navigation", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /function assertTrustedSender/);
  assert.match(main, /senderFrame\?\.url/);
  assert.match(main, /registerIpc\(/);
  assert.match(main, /will-navigate/);
  assert.match(main, /event\.preventDefault\(\)/);
});

test("desktop renderer separates task selection from execution", async () => {
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");

  assert.match(renderer, /button\.dataset\.command\)\)\);/);
  assert.match(renderer, /selectCommand\(button\.dataset\.command\)/);
  assert.doesNotMatch(renderer, /run\(button\.dataset\.command\)/);
  assert.match(renderer, /#execute/);
  assert.match(renderer, /run\(state\.selectedCommand\)/);
  assert.match(html, /id="execute"/);
});

test("desktop exposes recovery state for partial coverage and synthesis", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");

  assert.match(main, /coverageComplete:/);
  assert.match(main, /synthesisError/);
  assert.match(main, /reviewerDecision/);
  assert.match(renderer, /prepareSynthesis/);
  assert.match(renderer, /prepareCoverageResume/);
  assert.match(renderer, /統合を再開/);
  assert.match(renderer, /監査を再開/);
});

test("desktop renderer has a restrictive CSP and avoids dynamic error HTML injection", async () => {
  const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(renderer, /innerHTML\s*=\s*.*error/i);
});

test("desktop diagnostics are bounded and exposed through narrow IPC", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");

  assert.match(main, /MAX_DIAGNOSTIC_EVENTS\s*=\s*100/);
  assert.match(main, /slice\(-MAX_DIAGNOSTIC_EVENTS\)/);
  assert.match(main, /diagnostics:list/);
  assert.match(main, /diagnostics:clear/);
  assert.match(preload, /listDiagnostics/);
  assert.match(preload, /clearDiagnostics/);
});


test("desktop user-facing controls are understandable in Japanese", async () => {
  const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");

  for (const visibleLabel of [
    "接続確認",
    "フォルダ確認",
    "全体監査",
    "結果を統合",
    "テスト",
    "実行状況",
    "対象フォルダ",
    "使用モデル"
  ]) {
    assert.ok(html.includes(visibleLabel), "missing Japanese UI label: " + visibleLabel);
  }

  for (const oldVisibleLabel of [
    ">Doctor<",
    ">Inspect<",
    ">Coverage Audit<",
    ">Synthesize<",
    ">Tests<",
    ">TASK<",
    ">RUN STATUS<",
    ">PREFERENCES<"
  ]) {
    assert.ok(!html.includes(oldVisibleLabel), "old English UI label remains: " + oldVisibleLabel);
  }

  assert.match(renderer, /label: "接続確認"/);
  assert.match(renderer, /label: "全体監査"/);
  assert.match(renderer, /label: "結果を統合"/);
  assert.match(renderer, /入力 \$\{state\.promptTokens\}/);
  assert.match(renderer, /出力 \$\{state\.completionTokens\}/);
});


test("desktop exposes managed Bonsai runtime controls without arbitrary shell access", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../desktop/bonsai-runtime.mjs", import.meta.url), "utf8");

  assert.match(main, /createBonsaiRuntimeController/);
  assert.match(main, /runtime:bonsai-select-folder/);
  assert.match(preload, /startBonsai/);
  assert.match(preload, /stopBonsai/);
  assert.match(preload, /getBonsaiStatus/);
  assert.match(html, /Bonsaiを起動/);
  assert.match(html, /Bonsaiを停止/);
  assert.match(renderer, /Bonsaiが停止中です/);
  assert.doesNotMatch(main, /scheduleAutoStart|autoStartBonsai/);
  assert.doesNotMatch(renderer, /autoStartBonsai/);
  assert.doesNotMatch(html, /アプリ起動時にBonsaiも起動する/);
  assert.match(runtime, /start_llama_server\.ps1/);
  assert.match(runtime, /powershell\.exe/);
  assert.match(runtime, /shell:\s*false/);
  assert.match(runtime, /taskkill\.exe/);
  assert.doesNotMatch(preload, /runShell|executeShell|powershell/i);
});


test("desktop protects long-running commands from sleep, duplicate instances, and accidental close", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");

  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /second-instance/);
  assert.match(main, /powerSaveBlocker\.start\("prevent-app-suspension"\)/);
  assert.match(main, /powerSaveBlocker\.stop\(/);
  assert.match(main, /showMessageBoxSync/);
  assert.match(main, /停止して終了/);
  assert.match(main, /windowStatePersistence:\s*true/);
});

test("desktop cancellation is explicit and kills the active process tree", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");

  assert.match(main, /function killProcessTree/);
  assert.match(main, /taskkill\.exe/);
  assert.match(main, /activeProcessCancelled\s*=\s*true/);
  assert.match(main, /cancelled:\s*true/);
  assert.match(renderer, /手動停止/);
  assert.match(renderer, /保存済みのCheckpoint/);
});

test("desktop command logs are line-buffered and memory bounded", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");

  assert.match(main, /MAX_COMMAND_OUTPUT_CHARS\s*=\s*2_000_000/);
  assert.match(main, /appendBoundedOutput/);
  assert.match(main, /pendingLines/);
  assert.match(main, /flushPendingLines/);
  assert.match(main, /outputTruncated/);
});

test("desktop history can safely open one run folder and filter saved runs", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");

  assert.match(main, /history:open-folder/);
  assert.match(main, /safeRunId\(runId\)/);
  assert.match(main, /shell\.openPath\(directory\)/);
  assert.match(preload, /openRunFolder/);
  assert.match(html, /id="historyFilter"/);
  assert.match(html, /id="historyCount"/);
  assert.match(renderer, /applyHistoryFilter/);
  assert.match(renderer, /folder\.textContent = "保存先"/);
});

test("desktop notifies when a background command completes or fails", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");

  assert.match(main, /Notification\.isSupported\(\)/);
  assert.match(main, /mainWindow\.isFocused\(\)/);
  assert.match(main, /showCommandNotification/);
  assert.match(main, /notification\.show\(\)/);
});


test("desktop always restores the last repository without asking every launch", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");

  assert.match(main, /findLastRepositoryFromHistory/);
  assert.match(main, /isUsableRepositoryPath/);
  assert.match(main, /defaultRepository: requestedRepository \? validateRepository\(requestedRepository\) : ""/);
  assert.match(main, /rememberRepository: _legacyRememberRepository/);
  assert.match(renderer, /state\.settings\.defaultRepository = path/);
  assert.match(renderer, /state\.settings = await window\.localAI\.saveSettings\(state\.settings\)/);
  assert.doesNotMatch(renderer, /#rememberRepo/);
  assert.doesNotMatch(html, /id="rememberRepo"/);
  assert.doesNotMatch(html, /前回の対象フォルダを保存する/);
});

test("desktop renderer bounds visible log rows during long runs", async () => {
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");

  assert.match(renderer, /MAX_RENDER_LOG_LINES\s*=\s*800/);
  assert.match(renderer, /childElementCount > MAX_RENDER_LOG_LINES/);
  assert.match(renderer, /firstElementChild\?\.remove\(\)/);
});


test("desktop result panel shows detailed live work and remaining-time context", async () => {
  const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");

  assert.match(html, /id="resultTitle"/);
  assert.match(html, /id="result" aria-live="polite"/);
  assert.match(renderer, /function updateLiveResult\(\)/);
  assert.match(renderer, /現在の作業:/);
  assert.match(renderer, /推定残り:/);
  assert.match(renderer, /完了済み処理の平均時間/);
  assert.match(renderer, /最初の処理完了後に推定/);
});


test("desktop exposes long-run health ETA speed system load and deterministic result summary", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");

  assert.match(main, /command:status/);
  assert.match(main, /system:metrics/);
  assert.match(main, /history:overview/);
  assert.match(preload, /getCommandStatus/);
  assert.match(preload, /getSystemMetrics/);
  assert.match(preload, /readRunOverview/);

  for (const id of [
    "finishEstimate",
    "lastUpdate",
    "runHealth",
    "averageBatch",
    "lastBatch",
    "tokenRate",
    "responseWait",
    "cpuMetric",
    "memoryMetric",
    "gpuMetric",
    "vramMetric",
    "resultOverview",
    "topFindings"
  ]) {
    assert.ok(html.includes(`id="${id}"`), "missing observability UI: " + id);
  }

  assert.match(renderer, /LONG_WAIT_SECONDS\s*=\s*600/);
  assert.match(renderer, /プロセス動作中・長時間応答待ち/);
  assert.match(renderer, /終了予想:/);
  assert.match(renderer, /トークン\/秒/);
  assert.match(renderer, /loadRunOverview/);
  assert.match(renderer, /startTelemetryPolling/);
});

test("desktop command disabling uses the multi-element selector helper", async () => {
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");
  const setRunning = renderer.match(/function setRunning\(value, title\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(setRunning, /\$\$\("\.commands button"\)\.forEach/);
  assert.doesNotMatch(setRunning, /\$\("\.commands button"\)\.forEach/);
});
