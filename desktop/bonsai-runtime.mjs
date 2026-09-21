import http from "node:http";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const BONSAI_HOST = "127.0.0.1";
const BONSAI_PORT = 8080;
const BONSAI_MODELS_PATH = "/v1/models";
const START_TIMEOUT_MS = 120000;
const PROBE_TIMEOUT_MS = 1800;
const LOG_LIMIT = 80;

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function pushBounded(list, value) {
  list.push(value);
  if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
}

export function buildBonsaiStartSpec(demoPath) {
  const root = resolve(String(demoPath || "").trim());
  return {
    cwd: root,
    file: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "start_llama_server.ps1"),
      "--alias",
      "bonsai-2-27b",
      "--parallel",
      "1",
      "--reasoning-budget",
      "1024"
    ],
    env: {
      BONSAI_CTX: "16384",
      BONSAI_MMPROJ_CPU: "1",
      BONSAI_SPECULATIVE: "0",
      BONSAI_KV4: "0"
    }
  };
}

export function validateBonsaiDemoPath(demoPath) {
  const root = resolve(String(demoPath || "").trim());
  if (!demoPath || !String(demoPath).trim()) {
    throw new Error("Bonsaiのフォルダを設定してください。");
  }
  if (!existsSync(root)) {
    throw new Error("設定したBonsaiのフォルダが見つかりません。");
  }
  const script = join(root, "scripts", "start_llama_server.ps1");
  if (!existsSync(script)) {
    throw new Error("Bonsaiの起動スクリプトが見つかりません。Bonsai-demoフォルダを選択してください。");
  }
  return root;
}

export function probeBonsaiServer(timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    const request = http.get({
      host: BONSAI_HOST,
      port: BONSAI_PORT,
      path: BONSAI_MODELS_PATH,
      timeout: timeoutMs
    }, (response) => {
      response.resume();
      finish(response.statusCode >= 200 && response.statusCode < 500);
    });

    request.on("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.on("error", () => finish(false));
  });
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

export function createBonsaiRuntimeController({
  registerIpc,
  readSettings,
  appendDiagnostic,
  getMainWindow
}) {
  let child = null;
  let logs = [];
  let state = {
    status: "stopped",
    managed: false,
    pid: null,
    message: "停止中",
    lastError: ""
  };

  function publish(next = {}) {
    state = { ...state, ...next };
    const payload = { ...state };
    try {
      getMainWindow()?.webContents.send("runtime:bonsai-status", payload);
    } catch {}
    return payload;
  }

  async function refreshStatus() {
    const reachable = await probeBonsaiServer();
    const managedRunning = Boolean(child && child.exitCode == null);

    if (reachable) {
      return publish({
        status: managedRunning ? "running" : "external-running",
        managed: managedRunning,
        pid: managedRunning ? child.pid : null,
        message: managedRunning ? "アプリから起動中" : "外部で起動中",
        lastError: ""
      });
    }

    if (managedRunning) {
      return publish({
        status: "starting",
        managed: true,
        pid: child.pid,
        message: "起動処理中"
      });
    }

    child = null;
    return publish({
      status: "stopped",
      managed: false,
      pid: null,
      message: "停止中"
    });
  }

  async function start() {
    if (process.platform !== "win32") {
      throw new Error("Bonsaiのアプリ内起動はWindows版で利用できます。");
    }

    const current = await refreshStatus();
    if (current.status === "running" || current.status === "external-running") {
      return current;
    }

    const settings = await readSettings();
    const root = validateBonsaiDemoPath(settings.bonsaiDemoPath);
    const spec = buildBonsaiStartSpec(root);

    logs = [];
    await appendDiagnostic({ type: "bonsai.start.requested" });
    publish({
      status: "starting",
      managed: true,
      pid: null,
      message: "Bonsaiを起動しています...",
      lastError: ""
    });

    child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        ...spec.env
      }
    });

    publish({
      status: "starting",
      managed: true,
      pid: child.pid,
      message: "Bonsaiを起動しています..."
    });

    const capture = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        pushBounded(logs, line);
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    child.on("error", (error) => {
      void appendDiagnostic({
        type: "bonsai.process.error",
        error: String(error?.message || error).slice(0, 500)
      });
      publish({
        status: "error",
        managed: false,
        pid: null,
        message: "Bonsaiの起動に失敗しました。",
        lastError: String(error?.message || error)
      });
      child = null;
    });

    child.on("close", (code) => {
      void appendDiagnostic({ type: "bonsai.process.closed", code });
      const wasRunning = state.status === "running";
      child = null;
      if (state.status !== "stopping") {
        publish({
          status: "stopped",
          managed: false,
          pid: null,
          message: wasRunning ? "Bonsaiが停止しました。" : "Bonsaiの起動処理が終了しました。"
        });
      }
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!child || child.exitCode != null) {
        const detail = logs.slice(-12).join("\n");
        throw new Error(detail
          ? `Bonsaiを起動できませんでした。\n${detail}`
          : "Bonsaiを起動できませんでした。");
      }
      if (await probeBonsaiServer()) {
        await appendDiagnostic({ type: "bonsai.started", pid: child.pid });
        return publish({
          status: "running",
          managed: true,
          pid: child.pid,
          message: "起動中",
          lastError: ""
        });
      }
      await delay(1000);
    }

    const detail = logs.slice(-12).join("\n");
    killProcessTree(child?.pid);
    child = null;
    publish({
      status: "error",
      managed: false,
      pid: null,
      message: "Bonsaiの起動がタイムアウトしました。",
      lastError: detail
    });
    throw new Error("Bonsaiの起動確認が2分以内に完了しませんでした。");
  }

  async function stop() {
    const current = await refreshStatus();
    if (current.status === "external-running") {
      throw new Error("Bonsaiはアプリ外で起動されています。アプリから起動したBonsaiだけ停止できます。");
    }
    if (!child || child.exitCode != null) {
      return publish({
        status: "stopped",
        managed: false,
        pid: null,
        message: "すでに停止しています。"
      });
    }

    const pid = child.pid;
    publish({
      status: "stopping",
      managed: true,
      pid,
      message: "Bonsaiを停止しています..."
    });
    killProcessTree(pid);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!(await probeBonsaiServer(800))) break;
      await delay(500);
    }

    child = null;
    await appendDiagnostic({ type: "bonsai.stopped", pid });
    return publish({
      status: "stopped",
      managed: false,
      pid: null,
      message: "停止しました。",
      lastError: ""
    });
  }

  registerIpc("runtime:bonsai-status", () => refreshStatus());
  registerIpc("runtime:bonsai-start", () => start());
  registerIpc("runtime:bonsai-stop", () => stop());

  return {
    refreshStatus,
    start,
    stop
  };
}
