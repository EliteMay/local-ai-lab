import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AICompanyOrchestrator } from "../src/core/orchestrator.mjs";
import { RunStore } from "../src/core/run-store.mjs";

function response({ decision = null } = {}) {
  return {
    status: "completed",
    summary: "ok",
    findings: [],
    evidence: [],
    uncertainties: [],
    recommendedNextActions: [],
    delegations: [],
    decision
  };
}

class ProgressFakeModel {
  async chatJson({ system }) {
    if (system.includes("Reviewer")) return response({ decision: "APPROVE" });
    return response();
  }
}

const config = {
  model: { baseUrl: "http://127.0.0.1:1234/v1", model: "fake" },
  limits: { maxDelegationDepth: 3, maxTasksPerRun: 12, maxModelCalls: 20, maxRetriesPerTask: 1 },
  orchestrator: { maxReviewPasses: 2 },
  context: { maxFiles: 8, maxChars: 12000, maxFileChars: 4000, maxPriorResultChars: 6000 },
  repoReader: { maxFiles: 100, maxFileBytes: 100000, excludedDirectories: [".git", "node_modules", "runtime-data"] }
};

test("orchestrator emits live progress for each required role", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = join(root, "repo");
  const runs = join(root, "runs");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "# Demo\n", "utf8");

  const events = [];
  const orchestrator = new AICompanyOrchestrator({
    config,
    modelClient: new ProgressFakeModel(),
    runStore: new RunStore(runs),
    onProgress: (event) => events.push(event)
  });

  const result = await orchestrator.run({
    repoPath: repo,
    goal: "Audit safely",
    runId: "progress-run"
  });

  assert.equal(result.reviewerDecision, "APPROVE");
  const startedRoles = events
    .filter((event) => event.type === "task_started")
    .map((event) => event.role);

  assert.deepEqual(startedRoles, [
    "director",
    "auditor",
    "improvement-planner",
    "reviewer"
  ]);
  assert.equal(events.filter((event) => event.type === "task_completed").length, 4);
  assert.ok(events.some((event) => event.type === "run_completed"));
});
