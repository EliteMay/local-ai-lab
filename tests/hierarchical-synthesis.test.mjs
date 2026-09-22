import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceFindingsHierarchically } from "../src/core/hierarchical-synthesis.mjs";
import { CoverageSynthesisService } from "../src/core/coverage-synthesis.mjs";
import { RunStore } from "../src/core/run-store.mjs";

function requiredIds(user) {
  const match = String(user).match(/Required inputItemIds \(copy exactly\):\n([\s\S]*?)\n\nRules:/);
  if (!match) return [];
  return match[1].split("\n").map((value) => value.trim()).filter(Boolean);
}

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

class SynthesisFakeModel {
  constructor() {
    this.calls = [];
  }

  async chatJsonDetailed({ system, user }) {
    this.calls.push({ system, user });

    if (system.includes("finding-clustering worker")) {
      const ids = requiredIds(user);
      return {
        value: {
          inputItemIds: ids,
          clusters: [{ title: "Grouped audit theme", memberIds: ids }]
        },
        meta: { finishReason: "stop", usage: { prompt_tokens: 100, completion_tokens: 30 }, reasoningTokens: 0 }
      };
    }

    if (system.includes("Improvement Planner")) {
      return {
        value: roleResponse({
          summary: "Created grouped improvements",
          findings: [{ proposal: "Improve the grouped area" }],
          recommendedNextActions: ["Review the grouped proposal"]
        }),
        meta: { finishReason: "stop", usage: { prompt_tokens: 120, completion_tokens: 40 }, reasoningTokens: 0 }
      };
    }

    if (system.includes("Reviewer")) {
      return {
        value: roleResponse({ summary: "Evidence is sufficient", decision: "APPROVE" }),
        meta: { finishReason: "stop", usage: { prompt_tokens: 130, completion_tokens: 30 }, reasoningTokens: 5 }
      };
    }

    throw new Error("Unexpected fake model call");
  }
}

function makeFindings(count = 18) {
  return Array.from({ length: count }, (_, index) => ({
    id: `batch-0001-finding-${String(index + 1).padStart(2, "0")}`,
    batchId: "batch-0001",
    severity: index % 7 === 0 ? "high" : "medium",
    title: `Repeated maintainability issue ${index + 1} ${"x".repeat(40)}`,
    confidence: "high",
    evidence: [{
      file: `src/file-${index % 4}.js`,
      lineStart: index + 1,
      lineEnd: index + 1,
      claim: `Evidence claim ${index + 1} ${"y".repeat(80)}`
    }]
  }));
}

test("hierarchical synthesis reduces findings while preserving every original finding id", async () => {
  const findings = makeFindings();
  const model = new SynthesisFakeModel();
  const originalChars = JSON.stringify(findings).length;

  const reduced = await reduceFindingsHierarchically({
    modelClient: model,
    goal: "Audit all files",
    findings,
    targetChars: 1600,
    groupChars: 1400,
    maxTokens: 500,
    maxLevels: 5
  });

  assert.equal(reduced.reduced, true);
  assert.ok(reduced.findings.length < findings.length);
  assert.ok(JSON.stringify(reduced.findings).length < originalChars);

  const covered = [...new Set(reduced.findings.flatMap((item) => item.sourceFindingIds))].sort();
  assert.deepEqual(covered, findings.map((item) => item.id).sort());
  assert.ok(reduced.levels.length >= 1);
});

test("synthesis-only mode completes an existing 100 percent coverage run without repository access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-synthesis-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RunStore(root);
  const runId = "run-coverage-existing";
  const findings = makeFindings();
  await store.createRun({
    runId,
    status: "PARTIAL",
    mode: "full-coverage-audit",
    goal: "Audit all files",
    repoPath: "Z:\\repository-that-does-not-need-to-exist"
  });
  await store.writeJson(runId, "coverage.json", {
    complete: true,
    coveragePercent: 100,
    completedChunks: 42,
    totalChunks: 42,
    auditableFiles: 32,
    excludedFiles: 0
  });
  await store.writeJson(runId, "findings.json", findings);

  const model = new SynthesisFakeModel();
  const config = {
    coverage: {
      maxSynthesisChars: 1600,
      reductionGroupChars: 1400,
      reductionMaxTokens: 500,
      maxSynthesisLevels: 5,
      batchTemperature: 0.1
    },
    runtimeData: { runsRoot: root }
  };
  const service = new CoverageSynthesisService({ config, modelClient: model, runStore: store });
  const result = await service.synthesizeExistingRun({ runId });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.reviewer.result.decision, "APPROVE");
  assert.equal(result.coverage.coveragePercent, 100);
  assert.equal(result.findings.length, findings.length);
  assert.ok(result.reduction.finalThemes < findings.length);

  const savedRun = JSON.parse(await readFile(join(root, runId, "run.json"), "utf8"));
  const reduction = JSON.parse(await readFile(join(root, runId, "synthesis-reduction.json"), "utf8"));
  const review = JSON.parse(await readFile(join(root, runId, "review.json"), "utf8"));

  assert.equal(savedRun.status, "COMPLETED");
  assert.equal(savedRun.synthesisFromStoredEvidence, true);
  assert.ok(reduction.findings.length < findings.length);
  assert.equal(review.result.decision, "APPROVE");
});
