import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { diagnoseRuns, checkEvidenceLocations } from '../scripts/audit-diagnostics.mjs';

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'lab-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(root, id, { corruptRun = false } = {}) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  const run = { runId: id, status: 'PARTIAL', mode: 'full-coverage-audit', createdAt: '2026-09-20T09:00:00Z', synthesisError: 'Planner OUTPUT_TOKEN_LIMIT details secret-canary' };
  await writeFile(join(dir, 'run.json'), corruptRun ? '{broken' : JSON.stringify(run));
  if (corruptRun) await writeFile(join(dir, 'run.json.backup'), JSON.stringify(run));
  await writeFile(join(dir, 'coverage.json'), JSON.stringify({ totalChunks: 10, completedChunks: 10, failedBatches: 0, reusedBatches: 2 }));
  await writeFile(join(dir, 'coverage-plan.json'), JSON.stringify({ batches: [ { id: 'batch-0001', chunks: [{path:'src/main.js',startLine:1,endLine:12}] }, { id: 'batch-0002', chunks: [{path:'src/other.js',startLine:1,endLine:4}] } ] }));
  await writeFile(join(dir, 'batch-results.json'), JSON.stringify([
    {batchId:'batch-0001',status:'completed',durationMs:1234,findings: []},
    {batchId:'batch-0002',status:'failed',durationMs:2500,error:'OUTPUT_TOKEN_LIMIT: sensitive details'}
  ]));
  await writeFile(join(dir, 'findings.json'), JSON.stringify([
    {batchId:'batch-0001',title:'not for output secret-canary',evidence:[{file:'src/main.js',lineStart:2,lineEnd:3,claim:'secret-canary'}]},
    {batchId:'batch-0001',evidence:[{file:'src/other.js',lineStart:1,lineEnd:3,claim:'secret-canary'}]},
    {batchId:'batch-0001',evidence:[{file:'src/missing.js',lineStart:1,lineEnd:2,claim:'secret-canary'}]},
    {batchId:'batch-0001',evidence:[{file:'src/main.js',lineStart:-1,lineEnd:2,claim:'secret-canary'}]}
  ]));
  await writeFile(join(dir, 'model-usage.json'), JSON.stringify({models:[{modelId:'qwen3-8b',calls:2,failures:1,promptTokens:100,completionTokens:50,durationMs:4200}]}));
  return dir;
}

test('diagnoses old run without reading code or exposing raw errors', async t => {
  const root = await sandbox(t);
  const dir = await fixture(root, 'run-2026-09-20');
  const before = await readFile(join(dir,'run.json'),'utf8');
  const report = await diagnoseRuns({runsRoot:root,limit:5});
  assert.equal(report.checkedRuns,1);
  const r=report.runRecords[0];
  assert.equal(r.status,'PARTIAL');
  assert.equal(r.coverage.percent,100);
  assert.equal(r.failureCategories.output_limit,1);
  assert.equal(r.synthesisErrorCategory,'output_limit');
  assert.deepEqual(r.models.map(x=>x.modelId),['qwen3-8b']);
  assert.equal(r.evidenceLocations.inPlanRange,2);
  assert.equal(r.evidenceLocations.outsidePlanRange,1);
  assert.equal(r.evidenceLocations.outsideReportedBatch,1);
  assert.equal(r.evidenceLocations.missingOrInvalidLocation,1);
  assert.ok(r.warnings.includes('coverage_complete_but_run_incomplete'));
  assert.ok(!JSON.stringify(report).includes('secret-canary'));
  assert.equal(await readFile(join(dir,'run.json'),'utf8'),before);
});

test('reads backup without rewriting a corrupt primary record',async t=>{
  const root=await sandbox(t);
  const dir=await fixture(root,'run-backup',{corruptRun:true});
  const report=await diagnoseRuns({runsRoot:root});
  assert.equal(report.runRecords[0].status,'PARTIAL');
  assert.equal(await readFile(join(dir,'run.json'),'utf8'),'{broken');
});

test('rejects absent and invalid evidence line data but does not claim semantic correctness',()=>{
  const result=checkEvidenceLocations([{evidence:[{file:'a.js',lineStart:2,lineEnd:2}]}],null);
  assert.equal(result.uncheckableWithoutPlan,1);
  assert.equal(result.inPlanRange,0);
});

test('ignores symlink run directories and unrelated names',async t=>{
  const root=await sandbox(t);
  const elsewhere=await sandbox(t);
  await fixture(elsewhere,'run-external');
  await mkdir(join(root,'other-folder'));
  try {await symlink(resolve(elsewhere,'run-external'),join(root,'run-link'),'dir');}catch(e){ if (process.platform==='win32' && ['EPERM','EACCES'].includes(e.code)) return; throw e; }
  const report=await diagnoseRuns({runsRoot:root});
  assert.equal(report.checkedRuns,0);
});

test('CLI --json returns a safe machine-readable summary with no source text',async t=>{
  const root=await sandbox(t);
  await fixture(root,'run-cli');
  const output=execFileSync(process.execPath,[resolve('scripts/audit-diagnostics.mjs'),'--runs-root',root,'--json'],{cwd:resolve(),encoding:'utf8'});
  const report=JSON.parse(output);
  assert.equal(report.checkedRuns,1);
  assert.ok(!output.includes('secret-canary'));
  assert.ok(!output.includes(root));
});

test('nonexistent run store produces an explicit no-history status',async t=>{
  const root=await sandbox(t);
  const r=await diagnoseRuns({runsRoot:join(root,'missing')});
  assert.equal(r.notice,'runs_directory_not_found');
  assert.equal(r.checkedRuns,0);
});
