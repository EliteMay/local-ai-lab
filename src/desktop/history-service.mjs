import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { isValidRunId } from "./command-spec.mjs";

function inside(root, target) {
  return target === root || target.startsWith(`${root}${sep}`);
}

async function readJsonOptional(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readTextOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function runPath(root, runId) {
  if (!isValidRunId(runId)) throw new Error("Invalid run id");
  const target = resolve(root, runId);
  if (!inside(root, target)) throw new Error("Run path escapes history root");
  return target;
}

function resultText({ summary, synthesis, findings, review }) {
  const sections = [];
  if (summary.trim()) sections.push(summary.trim());

  const planner = synthesis?.planner?.result;
  if (planner) {
    sections.push(`## Improvement Planner\n\n${JSON.stringify(planner, null, 2)}`);
  } else if (Array.isArray(findings) && findings.length > 0) {
    sections.push(`## Findings\n\n${JSON.stringify(findings, null, 2)}`);
  }

  const reviewer = review?.result ?? synthesis?.reviewer?.result;
  if (reviewer) sections.push(`## Reviewer\n\n${JSON.stringify(reviewer, null, 2)}`);
  return sections.join("\n\n").trim();
}

export async function listRuns(appRoot) {
  const root = resolve(appRoot, "runtime-data", "runs");
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    const directory = runPath(root, entry.name);
    const [run, coverage, findings, info] = await Promise.all([
      readJsonOptional(resolve(directory, "run.json")),
      readJsonOptional(resolve(directory, "coverage.json")),
      readJsonOptional(resolve(directory, "findings.json")),
      stat(directory).catch(() => null),
    ]);
    if (!run) continue;
    const timestamp = run.completedAt ?? run.createdAt ?? info?.mtime?.toISOString?.() ?? null;
    runs.push({
      runId: entry.name,
      status: run.status ?? "UNKNOWN",
      mode: run.mode ?? "unknown",
      goal: run.goal ?? "",
      repository: run.repoPath ?? "",
      completedAt: run.completedAt ?? null,
      timestamp,
      coveragePercent: run.coverage?.coveragePercent ?? coverage?.coveragePercent ?? null,
      completedChunks: run.coverage?.completedChunks ?? coverage?.completedChunks ?? null,
      totalChunks: run.coverage?.totalChunks ?? coverage?.totalChunks ?? null,
      findings: Array.isArray(findings) ? findings.length : null,
      reviewerDecision: run.reviewerDecision ?? null,
      resumable: run.mode === "full-coverage-audit" && run.status !== "COMPLETED" && Boolean(run.repoPath && run.goal),
    });
  }

  runs.sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
  return runs;
}

export async function readRunResult(appRoot, runId) {
  const root = resolve(appRoot, "runtime-data", "runs");
  const directory = runPath(root, runId);
  const [run, coverage, findings, synthesis, review, summary] = await Promise.all([
    readJsonOptional(resolve(directory, "run.json")),
    readJsonOptional(resolve(directory, "coverage.json")),
    readJsonOptional(resolve(directory, "findings.json")),
    readJsonOptional(resolve(directory, "synthesis.json")),
    readJsonOptional(resolve(directory, "review.json")),
    readTextOptional(resolve(directory, "summary.md")),
  ]);
  if (!run) throw new Error(`Run not found: ${runId}`);

  return {
    runId,
    run,
    coverage,
    findings: Array.isArray(findings) ? findings : [],
    synthesis,
    review,
    text: resultText({ summary, synthesis, findings, review }),
  };
}
