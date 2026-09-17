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

const EVIDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    file: { type: "string", minLength: 1 },
    lineStart: { type: "integer", minimum: 1 },
    lineEnd: { type: "integer", minimum: 1 },
    claim: { type: "string", minLength: 1, maxLength: 220 }
  },
  required: ["file", "lineStart", "lineEnd", "claim"]
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
    summary: { type: "string", minLength: 1, maxLength: 220 },
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
          severity: { enum: ["low", "medium", "high", "critical"] },
          title: { type: "string", minLength: 1, maxLength: 180 },
          confidence: { enum: ["low", "medium", "high"] },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: EVIDENCE_SCHEMA
          }
        },
        required: ["severity", "title", "confidence", "evidence"]
      }
    },
    uncertainties: {
      type: "array",
      items: { type: "string", maxLength: 220 }
    }
  },
  required: ["summary", "inspectedChunks", "findings", "uncertainties"]
};

export const SYNTHESIS_REDUCTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sourceFindingIds: {
      type: "array",
      items: { type: "string", minLength: 1 }
    },
    clusters: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { enum: ["low", "medium", "high", "critical"] },
          title: { type: "string", minLength: 1, maxLength: 160 },
          confidence: { enum: ["low", "medium", "high"] },
          sourceFindingIds: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 }
          },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: EVIDENCE_SCHEMA
          }
        },
        required: ["severity", "title", "confidence", "sourceFindingIds", "evidence"]
      }
    }
  },
  required: ["sourceFindingIds", "clusters"]
};
