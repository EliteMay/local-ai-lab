import { readFile } from "node:fs/promises";
import { LMStudioClient } from "./model/lm-studio-client.mjs";
import { RepoReader } from "./security/repo-reader.mjs";
import { TaskBroker } from "./core/task-broker.mjs";
import { AICompanyOrchestrator } from "./core/orchestrator.mjs";

async function loadConfig() {
  const url = new URL("../config/default.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}

function getOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp() {
  console.log(`local-ai-lab\n\nCommands:\n  doctor\n      Check LM Studio API and configured model.\n\n  inspect --repo <path> [--search <text>]\n      Read-only inspection of a local repository.\n\n  broker-demo\n      Exercise deterministic delegation without calling the model.\n\n  company --repo <path> --goal <text> [--run-id <id>]\n      Run the read-only AI Company orchestration against a local repository.\n      Current phase: repository evidence only; external web research is not implemented yet.\n`);
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

async function doctor(config) {
  const client = new LMStudioClient(config.model);
  const models = await client.listModels();
  const ids = models.map((item) => item.id).filter(Boolean);

  console.log(`LM Studio API: OK`);
  console.log(`Configured model: ${config.model.model}`);
  console.log(`Available models: ${ids.length ? ids.join(", ") : "none"}`);
  console.log(`Configured model loaded: ${ids.includes(config.model.model) ? "yes" : "no"}`);
  console.log(`Request timeout: ${Math.round((config.model.timeoutMs ?? 600000) / 1000)} seconds`);
  console.log(`Max output tokens: ${config.model.maxTokens ?? 2048}`);
}

async function inspect(config, args) {
  const repo = getOption(args, "--repo");
  if (!repo) {
    throw new Error("inspect requires --repo <path>");
  }

  const reader = new RepoReader(repo, config.repoReader);
  const files = await reader.listFiles();
  console.log(`Repository: ${repo}`);
  console.log(`Readable files: ${files.length}`);
  for (const file of files.slice(0, 30)) {
    console.log(`- ${file}`);
  }
  if (files.length > 30) {
    console.log(`... ${files.length - 30} more`);
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

async function runCompany(config, args) {
  const repo = getOption(args, "--repo");
  const goal = getOption(args, "--goal");
  const runId = getOption(args, "--run-id");
  if (!repo || !goal) {
    throw new Error("company requires --repo <path> and --goal <text>");
  }

  const client = new LMStudioClient(config.model);
  const models = await client.listModels();
  const modelIds = models.map((item) => item.id).filter(Boolean);
  if (!modelIds.includes(config.model.model)) {
    throw new Error(`Configured model is not loaded in LM Studio: ${config.model.model}`);
  }

  console.log(`AI Company model: ${config.model.model}`);
  console.log(`Per-request timeout: ${Math.round((config.model.timeoutMs ?? 600000) / 1000)}s / max output tokens: ${config.model.maxTokens ?? 2048}`);

  const orchestrator = new AICompanyOrchestrator({
    config,
    modelClient: client,
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

const args = process.argv.slice(2);
const command = args[0];

try {
  const config = await loadConfig();
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
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
