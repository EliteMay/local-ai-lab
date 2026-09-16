import test from "node:test";
import assert from "node:assert/strict";
import { getAgentResponseSchema, COVERAGE_BATCH_SCHEMA } from "../src/core/response-schemas.mjs";

test("role response schema enforces string action arrays and role-specific decisions", () => {
  const auditor = getAgentResponseSchema("auditor");
  const reviewer = getAgentResponseSchema("reviewer");

  assert.deepEqual(auditor.properties.recommendedNextActions.items, { type: "string" });
  assert.deepEqual(auditor.properties.uncertainties.items, { type: "string" });
  assert.deepEqual(auditor.properties.decision, { type: "null" });
  assert.deepEqual(reviewer.properties.decision, {
    enum: ["APPROVE", "REJECT", "NEED_MORE_EVIDENCE"]
  });
  assert.equal(auditor.additionalProperties, false);
});

test("coverage batch schema requires line-addressable evidence and inspected chunk IDs", () => {
  assert.ok(COVERAGE_BATCH_SCHEMA.required.includes("inspectedChunks"));
  assert.ok(COVERAGE_BATCH_SCHEMA.required.includes("findings"));

  const finding = COVERAGE_BATCH_SCHEMA.properties.findings.items;
  assert.ok(finding.required.includes("evidence"));
  const evidence = finding.properties.evidence.items;
  assert.deepEqual(evidence.required, ["file", "lineStart", "lineEnd", "claim"]);
  assert.equal(evidence.properties.lineStart.minimum, 1);
});
