#!/usr/bin/env node
// Read-only diagnostic. Outputs aggregate counters only, never source content or raw errors.
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const validId = /^run-[\w.-]+$/;
const categories = ['output_limit','context_limit','timeout','structured_output','model_unavailable','other'];
const count = n => Number.isFinite(n) && n >= 0 ? n : 0;
const category = error => {
  const s = String(error ?? '');
  if (/OUTPUT_TOKEN_LIMIT|max output tokens|max_tokens|output cap/i.test(s)) return 'output_limit';
  if (/CONTEXT_LIMIT|context limit|context window|context length/i.test(s)) return 'context_limit';
  if (/timed?\s*out|timeout|AbortError|fetch failed/i.test(s)) return 'timeout';
  if (/JSON|SCHEMA|valid response|inspectedChunks|parse|validation/i.test(s)) return 'structured_output';
  if (/MODEL_NOT_|NO_ROUTED_MODEL|MODEL_ROUTING_FAILED|MODEL.*UNAVAILABLE|ECONNREFUSED/i.test(s)) return 'model_unavailable';
  return 'other';
};
async function load(dir, name) {
  for (const file of [join(dir,name), join(dir,name+'.backup')]) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32*1024*1024) continue;
      return JSON.parse(await readFile(file,'utf8'));
    } catch { /* Old or broken snapshots do not block reading other runs. */ }
  }
  return null;
}
export function checkEvidenceLocations(findings, plan) {
  const result = { findings: Array.isArray(findings) ? findings.length : 0, evidenceItems:0,
    inPlanRange:0, outsidePlanRange:0, outsideReportedBatch:0, missingOrInvalidLocation:0, uncheckableWithoutPlan:0 };
  const batches = Array.isArray(plan?.batches) ? plan.batches : null;
  const ranges = batches?.flatMap(b => (b.chunks ?? []).map(c => ({...c,batchId:b.id}))) ?? [];
  for (const f of Array.isArray(findings) ? findings : []) for (const ev of Array.isArray(f?.evidence) ? f.evidence : []) {
    result.evidenceItems++;
    if (typeof ev?.file !== 'string' || !Number.isSafeInteger(ev.lineStart) || !Number.isSafeInteger(ev.lineEnd) || ev.lineStart < 1 || ev.lineEnd < ev.lineStart) {
      result.missingOrInvalidLocation++; continue;
    }
    if (!batches) { result.uncheckableWithoutPlan++; continue; }
    const matching = ranges.filter(r => r.path === ev.file && ev.lineStart >= r.startLine && ev.lineEnd <= r.endLine);
    if (!matching.length) { result.outsidePlanRange++; continue; }
    result.inPlanRange++;
    if (typeof f?.batchId === 'string' && batches.some(b => b.id === f.batchId) && !matching.some(r => r.batchId === f.batchId)) result.outsideReportedBatch++;
  }
  return result;
}
export async function analyzeRunDirectory(root,id) {
  if (!validId.test(id)) throw new Error('Invalid run ID');
  const dir = join(root,id);
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  const [run,coverageFile,batchesFile,findingsFile,plan,usageFile,synthesis] = await Promise.all(
    ['run.json','coverage.json','batch-results.json','findings.json','coverage-plan.json','model-usage.json','synthesis.json'].map(n=>load(dir,n)));
  const coverage = coverageFile ?? run?.coverage ?? {};
  const batches = Array.isArray(batchesFile) ? batchesFile : [];
  const findings = Array.isArray(findingsFile) ? findingsFile : batches.flatMap(b=>Array.isArray(b.findings)?b.findings:[]);
  const failureCounts = new Map(categories.map(c=>[c,0]));
  for (const b of batches) if (b.status === 'failed') {
    const code = category(b.error);
    failureCounts.set(code, failureCounts.get(code) + 1);
  }
  const failures = Object.fromEntries(failureCounts);
  const models = Array.isArray((usageFile ?? run?.modelRouting)?.models) ? (usageFile ?? run?.modelRouting).models.map(m=>({
    modelId: typeof m.modelId === 'string' && /^[\w./-]{1,90}$/.test(m.modelId) ? m.modelId : 'unknown',
    calls:count(m.calls),failures:count(m.failures),promptTokens:count(m.promptTokens),
    completionTokens:count(m.completionTokens),durationSeconds:+(count(m.durationMs)/1000).toFixed(1)
  })) : [];
  const completed = count(coverage.completedChunks), total = count(coverage.totalChunks);
  const evidenceLocations = checkEvidenceLocations(findings,plan);
  const result = {
    runId:id, hasRunRecord:!!run,
    status:['RUNNING','INTERRUPTED','COMPLETED','PARTIAL','FAILED'].includes(run?.status)?run.status:'UNKNOWN',
    coverage:{completedChunks:completed,totalChunks:total,percent:total?+(100*completed/total).toFixed(2):null,
      failedBatches:count(coverage.failedBatches),reusedBatches:count(coverage.reusedBatches)},
    batchRecords:batches.length,failureCategories:failures,
    synthesisErrorCategory:run?.synthesisError||synthesis?.error?category(run?.synthesisError??synthesis.error):null,
    slowestBatches:batches.filter(b=>Number.isFinite(b.durationMs)&&b.durationMs>=0).map(b=>({
      batchId:typeof b.batchId==='string'&&/^batch-[\w.-]{1,48}$/.test(b.batchId)?b.batchId:'unknown',
      durationSeconds:+(b.durationMs/1000).toFixed(1)
    })).sort((a,b)=>b.durationSeconds-a.durationSeconds).slice(0,3),
    evidenceLocations,models,
    reviewerDecision:['APPROVE','REJECT','NEED_MORE_EVIDENCE'].includes(run?.reviewerDecision)?run.reviewerDecision:null,
    warnings:[]
  };
  if (!run) result.warnings.push('run_record_missing_or_unreadable');
  if (!plan) result.warnings.push('coverage_plan_missing_or_unreadable');
  if (!coverageFile && !run?.coverage) result.warnings.push('coverage_record_missing_or_unreadable');
  if (!batchesFile) result.warnings.push('batch_records_missing_or_unreadable');
  if (!findingsFile) result.warnings.push('findings_fallback_or_missing');
  if (result.coverage.percent===100 && result.status!=='COMPLETED') result.warnings.push('coverage_complete_but_run_incomplete');
  if (evidenceLocations.outsidePlanRange||evidenceLocations.outsideReportedBatch||evidenceLocations.missingOrInvalidLocation) result.warnings.push('evidence_location_mismatch');
  return result;
}
export async function diagnoseRuns({runsRoot='runtime-data/runs',limit=5}={}) {
  let dirs;
  try { dirs=await readdir(resolve(runsRoot),{withFileTypes:true}); }
  catch(e) { if(e.code==='ENOENT')return{schemaVersion:1,checkedRuns:0,runRecords:[],notice:'runs_directory_not_found'};
    throw new Error('Cannot read run records directory'); }
  const ids=dirs.filter(d=>d.isDirectory()&&validId.test(d.name)).map(d=>d.name).sort().reverse().slice(0,Math.min(50,limit));
  const records=[];
  for(const id of ids){try {const r=await analyzeRunDirectory(resolve(runsRoot),id);if(r)records.push(r);}
    catch{records.push({runId:id,status:'UNREADABLE',warnings:['run_directory_unreadable']});}}
  return {schemaVersion:1,checkedRuns:records.length,runRecords:records,notice:records.length?null:'no_run_records'};
}
function args(argv){
  const result={runsRoot:'runtime-data/runs',limit:5,json:false};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--runs-root'&&argv[i+1])result.runsRoot=argv[++i];
    else if(argv[i]==='--limit'&&argv[i+1]){result.limit=Number(argv[++i]);if(!Number.isSafeInteger(result.limit)||result.limit<1||result.limit>50)throw Error('Invalid limit');}
    else if(argv[i]==='--json')result.json=true;
    else if(argv[i]==='--help')result.help=true;
    else throw Error('Invalid option');
  }return result;
}
function format(r){
  const lines=['Local AI Lab：既存実行履歴の読み取り専用診断','履歴 '+r.checkedRuns+'件'];
  if(r.notice)lines.push('状態: '+r.notice);
  for(const x of r.runRecords){
    lines.push('',x.runId+' / '+x.status);if(!x.coverage)continue;
    lines.push(' Coverage '+x.coverage.percent+'% ('+x.coverage.completedChunks+'/'+x.coverage.totalChunks+')、失敗Batch '+x.coverage.failedBatches);
    lines.push(' 指摘 '+x.evidenceLocations.findings+'件、根拠の行位置：範囲内 '+x.evidenceLocations.inPlanRange+' / 範囲外 '+x.evidenceLocations.outsidePlanRange+' / Batch外 '+x.evidenceLocations.outsideReportedBatch);
    const e=Object.entries(x.failureCategories).filter(p=>p[1]);if(e.length)lines.push(' 失敗分類 '+e.map(p=>p.join('=')).join(', '));
    if(x.synthesisErrorCategory)lines.push(' 最終統合エラー '+x.synthesisErrorCategory);
    if(x.models.length)lines.push(' Model '+x.models.map(m=>m.modelId+': '+m.calls+' calls / '+m.failures+' failures / '+m.completionTokens+' output tokens / '+m.durationSeconds+'s').join(', '));
    if(x.warnings.length)lines.push(' 注意 '+x.warnings.join(', '));
  }lines.push('','注意：根拠行番号の整合性は、指摘内容の正しさを証明しません。');return lines.join('\n');
}
async function main(){
  const options=args(process.argv.slice(2));
  if(options.help){console.log('node scripts/audit-diagnostics.mjs [--runs-root DIR] [--limit 1..50] [--json]');return;}
  const report=await diagnoseRuns(options);console.log(options.json?JSON.stringify(report,null,2):format(report));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(()=>{console.error('履歴の診断に失敗しました（フォルダ権限・形式を確認）。');process.exitCode=1;});
}
