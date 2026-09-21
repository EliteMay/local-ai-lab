import { getAgentResponseSchema } from "./response-schemas.mjs";
import { getRoleDefinition } from "../roles/role-definitions.mjs";
import { reduceFindingsHierarchically } from "./hierarchical-synthesis.mjs";
import { buildExecutionIdentity } from "./run-identity.mjs";

function renderSynthesisPrompt({ goal, coverage, findings }) {
  return `Goal:\n${goal}\n\nThe whole-repository coverage pass is complete. Turn the evidence-backed audit themes below into specific, minimally disruptive improvement proposals. Each theme keeps sourceFindingIds that point back to the immutable findings.json evidence index. Do not invent repository facts. Do not request another role unless supplied evidence is insufficient.\n\nCoverage:\n${JSON.stringify(coverage)}\n\nAudit themes:\n${JSON.stringify(findings)}\n\nReturn the required structured role response. Keep it concise and prioritize related changes together.\n\n/no_think`;
}

function renderReviewPrompt({ goal, coverage, findings, planner }) {
  return `Goal:\n${goal}\n\nReview the completed whole-repository audit themes and the improvement planner output. Check evidence quality, duplication, unsupported claims, overreach, and contradictions. sourceFindingIds refer to the preserved raw findings evidence. The raw repository has already been covered; do not ask to re-read everything.\n\nCoverage:\n${JSON.stringify(coverage)}\n\nAudit themes:\n${JSON.stringify(findings)}\n\nPlanner output:\n${JSON.stringify(planner)}\n\nReturn the required structured Reviewer response.\n\n/think`;
}

export class CoverageSynthesisService {
  constructor({ config, modelClient, runStore = null, onProgress = null } = {}) {
    if (!config) throw new Error("config is required");
    if (!modelClient) throw new Error("modelClient is required");
    this.config = config;
    this.modelClient = modelClient;
    this.runStore = runStore;
    this.onProgress = typeof onProgress === "function" ? onProgress : () => {};
  }

  #emit(event) {
    try {
      this.onProgress(event);
    } catch {
      // Progress must never break synthesis.
    }
  }

  async synthesize({ runId = null, goal, coverage, findings }) {
    if (!coverage?.complete) {
      throw new Error("Coverage must be complete before synthesis");
    }
    if (!Array.isArray(findings)) throw new Error("findings must be an array");

    const maxSynthesisChars = this.config.coverage?.maxSynthesisChars ?? 24000;
    const reductionGroupChars = this.config.coverage?.reductionGroupChars ?? 9000;
    const reductionMaxTokens = this.config.coverage?.reductionMaxTokens ?? 900;
    const maxSynthesisLevels = this.config.coverage?.maxSynthesisLevels ?? 6;

    this.#emit({
      type: "synthesis_started",
      findings: findings.length,
      chars: JSON.stringify(findings).length,
      maxChars: maxSynthesisChars
    });

    const reduction = await reduceFindingsHierarchically({
      modelClient: this.modelClient,
      goal,
      findings,
      targetChars: maxSynthesisChars,
      groupChars: reductionGroupChars,
      maxTokens: reductionMaxTokens,
      temperature: this.config.coverage?.batchTemperature ?? 0.1,
      maxLevels: maxSynthesisLevels,
      onProgress: (event) => this.#emit(event),
      onLevelCheckpoint: async (snapshot) => {
        if (runId && this.runStore) {
          await this.runStore.writeJson(runId, "synthesis-reduction.json", snapshot);
        }
      }
    });

    if (runId && this.runStore) {
      await this.runStore.writeJson(runId, "synthesis-reduction.json", reduction);
    }

    const planningFindings = reduction.findings;
    const planningChars = JSON.stringify(planningFindings).length;
    if (planningChars > maxSynthesisChars) {
      throw new Error(`Hierarchical synthesis still exceeds planner budget (${planningChars} > ${maxSynthesisChars} chars)`);
    }

    const plannerRole = getRoleDefinition("improvement-planner");
    this.#emit({ type: "synthesis_planner_started", findings: planningFindings.length, chars: planningChars });
    const planner = await this.modelClient.chatJsonDetailed({
      system: plannerRole.system,
      user: renderSynthesisPrompt({ goal, coverage, findings: planningFindings }),
      jsonSchema: getAgentResponseSchema("improvement-planner"),
      maxTokens: this.config.coverage?.plannerMaxTokens ?? plannerRole.maxTokens
    });
    this.#emit({ type: "synthesis_planner_completed", model: planner.meta });

    const reviewerRole = getRoleDefinition("reviewer");
    this.#emit({ type: "synthesis_reviewer_started" });
    const reviewer = await this.modelClient.chatJsonDetailed({
      system: reviewerRole.system,
      user: renderReviewPrompt({ goal, coverage, findings: planningFindings, planner: planner.value }),
      jsonSchema: getAgentResponseSchema("reviewer"),
      maxTokens: this.config.coverage?.reviewerMaxTokens ?? reviewerRole.maxTokens
    });
    this.#emit({ type: "synthesis_reviewer_completed", decision: reviewer.value.decision, model: reviewer.meta });

    return {
      planner: { result: planner.value, model: planner.meta },
      reviewer: { result: reviewer.value, model: reviewer.meta },
      reduction: {
        reduced: reduction.reduced,
        levels: reduction.levels,
        originalFindings: findings.length,
        finalThemes: planningFindings.length,
        finalChars: planningChars,
        originalFindingIds: reduction.originalFindingIds
      },
      error: null
    };
  }

  async synthesizeExistingRun({ runId }) {
    if (!this.runStore) throw new Error("runStore is required for synthesis-only mode");
    if (!runId || !(await this.runStore.hasRun(runId))) {
      throw new Error("coverage-synthesize requires an existing --run-id");
    }

    const run = await this.runStore.readJson(runId, "run.json");
    const coverage = await this.runStore.readJson(runId, "coverage.json");
    const findings = await this.runStore.readJson(runId, "findings.json");
    if (!coverage.complete || coverage.coveragePercent !== 100) {
      throw new Error(`Stored run is not complete enough to synthesize (${coverage.coveragePercent ?? 0}% coverage)`);
    }

    const synthesisIdentity = buildExecutionIdentity(this.config);
    const synthesis = await this.synthesize({
      runId,
      goal: run.goal,
      coverage,
      findings
    });

    await this.runStore.writeJson(runId, "synthesis.json", synthesis);
    await this.runStore.writeJson(runId, "review.json", synthesis.reviewer ?? {});

    const status = synthesis.error ? "PARTIAL" : "COMPLETED";
    const completedAt = new Date().toISOString();
    await this.runStore.writeJson(runId, "run.json", {
      ...run,
      status,
      completedAt,
      coverage,
      synthesisError: synthesis.error,
      reviewerDecision: synthesis.reviewer?.result?.decision ?? null,
      synthesisIdentity,
      synthesisFromStoredEvidence: true
    });

    const summary = `# Full Coverage Audit ${runId}\n\n- Status: ${status}\n- Coverage: ${coverage.coveragePercent}% (${coverage.completedChunks}/${coverage.totalChunks} chunks)\n- Raw findings preserved: ${findings.length}\n- Synthesis themes: ${synthesis.reduction.finalThemes}\n- Reduction levels: ${synthesis.reduction.levels.length}\n- Reviewer: ${synthesis.reviewer?.result?.decision ?? "not available"}\n- Synthesis source: stored evidence snapshot (repository was not re-read)\n\nTarget repository access remained read-only.\n`;
    await this.runStore.writeSummary(runId, summary);

    this.#emit({
      type: "synthesis_existing_run_completed",
      runId,
      status,
      rawFindings: findings.length,
      themes: synthesis.reduction.finalThemes,
      decision: synthesis.reviewer?.result?.decision ?? null
    });

    return { runId, status, coverage, findings, ...synthesis };
  }
}
