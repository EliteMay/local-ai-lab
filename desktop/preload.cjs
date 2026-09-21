const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localAI", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (input) => ipcRenderer.invoke("settings:save", input),
  selectRepository: () => ipcRenderer.invoke("repository:select"),
  runCommand: (input) => ipcRenderer.invoke("command:run", input),
  cancelCommand: () => ipcRenderer.invoke("command:cancel"),
  listHistory: () => ipcRenderer.invoke("history:list"),
  readRunResult: (id) => ipcRenderer.invoke("history:result", id),
  listDiagnostics: () => ipcRenderer.invoke("diagnostics:list"),
  clearDiagnostics: () => ipcRenderer.invoke("diagnostics:clear"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  onLog: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("command:log", handler);
    return () => ipcRenderer.removeListener("command:log", handler);
  }
});
