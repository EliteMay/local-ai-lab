import { app, BrowserWindow, dialog } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activateLocalAiLabRuntime } from "./runtime-host.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererPath = join(__dirname, "renderer", "index.html");
const rendererUrl = pathToFileURL(rendererPath).href;

let mainWindow = null;
let runtimeController = null;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

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

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });

  mainWindow.on("close", (event) => {
    const status = runtimeController?.commandStatus?.();
    if (!status?.running || runtimeController?.shouldAllowWindowClose?.()) return;
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

    if (choice === 1) void runtimeController.cancelActiveCommand({ quitAfter: true });
  });

  return mainWindow;
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("local.elitemay.localailab");

    const win = createWindow();
    runtimeController = await activateLocalAiLabRuntime({
      hostWindow: win,
      webContents: win.webContents,
      trustedUrl: rendererUrl,
      ipcPrefix: "",
      enableUpdater: true
    });
    await win.loadFile(rendererPath);
    await runtimeController.scheduleAutoCheck?.();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
