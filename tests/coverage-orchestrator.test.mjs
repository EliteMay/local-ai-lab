import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoverageAuditOrchestrator } from "../src/core/coverage-orchestrator.mjs";
import { RunStore } from "../src/core/run-store.mjs";

function roleResponse(overrides = {}) {
  return {
    status: "completed",
    summary: "completed",
    findings: [],
    evidence: [],
    uncertainties: [],
    recommendedNextActions: [],
    delegations: [],
    decision: null,
    ...overrides
  };
}

function requiredChunkIds(user) {
  const section = String(user).match(/Required inspectedChunks \(copy these exact IDs\):\n([\s\S]*?)\n\nRules:/);
  if (!section) return [];
  return section[1].split("\n").map((line) => line.trim()).filter(Boolean);
}

class CoverageFakeModel {
  constructor({ failBatchId = null, outputCapBatchIds = [] } = {}) {
    this.failBatchId = failBatchId;
    this.outputCapBatchIds = new Set(outputCapBatchIds);
    this.calls = [];
  }

  async chatJsonDetailed({ system, user, maxTokens }) {
    this.calls.push({ system, user, maxTokens });

    if (system.includes("Coverage Auditor")) {
      const batchId = String(user).match(/Batch: ([^\n]+)/)?.[1]?.trim();
      if (batchId === this.failBatchId) {
        throw new Error(`simulated failure for ${batchId}`);
      }
      if (this.outputCapBatchIds.has(batchId)) {
        const error = new Error(`simulated output cap for ${batchId}`);
        error.code = "OUTPUT_TOKEN_LIMIT";
        error.maxTokens = maxTokens;
        throw error;
      }
      const chunks = requiredChunkIds(user);
      return {
        value: {
          summary: `Audited ${chunks.length} chunks`,
          inspectedChunks: chunks,
          findings: chunks.length ? [{
            severity: "medium",
            title: "Example evidence-backed issue",
            confidence: "high",
            evidence: [{
              file: chunks[0].split("#L")[0],
              lineStart: 1,
              lineEnd: 1,
              claim: "Fixture evidence"
            }]
          }] : [],
          uncertainties: []
        },
        meta: {
          finishReason: "stop",
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          reasoningTokens: 0
        }
      };
    }

    if (system.includes("Improvement Planner")) {
      return {
        value: roleResponse({
          summary: "Created bounded improvements",
          findings: [{ id: "P-001", proposal: "Fixture proposal" }],
          recommendedNextActions: ["Review the proposal"]
        }),
        meta: { finishReason: "stop", usage: { prompt_tokens: 80, completion_tokens: 30 }, reasoningTokens: 0 }
      };
    }

    if (system.includes("Reviewer")) {
      return {
        value: roleResponse({
          summary: "Evidence is sufficient",
          decision: "APPROVE"
        }),
        meta: { finishReason: "stop", usage: { prompt_tokens: 90, completion_tokens: 20 }, reasoningTokens: 5 }
      };
    }

    throw new Error("Unexpected fake model request");
  }
}

const config = {
  model: { baseUrl: "http://127.0.0.1:1234/v1", model: "fake" },
  coverage: {
    maxChunkChars: 90,
    maxBatchChars: 130,
    batchMaxTokens: 300,
    singleChunkMaxTokens: 500,
    batchTemperature: 0.1,
    maxSynthesisChars: 24000
  },
  repoReader: {
    maxFiles: 100,
    maxFileBytes: 100000,
    excludedDirectories: [".git", "node_modules", "runtime-data"]
  },
  runtimeData: { runsRoot: "runtime-data/runs" }
};

async function createFixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const runs = join(root, "runs");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "README.md"), "# Demo\n" + "A".repeat(70) + "\n", "utf8");
  await writeFile(join(repo, "src", "a.js"), "export const a = 1;\n" + "B".repeat(70) + "\n", "utf8");
  await writeFile(join(repo, "src", "b.js"), "export const b = 2;\n" + "C".repeat(70) + "\n", "utf8");
  return { repo, runs };
}

test("coverage audit processes every planned chunk, checkpoints results, and reaches 100 percent", async (t) => {
  const { repo, runs } = await createFixture(t, "local-ai-lab-full-coverage-");
  const model = new CoverageFakeModel();
  const store = new RunStore(runs);
  const orchestrator = new CoverageAuditOrchestrator({ config, modelClient: model, runStore: store });

  const result = await orchestrator.run({
    repoPath: repo,
    goal: "Audit all source files",
    runId: "coverage-complete"
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.coverage.coveragePercent, 100);
  assert.equal(result.coverage.completedChunks, result.coverage.totalChunks);
  assert.equal(result.reviewer.result.decision, "APPROVE");

  const plan = JSON.parse(await readFile(join(runs, "coverage-complete", "coverage-plan.json"), "utf8"));
  const batches = JSON.parse(await readFile(join(runs, "coverage-complete", "batch-results.json"), "utf8"));
  const coverage = JSON.parse(await readFile(join(runs, "coverage-complete", "coverage.json"), "utf8"));

  assert.equal(plan.auditableFiles, 3);
  assert.equal(batches.length, plan.totalBatches);
  assert.ok(batches.every((batch) => batch.status === "completed"));
  assert.equal(coverage.complete, true);
});

test("output token limit adaptively splits a multi-chunk batch instead of repeating it unchanged", async (t) => {
  const { repo, runs } = await createFixture(t, "local-ai-lab-coverage-split-");
  const splitConfig = {
    ...config,
    coverage: { ...config.coverage, maxBatchChars: 1000 }
  };
  const model = new CoverageFakeModel({ outputCapBatchIds: ["batch-0001"] });
  const events = [];
  const orchestrator = new CoverageAuditOrchestrator({
    config: splitConfig,
    modelClient: model,
    runStore: new RunStore(runs),
    onProgress: (event) => events.push(event)
  });

  const result = await orchestrator.run({
    repoPath: repo,
    goal: "Audit all source files",
    runId: "coverage-split"
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.coverage.coveragePercent, 100);
  assert.ok(events.some((event) => event.type === "coverage_batch_split" && event.batchId === "batch-0001"));
  const auditCalls = model.calls.filter((call) => call.system.includes("Coverage Auditor"));
  assert.ok(auditCalls.some((call) => /Batch: batch-0001\.a/.test(call.user)));
  assert.ok(auditCalls.some((call) => /Batch: batch-0001\.b/.test(call.user)));
});

test("partial coverage keeps successful checkpoints and resume skips completed batches", async (t) => {
  const { repo, runs } = await createFixture(t, "local-ai-lab-coverage-resume-");
  const store = new RunStore(runs);
  const failingModel = new CoverageFakeModel({ failBatchId: "batch-0002" });
  const first = new CoverageAuditOrchestrator({ config, modelClient: failingModel, runStore: store });

  const partial = await first.run({
    repoPath: repo,
    goal: "Audit all source files",
    runId: "coverage-resume"
  });

  assert.equal(partial.status, "PARTIAL");
  assert.ok(partial.coverage.coveragePercent < 100);
  const savedBefore = JSON.parse(await readFile(join(runs, "coverage-resume", "batch-results.json"), "utf8"));
  assert.ok(savedBefore.some((batch) => batch.status === "completed"));
  assert.ok(savedBefore.some((batch) => batch.batchId === "batch-0002" && batch.status === "failed"));

  const resumeModel = new CoverageFakeModel();
  const second = new CoverageAuditOrchestrator({ config, modelClient: resumeModel, runStore: store });
  const completed = await second.run({
    repoPath: repo,
    goal: "Audit all source files",
    runId: "coverage-resume",
    resume: true
  });

  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.coverage.coveragePercent, 100);

  const resumedCoverageCalls = resumeModel.calls.filter((call) => call.system.includes("Coverage Auditor"));
  assert.equal(resumedCoverageCalls.length, 1);
  assert.match(resumedCoverageCalls[0].user, /Batch: batch-0002/);
});

test("resume refuses a changed batch layout even when repository files are unchanged", async (t) => {
  const { repo, runs } = await createFixture(t, "local-ai-lab-coverage-plan-change-");
  const store = new RunStore(runs);
  const first = new CoverageAuditOrchestrator({ config, modelClient: new CoverageFakeModel(), runStore: store });
  await first.run({ repoPath: repo, goal: "Audit all source files", runId: "coverage-plan-change" });

  const changedConfig = {
    ...config,
    coverage: { ...config.coverage, maxBatchChars: 1000 }
  };
  const second = new CoverageAuditOrchestrator({ changedConfig, modelClient: new CoverageFakeModel(), runStore: store });
  void second;

  const changed = new CoverageAuditOrchestrator({ config: changedConfig, modelClient: new CoverageFakeModel(), runStore: store });
  await assert.rejects(
    () => changed.run({
      repoPath: repo,
      goal: "Audit all source files",
      runId: "coverage-plan-change",
      resume: true
    }),
    /coverage batch plan changed/
  );
});
