import { TaskBroker } from "./task-broker.mjs";
import { RunStore } from "./run-store.mjs";
import { AgentRunner } from "./agent-runner.mjs";
import { buildRepositoryContext } from "./repository-context.mjs";
import { RepoReader } from "../security/repo-reader.mjs";
import { LMStudioClient } from "../model/lm-studio-client.mjs";

function assertText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function terminalStateFor(resultStatus) {
  if (resultStatus === "completed") return "COMPLETED";
  if (resultStatus === "blocked") return "BLOCKED";
  return "FAILED";
}

function pendingTasks(broker) {
  return broker.snapshot().tasks.filter((task) => task.state === "PENDING");
}

function taskRecord(task, result = null, error = null) {
  return {
    taskId: task.id,
    role: task.assignedTo,
    objective: task.objective,
    state: task.state,
    result,
    error
  };
}

function makeSummary({ runId, goal, repositoryContext, brokerSnapshot, results, rejectedDelegations, finalReview }) {
  const completed = results.filter((item) => item.result?.status === "completed").length;
  const failed = results.filter((item) => item.error || item.result?.status === "failed").length;
  const blocked = results.filter((item) => item.result?.status === "blocked").length;
  const findings = results.flatMap((item) => item.result?.findings ?? []);
  const decision = finalReview?.result?.decision ?? "NOT_AVAILABLE";

  return `# AI Company Run ${runId}\n\n## Goal\n\n${goal}\n\n## Result\n\n- Reviewer decision: ${decision}\n- Tasks: ${brokerSnapshot.taskCount}\n- Model calls: ${brokerSnapshot.modelCalls}\n- Completed task results: ${completed}\n- Failed task results: ${failed}\n- Blocked task results: ${blocked}\n- Findings produced: ${findings.length}\n- Rejected delegation requests: ${rejectedDelegations.length}\n\n## Repository context coverage\n\n- Manifest files: ${repositoryContext.coverage.manifestFiles}\n- Files supplied to model: ${repositoryContext.coverage.includedFiles}\n- Context characters: ${repositoryContext.coverage.includedChars}\n- Omitted candidate files: ${repositoryContext.coverage.omittedCandidateFiles}\n\n## Safety / capability status\n\n- Target repository access: read-only\n- External web research: not implemented in this phase\n- File mutation / shell mutation / git write: unavailable\n\n## Important note\n\nThis report is evidence/proposal output, not a Source of Truth and not an instruction to modify the target repository.\n`;
}

function isSuccessfulRecord(record) {
  return !record.error && record.result?.status === "completed";
}

export class AICompanyOrchestrator {
  constructor({ config, modelClient = null, runStore = null } = {}) {
    if (!config) throw new Error("config is required");
    this.config = config;
    this.modelClient = modelClient ?? new LMStudioClient(config.model);
    this.runStore = runStore ?? new RunStore(config.runtimeData?.runsRoot ?? "runtime-data/runs");
  }

  async run({ repoPath, goal, runId = undefined }) {
    assertText(repoPath, "repoPath");
    assertText(goal, "goal");

    const reader = new RepoReader(repoPath, this.config.repoReader);
    await reader.assertRepositoryExists();
    const repositoryContext = await buildRepositoryContext(reader, this.config.context);
    const broker = new TaskBroker({ limits: this.config.limits });
    const runner = new AgentRunner({
      modelClient: this.modelClient,
      broker,
      maxPriorResultChars: this.config.context?.maxPriorResultChars
    });

    const actualRunId = await this.runStore.createRun({
      ...(runId ? { runId } : {}),
      status: "RUNNING",
      goal,
      repoPath,
      capabilities: {
        repository: "read-only",
        externalWebResearch: false,
        mutation: false
      },
      contextCoverage: repositoryContext.coverage
    });

    const results = [];
    const rejectedDelegations = [];

    const executeTask = async (task) => {
      broker.transition(task.id, "RUNNING");
      const runningTask = broker.getTask(task.id);
      try {
        const result = await runner.run({
          task: runningTask,
          goal,
          repositoryContext,
          priorResults: results
        });

        const delegationCheck = runner.validateDelegations(result, runningTask.assignedTo);
        rejectedDelegations.push(...delegationCheck.rejected.map((item) => ({ taskId: runningTask.id, ...item })));

        let delegationsToApply = delegationCheck.valid;
        if (runningTask.assignedTo === "reviewer" && result.decision !== "NEED_MORE_EVIDENCE" && delegationsToApply.length > 0) {
          rejectedDelegations.push(...delegationsToApply.map((delegation) => ({
            taskId: runningTask.id,
            delegation,
            errors: ["Reviewer delegation requires NEED_MORE_EVIDENCE decision"]
          })));
          delegationsToApply = [];
        }

        for (const delegation of delegationsToApply) {
          try {
            broker.requestDelegation({
              fromTaskId: runningTask.id,
              to: delegation.to,
              objective: delegation.objective,
              reason: delegation.reason,
              priority: delegation.priority ?? "normal",
              inputs: { source: "model-delegation" }
            });
          } catch (error) {
            rejectedDelegations.push({ taskId: runningTask.id, delegation, errors: [error.message] });
          }
        }

        broker.transition(runningTask.id, terminalStateFor(result.status));
        const finalTask = broker.getTask(runningTask.id);
        const record = taskRecord(finalTask, result, null);
        results.push(record);
        return record;
      } catch (error) {
        try {
          broker.transition(runningTask.id, "FAILED");
        } catch {
          // Preserve the original execution error if state transition also fails.
        }
        const finalTask = broker.getTask(runningTask.id);
        const record = taskRecord(finalTask, null, error.message);
        results.push(record);
        return record;
      }
    };

    const drainPending = async (predicate = () => true) => {
      let queue;
      while ((queue = pendingTasks(broker).filter(predicate)).length > 0) {
        await executeTask(queue[0]);
      }
    };

    try {
      const directorTask = broker.createTask({
        requestedBy: "user",
        assignedTo: "director",
        objective: `Plan bounded read-only work for this goal: ${goal}`,
        inputs: { phase: "planning" }
      });
      await executeTask(directorTask);

      let queue = pendingTasks(broker).filter((task) => !["improvement-planner", "reviewer"].includes(task.assignedTo));
      if (queue.length === 0) {
        broker.createTask({
          requestedBy: "director",
          assignedTo: "auditor",
          objective: "Audit the supplied repository evidence for concrete, evidence-backed improvement opportunities",
          inputs: { phase: "audit", fallback: true }
        });
      }

      await drainPending((task) => !["improvement-planner", "reviewer"].includes(task.assignedTo));

      const plannerTask = broker.createTask({
        requestedBy: "director",
        assignedTo: "improvement-planner",
        objective: "Synthesize the accumulated validated findings into specific, minimally disruptive improvement proposals",
        inputs: { phase: "planning-improvements" }
      });
      const plannerRecord = await executeTask(plannerTask);
      if (!isSuccessfulRecord(plannerRecord)) {
        throw new Error(`Critical planner task did not complete successfully: ${plannerRecord.error ?? plannerRecord.result?.status ?? "unknown"}`);
      }

      // Honor any model-requested support or review tasks before the authoritative final review.
      await drainPending();

      const maxReviewPasses = this.config.orchestrator?.maxReviewPasses ?? 2;
      let finalReview = null;

      for (let pass = 1; pass <= maxReviewPasses; pass += 1) {
        const reviewerTask = broker.createTask({
          requestedBy: "director",
          assignedTo: "reviewer",
          objective: `Final review pass ${pass}: verify accumulated findings and proposals for evidence quality, uncertainty, conflicts, duplication, and overreach`,
          inputs: { phase: "final-review", pass }
        });
        finalReview = await executeTask(reviewerTask);

        if (!isSuccessfulRecord(finalReview)) {
          throw new Error(`Critical reviewer task did not complete successfully: ${finalReview.error ?? finalReview.result?.status ?? "unknown"}`);
        }

        const supportTasks = pendingTasks(broker);
        if (finalReview.result.decision !== "NEED_MORE_EVIDENCE" || supportTasks.length === 0 || pass === maxReviewPasses) {
          break;
        }

        await drainPending();
      }

      // If the last allowed review pass requested evidence, preserve those tasks/results even though no further review pass is allowed.
      await drainPending();

      const brokerSnapshot = broker.snapshot();
      const findings = results.flatMap((item) => item.result?.findings ?? []);
      const research = results.filter((item) => item.role === "researcher");
      const reviews = results.filter((item) => item.role === "reviewer");
      const summary = makeSummary({
        runId: actualRunId,
        goal,
        repositoryContext,
        brokerSnapshot,
        results,
        rejectedDelegations,
        finalReview
      });

      await this.runStore.writeJson(actualRunId, "tasks.json", {
        broker: brokerSnapshot,
        results,
        rejectedDelegations
      });
      await this.runStore.writeJson(actualRunId, "findings.json", findings);
      await this.runStore.writeJson(actualRunId, "research.json", research);
      await this.runStore.writeJson(actualRunId, "review.json", reviews);
      await this.runStore.writeSummary(actualRunId, summary);
      await this.runStore.writeJson(actualRunId, "run.json", {
        runId: actualRunId,
        status: "COMPLETED",
        completedAt: new Date().toISOString(),
        goal,
        repoPath,
        capabilities: {
          repository: "read-only",
          externalWebResearch: false,
          mutation: false
        },
        contextCoverage: repositoryContext.coverage,
        taskCount: brokerSnapshot.taskCount,
        modelCalls: brokerSnapshot.modelCalls,
        reviewerDecision: finalReview?.result?.decision ?? null
      });

      return {
        runId: actualRunId,
        reviewerDecision: finalReview?.result?.decision ?? null,
        findings,
        results,
        rejectedDelegations,
        broker: brokerSnapshot,
        contextCoverage: repositoryContext.coverage
      };
    } catch (error) {
      const brokerSnapshot = broker.snapshot();
      await this.runStore.writeJson(actualRunId, "tasks.json", {
        broker: brokerSnapshot,
        results,
        rejectedDelegations,
        failure: error.message
      });
      await this.runStore.writeJson(actualRunId, "run.json", {
        runId: actualRunId,
        status: "FAILED",
        failedAt: new Date().toISOString(),
        goal,
        repoPath,
        error: error.message,
        capabilities: {
          repository: "read-only",
          externalWebResearch: false,
          mutation: false
        },
        contextCoverage: repositoryContext.coverage,
        taskCount: brokerSnapshot.taskCount,
        modelCalls: brokerSnapshot.modelCalls
      });
      throw error;
    }
  }
}
