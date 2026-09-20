import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns, readRunResult } from "../src/desktop/history-service.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-ai-history-"));
  const runId = "run-2026-09-20T10-00-00-000Z";
  const dir = join(root, "runtime-data", "runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), JSON.stringify({
    runId,
    status: "COMPLETED",
    mode: "full-coverage-audit",
    completedAt: "2026-09-20T10:30:00.000Z",
    goal: "audit",
    repoPath: "C:\\repo",
    reviewerDecision: "APPROVE",
    coverage: { coveragePercent: 100, completedChunks: 10, totalChunks: 10 },
  }));
  await writeFile(join(dir, "findings.json"), JSON.stringify([{ id: "f1" }]));
  await writeFile(join(dir, "summary.md"), "# Summary\n\nDone.\n");
  await writeFile(join(dir, "synthesis.json"), JSON.stringify({ planner: { result: { status: "ok" } } }));
  await writeFile(join(dir, "review.json"), JSON.stringify({ result: { decision: "APPROVE" } }));
  return { root, runId };
}

test("history lists saved coverage runs and produces copyable result text", async () => {
  const { root, runId } = await fixture();
  try {
    const runs = await listRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].coveragePercent, 100);
    assert.equal(runs[0].findings, 1);
    const result = await readRunResult(root, runId);
    assert.match(result.text, /Summary/);
    assert.match(result.text, /Improvement Planner/);
    assert.match(result.text, /Reviewer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history rejects traversal run ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-history-"));
  try {
    await assert.rejects(() => readRunResult(root, "../secrets"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
