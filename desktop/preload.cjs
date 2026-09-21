const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localAI", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (input) => ipcRenderer.invoke("settings:save", input),
  selectRepository: () => ipcRenderer.invoke("repository:select"),
  updateRepository: (repoPath) => ipcRenderer.invoke("repository:update", repoPath),
  selectBonsaiFolder: () => ipcRenderer.invoke("runtime:bonsai-select-folder"),
  getBonsaiStatus: () => ipcRenderer.invoke("runtime:bonsai-status"),
  startBonsai: () => ipcRenderer.invoke("runtime:bonsai-start"),
  stopBonsai: () => ipcRenderer.invoke("runtime:bonsai-stop"),
  onBonsaiStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("runtime:bonsai-status", handler);
    return () => ipcRenderer.removeListener("runtime:bonsai-status", handler);
  },
  runCommand: (input) => ipcRenderer.invoke("command:run", input),
  cancelCommand: () => ipcRenderer.invoke("command:cancel"),
  listHistory: () => ipcRenderer.invoke("history:list"),
  readRunResult: (id) => ipcRenderer.invoke("history:result", id),
  listDiagnostics: () => ipcRenderer.invoke("diagnostics:list"),
  clearDiagnostics: () => ipcRenderer.invoke("diagnostics:clear"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  getUpdateState: () => ipcRenderer.invoke("update:state"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  openReleasePage: () => ipcRenderer.invoke("update:open-release"),
  onUpdateStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },
  onLog: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("command:log", handler);
    return () => ipcRenderer.removeListener("command:log", handler);
  }
});
