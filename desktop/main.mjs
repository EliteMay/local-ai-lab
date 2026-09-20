import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const allowedCommands = new Set(["doctor","inspect","coverage","coverage-synthesize","test"]);
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
function settingsPath(){ return join(app.getPath("userData"),"settings.json"); }
async function readSettings(){
  const defaults={defaultRepository:projectRoot,modelProfile:"default",rememberRepository:true};
  try { return {...defaults,...JSON.parse(await readFile(settingsPath(),"utf8"))}; } catch { return defaults; }
}
async function saveSettings(input){
  const next={
    defaultRepository:String(input?.defaultRepository||projectRoot),
    modelProfile:safeProfile(input?.modelProfile),
    rememberRepository:input?.rememberRepository!==false
  };
  await mkdir(dirname(settingsPath()),{recursive:true});
  await writeFile(settingsPath(),JSON.stringify(next,null,2)+"\n","utf8");
  return next;
}
function validateRepository(repoPath){
  const target=resolve(String(repoPath||""));
  if(!target||!existsSync(target)) throw new Error("Repository path does not exist");
  return target;
}
function buildCommand(input){
  const command=input.command;
  if(!allowedCommands.has(command)) throw new Error("Command is not allowed");
  const profile=safeProfile(input.modelProfile);
  const profileArgs=profile==="default"?[]:["--model-profile",profile];
  if(command==="test") return {file:process.platform==="win32"?"npm.cmd":"npm",args:["test"]};
  const args=["src/index.mjs",command,...profileArgs];
  if(command==="inspect") args.push("--repo",validateRepository(input.repoPath));
  if(command==="coverage"){
    if(!String(input.goal||"").trim()) throw new Error("Coverage goal is required");
    args.push("--repo",validateRepository(input.repoPath),"--goal",String(input.goal).trim());
    if(input.runId) args.push("--run-id",safeRunId(input.runId));
    if(input.resume) args.push("--resume");
  }
  if(command==="coverage-synthesize") args.push("--run-id",safeRunId(input.runId));
  return {file:"node",args};
}
function parseProgress(line){
  const plan=line.match(/Files=(\d+).*chunks=(\d+).*batches=(\d+)/);
  if(plan) return {type:"plan",files:Number(plan[1]),chunks:Number(plan[2]),batches:Number(plan[3])};
  const done=line.match(/DONE\s+(batch-[\w.-]+)/);
  if(done) return {type:"batch-done",batchId:done[1]};
  const coverage=line.match(/coverage=(\d+(?:\.\d+)?)%/i);
  if(coverage) return {type:"coverage",percent:Number(coverage[1])};
  const run=line.match(/(?:Coverage\] Run|Coverage run:)\s+(run-[\w.-]+)/);
  if(run) return {type:"run-id",runId:run[1]};
  return null;
}
async function runCommand(input){
  if(activeProcess) throw new Error("Another command is already running");
  const spec=buildCommand(input);
  return new Promise((resolvePromise,rejectPromise)=>{
    let output="";
    const child=spawn(spec.file,spec.args,{cwd:projectRoot,windowsHide:true,shell:false,env:{...process.env,FORCE_COLOR:"0"}});
    activeProcess=child;
    const emit=(channel,chunk)=>{
      const text=chunk.toString(); output+=text;
      for(const line of text.split(/\r?\n/).filter(Boolean)) mainWindow?.webContents.send("command:log",{channel,line,progress:parseProgress(line)});
    };
    child.stdout.on("data",c=>emit("stdout",c));
    child.stderr.on("data",c=>emit("stderr",c));
    child.on("error",e=>{activeProcess=null;rejectPromise(e);});
    child.on("close",code=>{
      activeProcess=null;
      const result={ok:code===0,code,output:output.trim()};
      if(code===0) resolvePromise(result); else rejectPromise(new Error(result.output||("Command failed with code "+code)));
    });
  });
}
async function listHistory(){
  const root=join(projectRoot,"runtime-data","runs");
  if(!existsSync(root)) return [];
  const names=await readdir(root); const items=[];
  for(const name of names){
    if(!/^run-[a-zA-Z0-9._-]+$/.test(name)) continue;
    const directory=join(root,name); const info=await stat(directory);
    let run={},coverage={},findings=[];
    try{run=JSON.parse(await readFile(join(directory,"run.json"),"utf8"));}catch{}
    try{coverage=JSON.parse(await readFile(join(directory,"coverage.json"),"utf8"));}catch{}
    try{findings=JSON.parse(await readFile(join(directory,"findings.json"),"utf8"));}catch{}
    items.push({runId:name,createdAt:run.createdAt||info.mtime.toISOString(),status:run.status||coverage.status||(coverage.complete?"COMPLETED":"UNKNOWN"),coveragePercent:coverage.coveragePercent??null,findingCount:Array.isArray(findings)?findings.length:(findings.findings?.length??0)});
  }
  return items.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}
async function readRunResult(runId){
  const id=safeRunId(runId); const directory=join(projectRoot,"runtime-data","runs",id);
  for(const name of ["summary.md","synthesis.json","review.json","findings.json","coverage.json"]){
    try{return {runId:id,fileName:name,content:await readFile(join(directory,name),"utf8")};}catch{}
  }
  throw new Error("No readable result file found");
}
function createWindow(){
  mainWindow=new BrowserWindow({
    width:1320,height:840,minWidth:980,minHeight:680,backgroundColor:"#0b0d10",title:"Local AI Lab",
    webPreferences:{preload:join(__dirname,"preload.cjs"),contextIsolation:true,nodeIntegration:false,sandbox:true}
  });
  mainWindow.loadFile(join(__dirname,"renderer","index.html"));
  mainWindow.webContents.setWindowOpenHandler(()=>({action:"deny"}));
}
app.whenReady().then(()=>{
  ipcMain.handle("settings:get",()=>readSettings());
  ipcMain.handle("settings:save",(_e,input)=>saveSettings(input));
  ipcMain.handle("repository:select",async()=>{const r=await dialog.showOpenDialog(mainWindow,{properties:["openDirectory"]});return r.canceled?null:r.filePaths[0];});
  ipcMain.handle("command:run",(_e,input)=>runCommand(input));
  ipcMain.handle("command:cancel",()=>{if(!activeProcess)return false;activeProcess.kill();return true;});
  ipcMain.handle("history:list",()=>listHistory());
  ipcMain.handle("history:result",(_e,id)=>readRunResult(id));
  ipcMain.handle("clipboard:write",(_e,text)=>{clipboard.writeText(String(text||""));return true;});
  createWindow();
});
app.on("window-all-closed",()=>{if(process.platform!=="darwin")app.quit();});
