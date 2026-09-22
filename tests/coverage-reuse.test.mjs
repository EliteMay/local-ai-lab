import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReusableBatchIndex,
  coverageBatchFingerprint,
  findReusableCoverageBaseline
} from "../src/core/coverage-reuse.mjs";

function plan(fileSha = "sha-a") {
  return {
    files: [
      { path: "src/a.js", sha256: fileSha, chunks: ["src/a.js#L1-L10-P1"] },
      { path: "src/b.js", sha256: "sha-b", chunks: ["src/b.js#L1-L10-P1"] }
    ],
    batches: [
      {
        id: "batch-0001",
        chunks: [
          { id: "src/a.js#L1-L10-P1", path: "src/a.js" },
          { id: "src/b.js#L1-L10-P1", path: "src/b.js" }
        ]
      }
    ]
  };
}

test("coverage batch fingerprint changes when any source file hash changes", () => {
  const first = coverageBatchFingerprint(plan("sha-a"), plan("sha-a").batches[0]);
  const second = coverageBatchFingerprint(plan("sha-a2"), plan("sha-a2").batches[0]);
  assert.notEqual(first, second);
});

test("reusable batch index only includes completed batches", () => {
  const savedPlan = plan();
  const index = buildReusableBatchIndex(savedPlan, [
    { batchId: "batch-0001", status: "completed", findings: [{ title: "x" }] },
    { batchId: "batch-9999", status: "failed", findings: [] }
  ], "run-old");
  assert.equal(index.size, 1);
  const item = [...index.values()][0];
  assert.equal(item.sourceRunId, "run-old");
  assert.equal(item.result.findings.length, 1);
});

test("latest compatible historical run is selected for reuse", async () => {
  const runs = {
    "run-old": {
      run: {
        runId: "run-old",
        status: "COMPLETED",
        mode: "full-coverage-audit",
        repoPath: "D:/Repo",
        goal: "Audit",
        createdAt: "2026-09-20T00:00:00Z",
        executionIdentity: {
          modelRoutingMode: "fixed",
          configHash: "same",
          promptSchemaVersion: "same",
          model: "m",
          modelProfile: "p",
          providerName: "LM Studio"
        }
      },
      plan: plan(),
      results: [{ batchId: "batch-0001", status: "completed", findings: [] }]
    },
    "run-new": {
      run: {
        runId: "run-new",
        status: "PARTIAL",
        mode: "full-coverage-audit",
        repoPath: "d:/repo/",
        goal: "  Audit  ",
        createdAt: "2026-09-21T00:00:00Z",
        executionIdentity: {
          modelRoutingMode: "fixed",
          configHash: "same",
          promptSchemaVersion: "same",
          model: "m",
          modelProfile: "p",
          providerName: "LM Studio"
        }
      },
      plan: plan(),
      results: [{ batchId: "batch-0001", status: "completed", findings: [] }]
    }
  };

  const runStore = {
    async listRunIds() { return ["run-old", "run-new"]; },
    async readJson(id, file) {
      const item = runs[id];
      if (file === "run.json") return item.run;
      if (file === "coverage-plan.json") return item.plan;
      if (file === "batch-results.json") return item.results;
      throw new Error("unexpected");
    }
  };

  const result = await findReusableCoverageBaseline({
    runStore,
    repoPath: "D:\\Repo",
    goal: "Audit",
    executionIdentity: runs["run-new"].run.executionIdentity
  });

  assert.equal(result.runId, "run-new");
  assert.equal(result.reusable.size, 1);
});


test("coverage reuse treats audit goal casing as meaningful", async () => {
  const identity = {
    modelRoutingMode: "fixed",
    configHash: "same",
    promptSchemaVersion: "same",
    model: "m",
    modelProfile: "p",
    providerName: "LM Studio"
  };
  const runStore = {
    async listRunIds() { return ["run-case"]; },
    async readJson(id, file) {
      if (file === "run.json") return {
        runId: id,
        status: "COMPLETED",
        mode: "full-coverage-audit",
        repoPath: "D:/Repo",
        goal: "Audit MyClass",
        createdAt: "2026-09-21T00:00:00Z",
        executionIdentity: identity
      };
      if (file === "coverage-plan.json") return plan();
      if (file === "batch-results.json") return [{ batchId: "batch-0001", status: "completed", findings: [] }];
      throw new Error("unexpected");
    }
  };

  const result = await findReusableCoverageBaseline({
    runStore,
    repoPath: "D:/Repo",
    goal: "audit myclass",
    executionIdentity: identity
  });
  assert.equal(result, null);
});
