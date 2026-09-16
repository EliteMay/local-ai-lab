import test from "node:test";
import assert from "node:assert/strict";
import { validateDelegationRequest, validateTaskResult } from "../src/core/contracts.mjs";

test("valid delegation request passes", () => {
  const result = validateDelegationRequest({
    type: "delegation_request",
    from: "auditor",
    to: "researcher",
    objective: "Research current navigation evidence",
    reason: "Need external evidence",
    priority: "normal"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("invalid delegation request is rejected", () => {
  const result = validateDelegationRequest({
    type: "delegation_request",
    from: "auditor",
    to: "engineer",
    objective: "",
    reason: ""
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
});

test("task result requires structured arrays and known status", () => {
  const valid = validateTaskResult({
    status: "completed",
    findings: [],
    evidence: [],
    uncertainties: [],
    recommendedNextActions: []
  });
  assert.equal(valid.ok, true);

  const invalid = validateTaskResult({ status: "done" });
  assert.equal(invalid.ok, false);
});
