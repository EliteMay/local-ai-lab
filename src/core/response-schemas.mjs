const DELEGATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { const: "delegation_request" },
    from: { enum: ["director", "researcher", "auditor", "improvement-planner", "reviewer"] },
    to: { enum: ["director", "researcher", "auditor", "improvement-planner", "reviewer"] },
    objective: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    priority: { enum: ["low", "normal", "high"] }
  },
  required: ["type", "from", "to", "objective", "reason", "priority"]
};

const LOOSE_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: true
};

function decisionSchema(role) {
  if (role === "reviewer") {
    return { enum: ["APPROVE", "REJECT", "NEED_MORE_EVIDENCE"] };
  }
  return { type: "null" };
}

export function getAgentResponseSchema(role) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { enum: ["completed", "failed", "blocked"] },
      summary: { type: "string", minLength: 1 },
      findings: {
        type: "array",
        items: LOOSE_OBJECT_SCHEMA
      },
      evidence: {
        type: "array",
        items: LOOSE_OBJECT_SCHEMA
      },
      uncertainties: {
        type: "array",
        items: { type: "string" }
      },
      recommendedNextActions: {
        type: "array",
        items: { type: "string" }
      },
      delegations: {
        type: "array",
        items: DELEGATION_SCHEMA
      },
      decision: decisionSchema(role)
    },
    required: [
      "status",
      "summary",
      "findings",
      "evidence",
      "uncertainties",
      "recommendedNextActions",
      "delegations",
      "decision"
    ]
  };
}

export const COVERAGE_BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1 },
    inspectedChunks: {
      type: "array",
      items: { type: "string" }
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          severity: { enum: ["low", "medium", "high", "critical"] },
          title: { type: "string", minLength: 1 },
          explanation: { type: "string", minLength: 1 },
          confidence: { enum: ["low", "medium", "high"] },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                file: { type: "string", minLength: 1 },
                lineStart: { type: "integer", minimum: 1 },
                lineEnd: { type: "integer", minimum: 1 },
                claim: { type: "string", minLength: 1 }
              },
              required: ["file", "lineStart", "lineEnd", "claim"]
            }
          }
        },
        required: ["id", "severity", "title", "explanation", "confidence", "evidence"]
      }
    },
    uncertainties: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["summary", "inspectedChunks", "findings", "uncertainties"]
};
