import test from "node:test";
import assert from "node:assert/strict";
import { buildRunOverview } from "../desktop/run-overview.mjs";

test("run overview summarizes coverage, severity, reviewer and top findings", () => {
  const overview = buildRunOverview({
    run: { status: "COMPLETED", reviewerDecision: "APPROVE" },
    coverage: {
      coveragePercent: 100,
      auditableFiles: 52,
      excludedFiles: 6,
      completedChunks: 70,
      totalChunks: 70
    },
    findings: [
      { id: "low", severity: "low", confidence: "high", title: "Low", evidence: [{ file: "a.js", lineStart: 1, lineEnd: 2 }] },
      { id: "critical", severity: "critical", confidence: "medium", title: "Critical", evidence: [{ file: "b.js", lineStart: 4, lineEnd: 5 }] },
      { id: "high", severity: "high", confidence: "high", title: "High", evidence: [{ file: "c.js", lineStart: 7, lineEnd: 8 }] },
      { id: "medium", severity: "medium", confidence: "low", title: "Medium", evidence: [{ file: "d.js", lineStart: 9, lineEnd: 10 }] }
    ]
  });

  assert.equal(overview.coveragePercent, 100);
  assert.equal(overview.auditableFiles, 52);
  assert.equal(overview.excludedFiles, 6);
  assert.equal(overview.findingCount, 4);
  assert.deepEqual(overview.severity, { critical: 1, high: 1, medium: 1, low: 1 });
  assert.deepEqual(overview.topFindings.map((item) => item.id), ["critical", "high", "medium"]);
  assert.equal(overview.reviewerDecision, "APPROVE");
});

test("run overview tolerates missing or wrapped findings", () => {
  assert.equal(buildRunOverview().findingCount, 0);
  assert.equal(buildRunOverview({ findings: { findings: [{ severity: "high", title: "x", confidence: "low", evidence: [] }] } }).severity.high, 1);
});
