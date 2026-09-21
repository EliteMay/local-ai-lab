import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const rendererUrl = pathToFileURL(join(__dirname, "renderer", "index.html")).href;
const allowedCommands = new Set(["doctor", "inspect", "coverage", "coverage-synthesize", "test"]);
const MAX_GOAL_CHARS = 4000;
const MAX_CLIPBOARD_CHARS = 2_000_000;
const MAX_DIAGNOSTIC_EVENTS = 100;
let mainWindow = null;
let activeProcess = null;

function safeProfile(value) {
  const profile = String(value || "default");
  if (profile === "default") return profile;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(profile)) throw new Error("Invalid model profile");
  return profile;
}

function safeRunId(value) {
  const runId = String(value || "");
  if (!/^run-[a-zA-Z0-9._-]+$/.test(runId)) throw new Error("Invalid run id");
  return runId;
}

function safeGoal(value) {
  const goal = String(value || "").trim();
  if (!goal) throw new Error("Coverage goal is required");
  if (goal.length > MAX_GOAL_CHARS) throw new Error(`Coverage goal is too long (max ${MAX_GOAL_CHARS} chars)`);
  return goal;
}

function validateRepository(repoPath) {
  const target = resolve(String(repoPath || ""));
  if (!target || !existsSync(target)) throw new Error("Repository path does not exist");
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

function diagnosticsPath() {
  return join(app.getPath("userData"), "diagnostics.json");
}

async function readSettings() {
  const defaults = {
    defaultRepository: projectRoot,
    modelProfile: "default",
    rememberRepository: true
  };
  try {
    return { ...defaults, ...JSON.parse(await readFile(settingsPath(), "utf8")) };
  } catch {
    return defaults;
  }
}

async function saveSettings(input) {
  const next = {
    defaultRepository: validateRepository(input?.defaultRepository || projectRoot),
    modelProfile: safeProfile(input?.modelProfile),
    rememberRepository: input?.rememberRepository !== false
  };
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  await appendDiagnostic({ type: "settings.saved", profile: next.modelProfile });
  return next;
}

async function readDiagnostics() {
  try {
    const parsed = JSON.parse(await readFile(diagnosticsPath(), "utf8"));
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
    await writeFile(diagnosticsPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // Diagnostics must never break the primary task.
  }
}

async function clearDiagnostics() {
  await mkdir(dirname(diagnosticsPath()), { recursive: true });
  await writeFile(diagnosticsPath(), "[]\n", "utf8");
  return true;
}

function buildCommand(input) {
  if (!input || typeof input !== "object") throw new Error("Invalid command payload");
  const command = String(input.command || "");
  if (!allowedCommands.has(command)) throw new Error("Command is not allowed");
  const profile = safeProfile(input.modelProfile);
  const profileArgs = profile === "default" ? [] : ["--model-profile", profile];

  if (command === "test") {
    return { command, profile, file: process.platform === "win32" ? "npm.cmd" : "npm", args: ["test"] };
  }

  const args = ["src/index.mjs", command, ...profileArgs];
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
  return { command, profile, file: "node", args };
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

  if (/\[Synthesis\]\s+START/.test(line)) return { type: "stage", stage: "Synthesis準備" };
  if (/\[Synthesis\]\s+Planner START/.test(line)) return { type: "stage", stage: "Planner実行中" };
  if (/\[Synthesis\]\s+Planner DONE/.test(line)) return { type: "stage", stage: "Planner完了" };
  if (/\[Synthesis\]\s+Reviewer START/.test(line)) return { type: "stage", stage: "Reviewer実行中" };
  if (/\[Synthesis\]\s+Reviewer DONE/.test(line)) return { type: "stage", stage: "Reviewer完了" };
  if (/\[Synthesis\]\s+Run COMPLETED/.test(line)) return { type: "stage", stage: "Synthesis完了" };
  if (/\[Coverage\]\s+Run PARTIAL/.test(line)) return { type: "stage", stage: "Coverage完了 / Synthesis要再開" };
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
    const child = spawn(spec.file, spec.args, {
      cwd: projectRoot,
      windowsHide: true,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0" }
    });
    activeProcess = child;

    const emit = (channel, chunk) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        mainWindow?.webContents.send("command:log", {
          channel,
          line,
          progress: parseProgress(line)
        });
      }
    };

    child.stdout.on("data", (chunk) => emit("stdout", chunk));
    child.stderr.on("data", (chunk) => emit("stderr", chunk));
    child.on("error", async (error) => {
      activeProcess = null;
      await appendDiagnostic({
        type: "command.error",
        command: spec.command,
        profile: spec.profile,
        error: compactError(error)
      });
      rejectPromise(error);
    });
    child.on("close", async (code) => {
      activeProcess = null;
      const result = {
        ok: code === 0,
        code,
        output: output.trim(),
        elapsedMs: Date.now() - startedAt
      };
      await appendDiagnostic({
        type: "command.finished",
        command: spec.command,
        profile: spec.profile,
        ok: result.ok,
        code,
        elapsedMs: result.elapsedMs
      });
      if (code === 0) resolvePromise(result);
      else rejectPromise(new Error(result.output || ("Command failed with code " + code)));
    });
  });
}

async function listHistory() {
  const root = join(projectRoot, "runtime-data", "runs");
  if (!existsSync(root)) return [];
  const names = await readdir(root);
  const items = [];

  for (const name of names) {
    if (!/^run-[a-zA-Z0-9._-]+$/.test(name)) continue;
    const directory = join(root, name);
    const info = await stat(directory);
    let run = {};
    let coverage = {};
    let findings = [];
    let synthesis = {};
    try { run = JSON.parse(await readFile(join(directory, "run.json"), "utf8")); } catch {}
    try { coverage = JSON.parse(await readFile(join(directory, "coverage.json"), "utf8")); } catch {}
    try { findings = JSON.parse(await readFile(join(directory, "findings.json"), "utf8")); } catch {}
    try { synthesis = JSON.parse(await readFile(join(directory, "synthesis.json"), "utf8")); } catch {}

    const status = run.status || coverage.status || (coverage.complete ? "COMPLETED" : "UNKNOWN");
    const coveragePercent = coverage.coveragePercent ?? null;
    const synthesisError = run.synthesisError || synthesis.error || null;
    items.push({
      runId: name,
      createdAt: run.createdAt || info.birthtime?.toISOString?.() || info.mtime.toISOString(),
      updatedAt: run.completedAt || info.mtime.toISOString(),
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
      goal: typeof run.goal === "string" ? run.goal : ""
    });
  }

  return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function readRunResult(runId) {
  const id = safeRunId(runId);
  const directory = join(projectRoot, "runtime-data", "runs", id);
  for (const name of ["summary.md", "synthesis.json", "review.json", "findings.json", "coverage.json"]) {
    try {
      return {
        runId: id,
        fileName: name,
        content: await readFile(join(directory, name), "utf8")
      };
    } catch {}
  }
  throw new Error("No readable result file found");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#0b0d10",
    title: "Local AI Lab",
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
}

app.whenReady().then(() => {
  registerIpc("settings:get", () => readSettings());
  registerIpc("settings:save", (input) => saveSettings(input));
  registerIpc("repository:select", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  registerIpc("command:run", (input) => runCommand(input));
  registerIpc("command:cancel", async () => {
    if (!activeProcess) return false;
    const command = activeProcess.spawnargs?.join(" ").slice(0, 120) || "active command";
    activeProcess.kill();
    await appendDiagnostic({ type: "command.cancelled", command });
    return true;
  });
  registerIpc("history:list", () => listHistory());
  registerIpc("history:result", (id) => readRunResult(id));
  registerIpc("diagnostics:list", () => readDiagnostics());
  registerIpc("diagnostics:clear", () => clearDiagnostics());
  registerIpc("clipboard:write", (value) => {
    const text = String(value || "");
    if (text.length > MAX_CLIPBOARD_CHARS) throw new Error("Clipboard payload is too large");
    clipboard.writeText(text);
    return true;
  });
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
