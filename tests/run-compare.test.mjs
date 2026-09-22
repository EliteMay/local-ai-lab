import test from "node:test";
import assert from "node:assert/strict";
import { compareRunDetails, findingComparisonKey } from "../desktop/run-compare.mjs";

function finding(title, severity, file, lineStart) {
  return {
    title,
    severity,
    confidence: "high",
    evidence: [{ file, lineStart, lineEnd: lineStart }]
  };
}

test("run comparison separates added, resolved and persisting findings", () => {
  const baseline = {
    runId: "run-old",
    run: { repoPath: "D:/repo", createdAt: "2026-09-20T00:00:00Z", completedAt: "2026-09-20T00:10:00Z" },
    coverage: { coveragePercent: 90 },
    findings: [
      finding("old problem", "high", "src/a.js", 10),
      finding("same problem", "medium", "src/b.js", 20)
    ],
    modelUsage: { models: [{ calls: 3 }] }
  };
  const current = {
    runId: "run-new",
    run: { repoPath: "D:/repo", createdAt: "2026-09-21T00:00:00Z", completedAt: "2026-09-21T00:08:00Z" },
    coverage: { coveragePercent: 100 },
    findings: [
      finding("same problem", "medium", "src/b.js", 20),
      finding("new problem", "critical", "src/c.js", 30)
    ],
    modelUsage: { models: [{ calls: 5 }] }
  };

  const result = compareRunDetails(baseline, current);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].title, "new problem");
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].title, "old problem");
  assert.equal(result.persisting.length, 1);
  assert.equal(result.delta.findingCount, 0);
  assert.equal(result.delta.coveragePercent, 10);
  assert.equal(result.delta.modelCalls, 2);
  assert.equal(result.delta.durationMs, -120000);
  assert.deepEqual(result.delta.severity, { critical: 1, high: -1, medium: 0, low: 0 });
});

test("run comparison rejects different repositories", () => {
  assert.throws(() => compareRunDetails(
    { runId: "run-a", run: { repoPath: "D:/repo-a" }, findings: [] },
    { runId: "run-b", run: { repoPath: "D:/repo-b" }, findings: [] }
  ), /別の対象フォルダ/);
});

test("finding comparison key is stable for equivalent evidence", () => {
  assert.equal(
    findingComparisonKey(finding(" Same   Problem ", "high", "SRC/A.js", 10)),
    findingComparisonKey(finding("same problem", "low", "src/a.js", 10))
  );
});
