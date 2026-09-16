import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AICompanyOrchestrator } from "../src/core/orchestrator.mjs";
import { RunStore } from "../src/core/run-store.mjs";

class FakeModelClient {
  async chatJson({ system }) {
    if (system.includes("Director")) {
      return {
        status: "completed",
        summary: "Delegate the repository audit to the Auditor.",
        findings: [],
        evidence: [],
        uncertainties: [],
        recommendedNextActions: [],
        delegations: [{
          type: "delegation_request",
          from: "director",
          to: "auditor",
          objective: "Audit the repository for evidence-backed issues",
          reason: "A specialist audit is required",
          priority: "normal"
        }],
        decision: null
      };
    }

    if (system.includes("Auditor")) {
      return {
        status: "completed",
        summary: "Found one bounded documentation issue and requested an internal evidence check.",
        findings: [{ id: "F-001", issue: "README lacks an explicit validation command", evidence: "README.md:1" }],
        evidence: [{ source: "README.md:1", claim: "Repository documentation is present" }],
        uncertainties: ["Need a second repository-evidence pass"],
        recommendedNextActions: ["Ask Researcher to cross-check repository documentation"],
        delegations: [{
          type: "delegation_request",
          from: "auditor",
          to: "researcher",
          objective: "Cross-check repository documentation for validation instructions",
          reason: "Additional repository evidence is useful",
          priority: "normal"
        }],
        decision: null
      };
    }

    if (system.includes("Researcher")) {
      return {
        status: "completed",
        summary: "Cross-check completed using repository evidence only.",
        findings: [],
        evidence: [{ source: "README.md:1", claim: "No external web research was used" }],
        uncertainties: [],
        recommendedNextActions: [],
        delegations: [],
        decision: null
      };
    }

    if (system.includes("Improvement Planner")) {
      return {
        status: "completed",
        summary: "Proposed a documentation-only improvement.",
        findings: [{ id: "P-001", proposal: "Document the validation command without changing runtime code" }],
        evidence: [{ source: "prior-results", claim: "Proposal derives from audited documentation finding" }],
        uncertainties: [],
        recommendedNextActions: ["Let Reviewer validate the proposal"],
        delegations: [],
        decision: null
      };
    }

    if (system.includes("Reviewer")) {
      return {
        status: "completed",
        summary: "The bounded proposal is supported by repository evidence.",
        findings: [],
        evidence: [{ source: "prior-results", claim: "Finding and proposal are traceable" }],
        uncertainties: [],
        recommendedNextActions: [],
        delegations: [],
        decision: "APPROVE"
      };
    }

    throw new Error("Unexpected role prompt");
  }
}

const config = {
  model: { baseUrl: "http://127.0.0.1:1234/v1", model: "fake" },
  limits: { maxDelegationDepth: 3, maxTasksPerRun: 12, maxModelCalls: 20, maxRetriesPerTask: 1 },
  context: { maxFiles: 8, maxChars: 12000, maxFileChars: 4000, maxPriorResultChars: 6000 },
  repoReader: { maxFiles: 100, maxFileBytes: 100000, excludedDirectories: [".git", "node_modules", "runtime-data"] }
};

test("AICompanyOrchestrator runs Director -> delegated specialists -> Planner -> Reviewer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-orchestrator-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = join(root, "repo");
  const runs = join(root, "runs");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "README.md"), "# Demo repository\n", "utf8");
  await writeFile(join(repo, "src", "app.js"), "export const ok = true;\n", "utf8");

  const orchestrator = new AICompanyOrchestrator({
    config,
    modelClient: new FakeModelClient(),
    runStore: new RunStore(runs)
  });

  const result = await orchestrator.run({
    repoPath: repo,
    goal: "Find safe repository improvements",
    runId: "test-run"
  });

  assert.equal(result.runId, "test-run");
  assert.equal(result.reviewerDecision, "APPROVE");
  assert.equal(result.broker.taskCount, 5);
  assert.equal(result.broker.modelCalls, 5);
  assert.equal(result.rejectedDelegations.length, 0);
  assert.ok(result.findings.some((finding) => finding.id === "F-001"));

  const run = JSON.parse(await readFile(join(runs, "test-run", "run.json"), "utf8"));
  const tasks = JSON.parse(await readFile(join(runs, "test-run", "tasks.json"), "utf8"));
  const summary = await readFile(join(runs, "test-run", "summary.md"), "utf8");

  assert.equal(run.status, "COMPLETED");
  assert.equal(tasks.broker.taskCount, 5);
  assert.match(summary, /External web research: not implemented/);
});
