const ROLES = new Set(["director", "researcher", "auditor", "improvement-planner", "reviewer"]);
const PRIORITIES = new Set(["low", "normal", "high"]);
const RESULT_STATES = new Set(["completed", "failed", "blocked"]);

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
