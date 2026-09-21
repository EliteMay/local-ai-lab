import { readFile } from "node:fs/promises";
import { LMStudioClient } from "./model/lm-studio-client.mjs";
import { loadModelCatalog, loadModelRouting } from "./model/model-catalog.mjs";
import { ModelRouter } from "./model/model-router.mjs";
import { RepoReader } from "./security/repo-reader.mjs";
import { TaskBroker } from "./core/task-broker.mjs";
import { AICompanyOrchestrator } from "./core/orchestrator.mjs";
import { CoverageAuditOrchestrator } from "./core/coverage-orchestrator.mjs";
import { CoverageSynthesisService } from "./core/coverage-synthesis.mjs";
import { RunStore } from "./core/run-store.mjs";

function mergeConfig(base, override) {
  const merged = { ...base, ...override };
  for (const key of ["model", "limits", "orchestrator", "context", "coverage", "repoReader", "runtimeData"]) {
    if (base[key] && override[key]) {
      merged[key] = { ...base[key], ...override[key] };
    }
  }
  return merged;
}

async function loadConfig(args = []) {
  const defaultUrl = new URL("../config/default.json", import.meta.url);
  const base = JSON.parse(await readFile(defaultUrl, "utf8"));
  const profile = getOption(args, "--model-profile") ?? process.env.LOCAL_AI_MODEL_PROFILE;

  if (!profile) {
    return { ...base, activeModelProfile: "default" };
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(profile)) {
    throw new Error(`Invalid model profile name: ${profile}`);
  }

  const profileUrl = new URL(`../config/model-profiles/${profile}.json`, import.meta.url);
  try {
    const override = JSON.parse(await readFile(profileUrl, "utf8"));
    return { ...mergeConfig(base, override), activeModelProfile: profile };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Unknown model profile: ${profile}`);
    }
    throw error;
  }
}

function getOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function optionBoolean(args, name, fallback = true) {
  const value = getOption(args, name);
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(String(value).toLowerCase());
}

async function createModelRouter(config, args) {
  const explicitProfile = getOption(args, "--model-profile") ?? process.env.LOCAL_AI_MODEL_PROFILE;
  const mode = getOption(args, "--model-routing")
    ?? process.env.LOCAL_AI_MODEL_ROUTING
    ?? (explicitProfile ? "fixed" : "auto");
  if (!["auto", "fixed"].includes(mode)) throw new Error("Invalid --model-routing value; use auto or fixed");

  config.modelRoutingMode = mode;
  config.autoManageModels = optionBoolean(args, "--auto-manage-models", true);
  if (mode === "fixed") return null;

  const catalog = await loadModelCatalog();
  const routing = await loadModelRouting(catalog);
  return new ModelRouter({
    config,
    catalog,
    routing,
    autoManageModels: config.autoManageModels,
    onRoute: (event) => {
      const marker = event.type === "model_fallback" ? "FALLBACK" : "ROUTE";
      console.log(`[Model] ${marker} ${JSON.stringify(event)}`);
    }
  });
}

function printHelp() {
  console.log(`local-ai-lab\n\nGlobal options:\n  --model-profile <name>\n      Load config/model-profiles/<name>.json over the default config.\n      You can also set LOCAL_AI_MODEL_PROFILE.\n\nCommands:\n  doctor\n      Check LM Studio API, loaded model, context length, and parallel setting.\n\n  inspect --repo <path> [--search <text>]\n      Read-only inspection of a local repository.\n\n  broker-demo\n      Exercise deterministic delegation without calling the model.\n\n  company --repo <path> --goal <text> [--run-id <id>]\n      Run the original brokered AI Company orchestration.\n\n  coverage --repo <path> --goal <text> [--run-id <id>] [--resume]\n      Audit every auditable text chunk with checkpoints and an explicit coverage ledger.\n      Use --resume with the same --run-id to continue a partial coverage run when repository fingerprints still match.\n\n  coverage-synthesize --run-id <id>\n      Hierarchically synthesize an existing 100% coverage evidence snapshot without re-reading the repository.\n`);
}

function roleLabel(role) {
  const labels = {
    director: "Director",
    researcher: "Researcher",
    auditor: "Auditor",
    "improvement-planner": "Improvement Planner",
    reviewer: "Reviewer"
  };
  return labels[role] ?? role;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return "";
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function modelUsageSuffix(meta) {
  const usage = meta?.usage;
  if (!usage) return "";
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  const reasoning = meta.reasoningTokens;
  const parts = [];
  if (Number.isInteger(prompt)) parts.push(`prompt=${prompt}`);
  if (Number.isInteger(completion)) parts.push(`completion=${completion}`);
  if (Number.isInteger(reasoning)) parts.push(`reasoning=${reasoning}`);
  if (Number.isInteger(meta?.calls) && meta.calls > 1) parts.push(`calls=${meta.calls}`);
  return parts.length ? ` / ${parts.join(" ")}` : "";
}

function printCompanyProgress(event) {
  if (event.type === "run_started") {
    console.log(`[AI Company] Run ${event.runId} started`);
    console.log(`[AI Company] Context: ${event.contextCoverage?.includedFiles ?? "?"} files / ${event.contextCoverage?.includedChars ?? "?"} chars`);
  } else if (event.type === "task_started") {
    console.log(`[AI Company] START ${roleLabel(event.role)} (${event.taskId})`);
  } else if (event.type === "task_delegated") {
    console.log(`[AI Company] DELEGATE ${roleLabel(event.fromRole)} -> ${roleLabel(event.toRole)}: ${event.objective}`);
  } else if (event.type === "task_completed") {
    const decision = event.decision ? ` / ${event.decision}` : "";
    console.log(`[AI Company] DONE  ${roleLabel(event.role)} (${formatDuration(event.durationMs)})${decision}`);
  } else if (event.type === "task_failed") {
    console.log(`[AI Company] FAIL  ${roleLabel(event.role)} (${formatDuration(event.durationMs)}): ${event.error}`);
  } else if (event.type === "run_completed") {
    console.log(`[AI Company] Run completed / tasks=${event.taskCount} / modelCalls=${event.modelCalls}`);
  } else if (event.type === "run_failed") {
    console.log(`[AI Company] Run failed: ${event.error}`);
  }
}

function printCoverageProgress(event) {
  if (event.type === "coverage_run_started") {
    console.log(`[Coverage] Run ${event.runId} started`);
    console.log(`[Coverage] Files=${event.auditableFiles} excluded=${event.excludedFiles} chunks=${event.totalChunks} batches=${event.totalBatches}`);
  } else if (event.type === "coverage_run_resumed") {
    console.log(`[Coverage] Resume ${event.runId}: ${event.completedBatches}/${event.totalBatches} batches already completed`);
  } else if (event.type === "coverage_batch_started") {
    console.log(`[Coverage] START ${event.batchId} / chunks=${event.chunks} / chars=${event.chars}`);
  } else if (event.type === "coverage_batch_split") {
    console.log(`[Coverage] SPLIT ${event.batchId} / ${event.leftChunks}+${event.rightChunks} chunks (output cap)`);
  } else if (event.type === "coverage_batch_retry") {
    console.log(`[Coverage] RETRY ${event.batchId}: ${event.error}`);
  } else if (event.type === "coverage_batch_completed") {
    console.log(`[Coverage] DONE  ${event.batchId} (${formatDuration(event.durationMs)}) / findings=${event.findings.length}${modelUsageSuffix(event.model)}`);
  } else if (event.type === "coverage_batch_failed") {
    console.log(`[Coverage] FAIL  ${event.batchId} (${formatDuration(event.durationMs)}): ${event.error}`);
  } else if (event.type === "coverage_batch_skipped") {
    console.log(`[Coverage] SKIP  ${event.batchId} (checkpoint complete)`);
  } else if (event.type === "coverage_run_completed") {
    console.log(`[Coverage] Run ${event.status} / coverage=${event.coverage.coveragePercent}% / findings=${event.findings}`);
    if (event.synthesisError) console.log(`[Coverage] Synthesis note: ${event.synthesisError}`);
  }
}

function printSynthesisProgress(event) {
  if (event.type === "synthesis_started") {
    console.log(`[Synthesis] START / findings=${event.findings} / chars=${event.chars} / target<=${event.maxChars}`);
  } else if (event.type === "synthesis_level_started") {
    console.log(`[Synthesis] LEVEL ${event.level} / ${event.inputItems} items -> ${event.groups} groups / chars=${event.chars}`);
  } else if (event.type === "synthesis_group_split") {
    console.log(`[Synthesis] SPLIT ${event.groupId} / ${event.leftItems}+${event.rightItems} items (output cap)`);
  } else if (event.type === "synthesis_group_retry") {
    console.log(`[Synthesis] RETRY ${event.groupId}: ${event.error}`);
  } else if (event.type === "synthesis_group_completed") {
    console.log(`[Synthesis] DONE ${event.groupId} / ${event.inputItems}->${event.outputItems}${modelUsageSuffix(event.model)}`);
  } else if (event.type === "synthesis_level_completed") {
    console.log(`[Synthesis] LEVEL ${event.level} complete / ${event.inputItems}->${event.outputItems} / ${event.inputChars}->${event.outputChars} chars / calls=${event.modelCalls}`);
  } else if (event.type === "synthesis_planner_started") {
    console.log(`[Synthesis] Planner START / themes=${event.findings} / chars=${event.chars}`);
  } else if (event.type === "synthesis_planner_completed") {
    console.log(`[Synthesis] Planner DONE${modelUsageSuffix(event.model)}`);
  } else if (event.type === "synthesis_reviewer_started") {
    console.log(`[Synthesis] Reviewer START`);
  } else if (event.type === "synthesis_reviewer_completed") {
    console.log(`[Synthesis] Reviewer DONE / ${event.decision}${modelUsageSuffix(event.model)}`);
  } else if (event.type === "synthesis_existing_run_completed") {
    console.log(`[Synthesis] Run ${event.status} / raw=${event.rawFindings} / themes=${event.themes} / reviewer=${event.decision ?? "none"}`);
  }
}

async function doctor(config) {
  const client = new LMStudioClient(config.model);
  const models = await client.listModels();
  const ids = models.map((item) => item.id).filter(Boolean);

  console.log(`${client.providerName} API: OK`);
  console.log(`Model profile: ${config.activeModelProfile ?? "default"}`);
  console.log(`Configured model: ${config.model.model}`);
  console.log(`Available models: ${ids.length ? ids.join(", ") : "none"}`);
  console.log(`Configured model loaded: ${ids.includes(config.model.model) ? "yes" : "no"}`);
  console.log(`Request timeout: ${Math.round((config.model.timeoutMs ?? 600000) / 1000)} seconds`);
  console.log(`HTTP transport: ${config.model.transport ?? "fetch"}`);
  console.log(`Max output tokens: ${config.model.maxTokens ?? 2048}`);

  try {
    const details = await client.listModelDetails();
    if (!Array.isArray(details)) {
      console.log(`Loaded model details: not supported by ${client.providerName}`);
      return;
    }
    const model = details.find((item) => item.key === config.model.model || item.loaded_instances?.some((instance) => instance.id === config.model.model));
    const instance = model?.loaded_instances?.find((item) => item.id === config.model.model) ?? model?.loaded_instances?.[0];
    if (instance?.config) {
      console.log(`Loaded context length: ${instance.config.context_length ?? "unknown"}`);
      console.log(`Max concurrent predictions: ${instance.config.parallel ?? "unknown"}`);
      console.log(`Flash attention: ${instance.config.flash_attention === undefined ? "unknown" : instance.config.flash_attention ? "on" : "off"}`);
      if ((instance.config.parallel ?? 1) > 1) {
        console.log(`Audit note: this workflow is sequential; benchmark parallel=1 to reduce unnecessary slot/cache pressure.`);
      }
    }
  } catch (error) {
    console.log(`Loaded model details: unavailable (${error.message})`);
  }
}

async function inspect(config, args) {
  const repo = getOption(args, "--repo");
  if (!repo) {
    throw new Error("inspect requires --repo <path>");
  }

  const reader = new RepoReader(repo, config.repoReader);
  const inventory = typeof reader.listFilesDetailed === "function" ? await reader.listFilesDetailed() : { files: await reader.listFiles(), truncated: false };
  console.log(`Repository: ${repo}`);
  console.log(`Readable candidate files: ${inventory.files.length}`);
  console.log(`Inventory truncated: ${inventory.truncated ? "yes" : "no"}`);
  for (const file of inventory.files.slice(0, 30)) {
    console.log(`- ${file}`);
  }
  if (inventory.files.length > 30) {
    console.log(`... ${inventory.files.length - 30} more`);
  }

  const query = getOption(args, "--search");
  if (query) {
    const results = await reader.searchText(query);
    console.log(`\nSearch: ${query}`);
    for (const result of results) {
      console.log(`${result.file}:${result.line} ${result.text}`);
    }
  }
}

function brokerDemo(config) {
  const broker = new TaskBroker({ limits: config.limits });
  const audit = broker.createTask({
    requestedBy: "director",
    assignedTo: "auditor",
    objective: "Inspect the target repository for evidence-backed improvement opportunities"
  });
  broker.transition(audit.id, "RUNNING");
  const research = broker.requestDelegation({
    fromTaskId: audit.id,
    to: "researcher",
    objective: "Collect evidence for one uncertain audit finding",
    reason: "Repository evidence alone is insufficient"
  });

  console.log(JSON.stringify({ audit, research, snapshot: broker.snapshot() }, null, 2));
}

async function assertConfiguredModelLoaded(client, config) {
  const models = await client.listModels();
  const modelIds = models.map((item) => item.id).filter(Boolean);
  if (!modelIds.includes(config.model.model)) {
    throw new Error(`Configured model is not loaded on ${client.providerName}: ${config.model.model}`);
  }
}

async function runCompany(config, args) {
  const repo = getOption(args, "--repo");
  const goal = getOption(args, "--goal");
  const runId = getOption(args, "--run-id");
  if (!repo || !goal) {
    throw new Error("company requires --repo <path> and --goal <text>");
  }

  const modelRouter = await createModelRouter(config, args);
  const client = modelRouter ? null : new LMStudioClient(config.model);
  if (client) await assertConfiguredModelLoaded(client, config);

  console.log(modelRouter ? "AI Company model routing: auto" : `AI Company model: ${config.model.model}`);
  console.log(`Per-request timeout: ${Math.round((config.model.timeoutMs ?? 600000) / 1000)}s / max output tokens: ${config.model.maxTokens ?? 2048}`);

  const orchestrator = new AICompanyOrchestrator({
    config,
    modelClient: client,
    modelRouter,
    onProgress: printCompanyProgress
  });
  const result = await orchestrator.run({ repoPath: repo, goal, runId });

  console.log(`AI Company run completed: ${result.runId}`);
  console.log(`Reviewer decision: ${result.reviewerDecision ?? "none"}`);
  console.log(`Findings: ${result.findings.length}`);
  console.log(`Tasks: ${result.broker.taskCount}`);
  console.log(`Model calls: ${result.broker.modelCalls}`);
  console.log(`Evidence: runtime-data/runs/${result.runId}`);
}

async function runCoverage(config, args) {
  const repo = getOption(args, "--repo");
  const goal = getOption(args, "--goal");
  const runId = getOption(args, "--run-id");
  const resume = hasFlag(args, "--resume");
  if (!repo || !goal) {
    throw new Error("coverage requires --repo <path> and --goal <text>");
  }
  if (resume && !runId) {
    throw new Error("coverage --resume requires --run-id <id>");
  }

  const modelRouter = await createModelRouter(config, args);
  const client = modelRouter ? null : new LMStudioClient(config.model);
  if (client) await assertConfiguredModelLoaded(client, config);
  console.log(modelRouter ? "Coverage audit model routing: auto" : `Coverage audit model: ${config.model.model}`);
  console.log(`Batch budget: ${config.coverage?.maxBatchChars ?? 16000} chars / ${config.coverage?.batchMaxTokens ?? 1000} output tokens`);
  console.log(`Adaptive single-chunk ceiling: ${config.coverage?.singleChunkMaxTokens ?? 1800} output tokens`);

  const orchestrator = new CoverageAuditOrchestrator({
    config,
    modelClient: client,
    modelRouter,
    onProgress: printCoverageProgress
  });
  const result = await orchestrator.run({ repoPath: repo, goal, runId, resume });

  console.log(`Coverage run: ${result.runId}`);
  console.log(`Status: ${result.status}`);
  console.log(`Coverage: ${result.coverage.coveragePercent}% (${result.coverage.completedChunks}/${result.coverage.totalChunks} chunks)`);
  console.log(`Findings: ${result.findings.length}`);
  console.log(`Reviewer decision: ${result.reviewer?.result?.decision ?? "none"}`);
  console.log(`Evidence/checkpoint: runtime-data/runs/${result.runId}`);
  if (result.status !== "COMPLETED") {
    if (result.coverage.complete) {
      console.log(`Synthesis command: npm run coverage-synthesize -- --run-id "${result.runId}"`);
    } else {
      console.log(`Resume command: npm run coverage -- --repo "${repo}" --goal "${goal}" --run-id "${result.runId}" --resume`);
    }
  }
}

async function runCoverageSynthesize(config, args) {
  const runId = getOption(args, "--run-id");
  if (!runId) throw new Error("coverage-synthesize requires --run-id <id>");

  const modelRouter = await createModelRouter(config, args);
  const client = modelRouter ? null : new LMStudioClient(config.model);
  if (client) await assertConfiguredModelLoaded(client, config);
  const runStore = new RunStore(config.runtimeData?.runsRoot ?? "runtime-data/runs");
  const service = new CoverageSynthesisService({
    config,
    modelClient: client,
    modelRouter,
    runStore,
    onProgress: printSynthesisProgress
  });

  console.log(modelRouter ? "Coverage synthesis model routing: auto" : `Coverage synthesis model: ${config.model.model}`);
  console.log(`Stored run: ${runId}`);
  console.log(`Planner input target: <=${config.coverage?.maxSynthesisChars ?? 24000} chars`);
  const result = await service.synthesizeExistingRun({ runId });

  console.log(`Synthesis run: ${result.runId}`);
  console.log(`Status: ${result.status}`);
  console.log(`Coverage snapshot: ${result.coverage.coveragePercent}% (${result.coverage.completedChunks}/${result.coverage.totalChunks} chunks)`);
  console.log(`Raw findings: ${result.findings.length}`);
  console.log(`Final themes: ${result.reduction.finalThemes}`);
  console.log(`Reduction levels: ${result.reduction.levels.length}`);
  console.log(`Reviewer decision: ${result.reviewer?.result?.decision ?? "none"}`);
  console.log(`Evidence/checkpoint: runtime-data/runs/${result.runId}`);
}

const args = process.argv.slice(2);
const command = args[0];

try {
  const config = await loadConfig(args);
  if (process.env.LOCAL_AI_RUNTIME_DATA_ROOT) {
    config.runtimeData = {
      ...(config.runtimeData ?? {}),
      runsRoot: process.env.LOCAL_AI_RUNTIME_DATA_ROOT
    };
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "doctor") {
    await doctor(config);
  } else if (command === "inspect") {
    await inspect(config, args);
  } else if (command === "broker-demo") {
    brokerDemo(config);
  } else if (command === "company") {
    await runCompany(config, args);
  } else if (command === "coverage") {
    await runCoverage(config, args);
  } else if (command === "coverage-synthesize") {
    await runCoverageSynthesize(config, args);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
