import { app, BrowserWindow, dialog, shell } from "electron";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater");

const RELEASE_URL = "https://github.com/EliteMay/local-ai-lab/releases/latest";
const AUTO_CHECK_DELAY_MS = 2500;

function parseVersion(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return true;
    if ((a[index] || 0) < (b[index] || 0)) return false;
  }
  return false;
}

export function createUpdaterController({
  registerIpc,
  readSettings,
  appendDiagnostic,
  getMainWindow,
  isBusy
}) {
  let checkPromise = null;
  let installInProgress = false;
  let downloadedInstallerPath = "";
  let quitObserved = false;
  let promptedVersion = "";
  let configured = false;
  let updateState = {
    state: "idle",
    currentVersion: app.getVersion(),
    latestVersion: "",
    progress: 0,
    message: app.isPackaged
      ? "更新を確認できます。"
      : "開発モードでは自動更新を実行しません。"
  };

  function setWindowProgress(value) {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.setProgressBar(value); } catch {}
    }
  }

  async function setState(next) {
    updateState = { ...updateState, ...next, currentVersion: app.getVersion() };
    await appendDiagnostic({
      type: "update.state",
      state: updateState.state,
      latestVersion: updateState.latestVersion || undefined
    });
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send("update:status", updateState); } catch {}
    }
    return updateState;
  }

  async function showFailure(error) {
    const message = error?.message || String(error || "不明なエラー");
    await setState({ state: "error", progress: 0, message: `更新に失敗: ${message}` });
    const win = getMainWindow();
    const result = await dialog.showMessageBox(win || undefined, {
      type: "error",
      title: "アップデートに失敗しました",
      message: "自動アップデートを完了できませんでした。",
      detail: `${message}\n\n現在のバージョンはそのまま利用できます。必要なら配布ページから手動で更新してください。`,
      buttons: ["配布ページを開く", "閉じる"],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (result.response === 0) await shell.openExternal(RELEASE_URL);
  }

  async function promptForUpdate(version) {
    if (!version || promptedVersion === version || installInProgress) return;
    promptedVersion = version;
    const win = getMainWindow();
    const detail = isBusy()
      ? "現在処理を実行中です。更新は処理完了後に行ってください。"
      : "「ダウンロード」を押すと更新ファイルを取得します。完了後に「再起動して更新」を押すと更新します。設定と実行履歴はアプリの保存領域に残ります。";

    const result = await dialog.showMessageBox(win || undefined, {
      type: "info",
      title: "Local AI Lab アップデート",
      message: `新しいバージョン v${version} があります。`,
      detail,
      buttons: isBusy() ? ["あとで"] : ["ダウンロード", "あとで"],
      defaultId: 0,
      cancelId: isBusy() ? 0 : 1,
      noLink: true
    });

    if (!isBusy() && result.response === 0) {
      await downloadUpdate();
    }
  }

  async function checkForUpdate({ prompt = false } = {}) {
    if (!app.isPackaged) {
      const state = await setState({
        state: "development",
        latestVersion: app.getVersion(),
        progress: 0,
        message: "開発モードでは自動更新を実行しません。インストール版で確認してください。"
      });
      return { ok: true, skipped: true, updateAvailable: false, ...state };
    }

    if (checkPromise) return checkPromise;

    checkPromise = (async () => {
      try {
        await setState({ state: "checking", progress: 0, message: "アップデートを確認しています。" });
        const result = await autoUpdater.checkForUpdates();
        const latestVersion = result?.updateInfo?.version || app.getVersion();
        const updateAvailable = isNewerVersion(latestVersion, app.getVersion());

        if (updateAvailable) {
          await setState({
            state: "available",
            latestVersion,
            progress: 0,
            message: `v${latestVersion} が利用できます。`
          });
          if (prompt) await promptForUpdate(latestVersion);
        } else {
          await setState({
            state: "current",
            latestVersion: app.getVersion(),
            progress: 0,
            message: "最新版です。"
          });
        }

        return {
          ok: true,
          updateAvailable,
          latestVersion,
          currentVersion: app.getVersion(),
          message: updateAvailable ? `v${latestVersion} が利用できます。` : "最新版です。"
        };
      } catch (error) {
        const message = error?.message || String(error);
        await setState({ state: "error", progress: 0, message: `更新確認に失敗: ${message}` });
        return {
          ok: false,
          updateAvailable: false,
          currentVersion: app.getVersion(),
          latestVersion: "",
          message
        };
      } finally {
        checkPromise = null;
      }
    })();

    return checkPromise;
  }

  async function downloadUpdate() {
    if (!app.isPackaged) {
      return { ok: false, message: "開発モードでは自動更新できません。" };
    }
    if (isBusy()) {
      return { ok: false, message: "処理実行中はアプリを更新できません。処理完了後に再実行してください。" };
    }
    if (installInProgress) {
      return { ok: true, message: updateState.state === "installing" ? "再起動処理中です。" : "アップデートをダウンロード中です。" };
    }

    let latestVersion = updateState.latestVersion;
    if (!latestVersion || !isNewerVersion(latestVersion, app.getVersion())) {
      const checked = await checkForUpdate({ prompt: false });
      if (!checked.ok || !checked.updateAvailable) {
        return { ok: checked.ok, message: checked.ok ? "最新版です。" : "更新確認に失敗しました。" };
      }
      latestVersion = checked.latestVersion;
    }

    installInProgress = true;
    downloadedInstallerPath = "";
    try {
      await setState({
        state: "downloading",
        latestVersion,
        progress: 0,
        message: `v${latestVersion} をダウンロードしています。`
      });
      const downloadedFiles = await autoUpdater.downloadUpdate();
      downloadedInstallerPath =
        downloadedFiles.find((file) => /\.exe$/i.test(String(file))) ||
        downloadedFiles[0] ||
        "";

      installInProgress = false;
      setWindowProgress(-1);
      await appendDiagnostic({
        type: "update.download.completed",
        latestVersion,
        installerReady: Boolean(downloadedInstallerPath)
      });
      await setState({
        state: "downloaded",
        latestVersion,
        progress: 100,
        message: "ダウンロード完了。「再起動して更新」を押してください。"
      });
      return { ok: true, downloaded: true, message: "ダウンロード完了。再起動して更新できます。" };
    } catch (error) {
      installInProgress = false;
      downloadedInstallerPath = "";
      setWindowProgress(-1);
      await showFailure(error);
      return { ok: false, message: `自動更新に失敗しました: ${error?.message || error}` };
    }
  }

  async function installDownloadedUpdate() {
    if (!app.isPackaged) {
      return { ok: false, message: "開発モードでは自動更新できません。" };
    }
    if (isBusy()) {
      return { ok: false, message: "処理実行中はアプリを更新できません。処理完了後に再実行してください。" };
    }
    if (updateState.state !== "downloaded" || !downloadedInstallerPath) {
      return downloadUpdate();
    }
    if (installInProgress) {
      return { ok: true, message: "再起動処理中です。" };
    }

    installInProgress = true;
    quitObserved = false;
    const latestVersion = updateState.latestVersion;
    await setState({
      state: "installing",
      latestVersion,
      progress: 100,
      message: "アプリを終了して更新を開始します。"
    });
    await appendDiagnostic({ type: "update.install.requested", latestVersion });

    setWindowProgress(-1);
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (error) {
        installInProgress = false;
        void showFailure(error);
      }
    }, 300);

    setTimeout(async () => {
      if (quitObserved || !installInProgress) return;
      await appendDiagnostic({
        type: "update.install.fallback",
        latestVersion,
        reason: "quitAndInstall did not begin application quit"
      });
      const openError = await shell.openPath(downloadedInstallerPath);
      if (openError) {
        installInProgress = false;
        await showFailure(new Error(`更新インストーラーを起動できませんでした: ${openError}`));
        return;
      }
      app.quit();
    }, 5000);

    return { ok: true, message: `v${latestVersion} をインストールするため再起動します。` };
  }

  function configure() {
    if (configured) return;
    configured = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;

    app.on("before-quit", () => {
      quitObserved = true;
    });

    autoUpdater.on("checking-for-update", () => {
      void setState({ state: "checking", progress: 0, message: "アップデートを確認しています。" });
    });
    autoUpdater.on("update-available", (info) => {
      const version = info?.version || "";
      void setState({
        state: "available",
        latestVersion: version,
        progress: 0,
        message: `v${version} が利用できます。`
      });
    });
    autoUpdater.on("update-not-available", () => {
      void setState({
        state: "current",
        latestVersion: app.getVersion(),
        progress: 0,
        message: "最新版です。"
      });
    });
    autoUpdater.on("download-progress", (progress) => {
      const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
      setWindowProgress(percent / 100);
      void setState({
        state: "downloading",
        progress: percent,
        message: `アップデートをダウンロード中: ${percent.toFixed(0)}%`
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      setWindowProgress(1);
      void setState({
        state: "downloaded",
        latestVersion: info?.version || updateState.latestVersion,
        progress: 100,
        message: "アップデートのダウンロードが完了しました。"
      });
    });
    autoUpdater.on("error", (error) => {
      installInProgress = false;
      setWindowProgress(-1);
      void appendDiagnostic({ type: "update.error", error: String(error?.message || error).slice(0, 500) });
      void setState({
        state: "error",
        progress: 0,
        message: `更新エラー: ${error?.message || error}`
      });
    });
  }

  configure();

  registerIpc("update:state", () => updateState);
  registerIpc("update:check", () => checkForUpdate({ prompt: false }));
  registerIpc("update:install", () => (
    updateState.state === "downloaded" ? installDownloadedUpdate() : downloadUpdate()
  ));
  registerIpc("update:open-release", async () => {
    await shell.openExternal(RELEASE_URL);
    return { ok: true, message: "配布ページを開きました。" };
  });

  return {
    async scheduleAutoCheck() {
      const settings = await readSettings();
      if (settings.autoCheckUpdates === false) return;
      setTimeout(async () => {
        const result = await checkForUpdate({ prompt: false });
        if (result.ok && result.updateAvailable) {
          await promptForUpdate(result.latestVersion);
        }
      }, AUTO_CHECK_DELAY_MS);
    },
    getState: () => ({ ...updateState })
  };
}
