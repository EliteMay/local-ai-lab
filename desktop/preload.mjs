import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("localAI",{
  getSettings:()=>ipcRenderer.invoke("settings:get"),
  saveSettings:(input)=>ipcRenderer.invoke("settings:save",input),
  selectRepository:()=>ipcRenderer.invoke("repository:select"),
  runCommand:(input)=>ipcRenderer.invoke("command:run",input),
  cancelCommand:()=>ipcRenderer.invoke("command:cancel"),
  listHistory:()=>ipcRenderer.invoke("history:list"),
  readRunResult:(id)=>ipcRenderer.invoke("history:result",id),
  copyText:(text)=>ipcRenderer.invoke("clipboard:write",text),
  onLog:(callback)=>{const h=(_e,p)=>callback(p);ipcRenderer.on("command:log",h);return()=>ipcRenderer.removeListener("command:log",h);}
});
