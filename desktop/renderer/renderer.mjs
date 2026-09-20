const state={settings:null,repository:"",selectedCommand:"coverage",running:false,result:"",completedBatches:0,totalBatches:0};
const $=(s)=>document.querySelector(s);
const $$=(s)=>[...document.querySelectorAll(s)];

function showView(name){
  $$(".nav").forEach((b)=>b.classList.toggle("active",b.dataset.view===name));
  $$(".view").forEach((v)=>v.classList.toggle("active",v.id===name));
  if(name==="history") loadHistory();
}
function selectCommand(command){
  state.selectedCommand=command;
  $$(".commands button").forEach((b)=>b.classList.toggle("selected",b.dataset.command===command));
  $("#coverageOptions").classList.toggle("hidden",command!=="coverage");
  $("#synthOptions").classList.toggle("hidden",command!=="coverage-synthesize");
}
function setRunning(value,title){
  state.running=value;
  $$(".commands button").forEach((b)=>b.disabled=value);
  $("#cancel").classList.toggle("hidden",!value);
  if(title) $("#runTitle").textContent=title;
}
function appendLog(payload){
  const line=document.createElement("div");
  if(payload.channel==="stderr") line.className="err";
  line.textContent=payload.line;
  $("#log").appendChild(line);
  $("#log").scrollTop=$("#log").scrollHeight;
  const p=payload.progress;
  if(!p) return;
  if(p.type==="plan"){
    state.totalBatches=p.batches;state.completedBatches=0;
    $("#progress").textContent="0 / "+p.batches+" batches · "+p.files+" files · "+p.chunks+" chunks";
  }
  if(p.type==="batch-done"){
    state.completedBatches+=1;
    const percent=state.totalBatches?Math.round((state.completedBatches/state.totalBatches)*100):0;
    $("#bar").style.width=percent+"%";
    $("#progress").textContent=state.totalBatches?(state.completedBatches+" / "+state.totalBatches+" batches"):"実行中";
  }
  if(p.type==="coverage"){
    $("#bar").style.width=Math.max(0,Math.min(100,p.percent))+"%";
    $("#progress").textContent="Coverage "+p.percent+"%";
  }
  if(p.type==="run-id"){
    $("#runLabel").textContent=p.runId;
    $("#runId").value=p.runId;
  }
}
function applyDoctor(text){
  const provider=text.match(/^(.+?) API: OK/m)?.[1]||"接続済み";
  const model=text.match(/^Configured model:\s*(.+)$/m)?.[1]||"不明";
  const loaded=text.match(/^Configured model loaded:\s*(.+)$/m)?.[1]||"不明";
  $("#runtime").textContent=provider;
  $("#model").textContent=model;
  $("#connection").textContent=loaded==="yes"?"接続中":"Model未Load";
  $("#dot").classList.toggle("online",loaded==="yes");
  $("#dot").classList.toggle("offline",loaded!=="yes");
  $("#runtimeMini").textContent=loaded==="yes"?"Runtime 接続中":"Runtime 要確認";
}
async function run(command,stateOverride={}){
  if(state.running) return;
  $("#log").textContent="";
  $("#result").textContent="実行中...";
  $("#copy").disabled=true;
  $("#bar").style.width="0%";
  $("#progress").textContent="開始しています...";
  state.completedBatches=0;state.totalBatches=0;
  const payload={
    command,
    repoPath:state.repository,
    goal:$("#goal").value,
    runId:$("#runId").value.trim(),
    modelProfile:state.settings.modelProfile,
    ...stateOverride
  };
  const labels={doctor:"Doctor",inspect:"Inspect",coverage:"Coverage Audit","coverage-synthesize":"Synthesize",test:"Tests"};
  setRunning(true,labels[command]||command);
  try{
    const result=await window.localAI.runCommand(payload);
    state.result=result.output||"完了しました。";
    $("#result").textContent=state.result;
    $("#copy").disabled=false;
    if(command!=="coverage") $("#bar").style.width="100%";
    $("#progress").textContent="完了";
    if(command==="doctor") applyDoctor(state.result);
    await loadHistory();
  }catch(error){
    state.result=error.message;
    $("#result").textContent=error.message;
    $("#copy").disabled=false;
    $("#progress").textContent="失敗";
  }finally{setRunning(false);}
}
async function chooseRepository(settingsMode){
  const path=await window.localAI.selectRepository();
  if(!path) return;
  if(settingsMode){
    $("#settingsRepo").value=path;
    return;
  }
  state.repository=path;
  $("#repoPath").textContent=path;
  if(state.settings.rememberRepository){
    state.settings.defaultRepository=path;
    await window.localAI.saveSettings(state.settings);
  }
}
function formatDate(value){
  try{return new Intl.DateTimeFormat("ja-JP",{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));}
  catch{return value||"不明";}
}
async function loadHistory(){
  const list=$("#historyList");
  list.innerHTML="<div class='panel'>読み込み中...</div>";
  try{
    const items=await window.localAI.listHistory();
    if(!items.length){list.innerHTML="<div class='panel'>まだ保存済みRunはありません。</div>";return;}
    list.innerHTML="";
    for(const item of items){
      const row=document.createElement("article");row.className="history-item";
      const left=document.createElement("div");
      const title=document.createElement("h3");title.textContent=item.runId;
      const meta=document.createElement("div");meta.className="history-meta";
      for(const text of [formatDate(item.createdAt),item.status,"Coverage "+(item.coveragePercent??"—")+"%","Findings "+item.findingCount]){
        const span=document.createElement("span");span.textContent=text;meta.appendChild(span);
      }
      left.append(title,meta);
      const actions=document.createElement("div");actions.className="actions";
      const open=document.createElement("button");open.className="ghost";open.textContent="結果を見る";
      open.addEventListener("click",async()=>{
        const result=await window.localAI.readRunResult(item.runId);
        state.result=result.content;$("#result").textContent=result.content;$("#copy").disabled=false;$("#runId").value=item.runId;showView("home");
      });
      const copy=document.createElement("button");copy.className="ghost";copy.textContent="コピー";
      copy.addEventListener("click",async()=>{
        const result=await window.localAI.readRunResult(item.runId);
        await window.localAI.copyText(result.content);copy.textContent="コピー済み";setTimeout(()=>copy.textContent="コピー",1200);
      });
      actions.append(open,copy);row.append(left,actions);list.appendChild(row);
    }
  }catch(error){list.innerHTML="<div class='panel'>履歴を読み込めませんでした: "+error.message+"</div>";}
}
async function init(){
  state.settings=await window.localAI.getSettings();
  state.repository=state.settings.defaultRepository;
  $("#repoPath").textContent=state.repository;
  $("#settingsRepo").value=state.repository;
  $("#settingsProfile").value=state.settings.modelProfile;
  $("#profile").textContent=state.settings.modelProfile;
  $("#rememberRepo").checked=state.settings.rememberRepository;
  window.localAI.onLog(appendLog);
  selectCommand("coverage");
  await loadHistory();
}

$$(".nav").forEach((b)=>b.addEventListener("click",()=>showView(b.dataset.view)));
$$(".commands button").forEach((b)=>b.addEventListener("click",()=>{selectCommand(b.dataset.command);run(b.dataset.command);}));
$("#chooseRepo").addEventListener("click",()=>chooseRepository(false));
$("#settingsRepoButton").addEventListener("click",()=>chooseRepository(true));
$("#refresh").addEventListener("click",()=>run("doctor"));
$("#reloadHistory").addEventListener("click",loadHistory);
$("#cancel").addEventListener("click",()=>window.localAI.cancelCommand());
$("#copy").addEventListener("click",async()=>{await window.localAI.copyText(state.result);$("#copy").textContent="コピー済み";setTimeout(()=>$("#copy").textContent="結果をコピー",1200);});
$("#save").addEventListener("click",async()=>{
  const next=await window.localAI.saveSettings({defaultRepository:$("#settingsRepo").value,modelProfile:$("#settingsProfile").value,rememberRepository:$("#rememberRepo").checked});
  state.settings=next;state.repository=next.defaultRepository;$("#repoPath").textContent=state.repository;$("#profile").textContent=next.modelProfile;
  $("#saveMessage").textContent="保存しました";setTimeout(()=>$("#saveMessage").textContent="",1500);
});
init().catch((error)=>{$("#result").textContent="初期化に失敗しました: "+error.message;});
