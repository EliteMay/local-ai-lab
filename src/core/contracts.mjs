const ROLES = new Set(["director", "researcher", "auditor", "improvement-planner", "reviewer"]);
const PRIORITIES = new Set(["low", "normal", "high"]);
const RESULT_STATES = new Set(["completed", "failed", "blocked"]);
const REVIEW_DECISIONS = new Set(["APPROVE", "REJECT", "NEED_MORE_EVIDENCE"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateDelegationRequest(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["delegation request must be an object"] };
  }

  if (value.type !== "delegation_request") errors.push("type must be delegation_request");
  if (!ROLES.has(value.from)) errors.push("from must be a known role");
  if (!ROLES.has(value.to)) errors.push("to must be a known role");
  if (!isNonEmptyString(value.objective)) errors.push("objective is required");
  if (!isNonEmptyString(value.reason)) errors.push("reason is required");
  if (value.priority !== undefined && !PRIORITIES.has(value.priority)) errors.push("priority must be low, normal, or high");

  return { ok: errors.length === 0, errors };
}

export function validateTaskResult(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["task result must be an object"] };
  }

  if (!RESULT_STATES.has(value.status)) errors.push("status must be completed, failed, or blocked");
  if (!Array.isArray(value.findings)) errors.push("findings must be an array");
  if (!Array.isArray(value.evidence)) errors.push("evidence must be an array");
  if (!isStringArray(value.uncertainties)) errors.push("uncertainties must be a string array");
  if (!isStringArray(value.recommendedNextActions)) errors.push("recommendedNextActions must be a string array");

  return { ok: errors.length === 0, errors };
}

export function validateAgentResponse(value, { role } = {}) {
  const base = validateTaskResult(value);
  const errors = [...base.errors];

  if (!isNonEmptyString(value?.summary)) errors.push("summary is required");
  if (!Array.isArray(value?.delegations)) errors.push("delegations must be an array");

  if (Array.isArray(value?.delegations)) {
    for (let index = 0; index < value.delegations.length; index += 1) {
      const validation = validateDelegationRequest(value.delegations[index]);
      if (!validation.ok) {
        errors.push(...validation.errors.map((error) => `delegations[${index}]: ${error}`));
      }
    }
  }

  if (role === "reviewer") {
    if (!REVIEW_DECISIONS.has(value?.decision)) {
      errors.push("reviewer decision must be APPROVE, REJECT, or NEED_MORE_EVIDENCE");
    }
  } else if (value?.decision !== null && value?.decision !== undefined) {
    errors.push("decision must be null or omitted for non-reviewer roles");
  }

  return { ok: errors.length === 0, errors };
}
