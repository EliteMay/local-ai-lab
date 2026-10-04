const { contextBridge, ipcRenderer } = require("electron");

const channel = (name) => "local-ai-lab:" + name;

contextBridge.exposeInMainWorld("localAI", {
  getSettings: () => ipcRenderer.invoke(channel("settings:get")),
  saveSettings: (input) => ipcRenderer.invoke(channel("settings:save"), input),
  selectRepository: () => ipcRenderer.invoke(channel("repository:select")),
  updateRepository: (repoPath) => ipcRenderer.invoke(channel("repository:update"), repoPath),
  selectBonsaiFolder: () => ipcRenderer.invoke(channel("runtime:bonsai-select-folder")),
  getBonsaiStatus: () => ipcRenderer.invoke(channel("runtime:bonsai-status")),
  startBonsai: () => ipcRenderer.invoke(channel("runtime:bonsai-start")),
  stopBonsai: () => ipcRenderer.invoke(channel("runtime:bonsai-stop")),
  onBonsaiStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel("runtime:bonsai-status"), handler);
    return () => ipcRenderer.removeListener(channel("runtime:bonsai-status"), handler);
  },
  runCommand: (input) => ipcRenderer.invoke(channel("command:run"), input),
  cancelCommand: () => ipcRenderer.invoke(channel("command:cancel")),
  getCommandStatus: () => ipcRenderer.invoke(channel("command:status")),
  getSystemMetrics: () => ipcRenderer.invoke(channel("system:metrics")),
  listModels: () => ipcRenderer.invoke(channel("models:list")),
  downloadModel: (modelId) => ipcRenderer.invoke(channel("models:download"), modelId),
  loadModel: (modelId) => ipcRenderer.invoke(channel("models:load"), modelId),
  unloadModel: (modelId) => ipcRenderer.invoke(channel("models:unload"), modelId),
  listHistory: () => ipcRenderer.invoke(channel("history:list")),
  readRunResult: (id) => ipcRenderer.invoke(channel("history:result"), id),
  readRunOverview: (id) => ipcRenderer.invoke(channel("history:overview"), id),
  readRunDetails: (id) => ipcRenderer.invoke(channel("history:details"), id),
  compareRuns: (baselineRunId, currentRunId) => ipcRenderer.invoke(channel("history:compare"), { baselineRunId, currentRunId }),
  exportRun: (id) => ipcRenderer.invoke(channel("history:export"), id),
  openRunFolder: (id) => ipcRenderer.invoke(channel("history:open-folder"), id),
  listDiagnostics: () => ipcRenderer.invoke(channel("diagnostics:list")),
  clearDiagnostics: () => ipcRenderer.invoke(channel("diagnostics:clear")),
  copyText: (text) => ipcRenderer.invoke(channel("clipboard:write"), text),
  getUpdateState: () => ipcRenderer.invoke(channel("update:state")),
  checkForUpdate: () => ipcRenderer.invoke(channel("update:check")),
  installUpdate: () => ipcRenderer.invoke(channel("update:install")),
  openReleasePage: () => ipcRenderer.invoke(channel("update:open-release")),
  onUpdateStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel("update:status"), handler);
    return () => ipcRenderer.removeListener(channel("update:status"), handler);
  },
  onLog: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel("command:log"), handler);
    return () => ipcRenderer.removeListener(channel("command:log"), handler);
  }
});
