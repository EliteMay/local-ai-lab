import { createHash } from "node:crypto";
import { compareResumeIdentity } from "./run-identity.mjs";

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function normalizeRepositoryPath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function normalizeGoal(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function batchChunkIds(batch) {
  if (Array.isArray(batch?.chunkIds)) return batch.chunkIds;
  if (Array.isArray(batch?.chunks)) return batch.chunks.map((chunk) => chunk.id).filter(Boolean);
  return [];
}

function chunkIdentityMap(plan) {
  const map = new Map();
  for (const file of plan?.files ?? []) {
    for (const chunkId of file?.chunks ?? []) {
      map.set(chunkId, {
        id: chunkId,
        path: String(file.path || ""),
        fileSha256: String(file.sha256 || "")
      });
    }
  }
  return map;
}

export function coverageBatchFingerprint(plan, batch) {
  const identities = chunkIdentityMap(plan);
  const chunks = batchChunkIds(batch);
  if (!chunks.length) return null;

  const payload = [];
  for (const chunkId of chunks) {
    const identity = identities.get(chunkId);
    if (!identity?.path || !identity?.fileSha256) return null;
    payload.push(identity);
  }
  return sha256(JSON.stringify(payload));
}

export function buildReusableBatchIndex(savedPlan, savedResults, sourceRunId) {
  const byId = new Map((savedPlan?.batches ?? []).map((batch) => [batch.id, batch]));
  const index = new Map();

  for (const result of savedResults ?? []) {
    if (result?.status !== "completed") continue;
    const batch = byId.get(result.batchId);
    if (!batch) continue;
    const fingerprint = coverageBatchFingerprint(savedPlan, batch);
    if (!fingerprint || index.has(fingerprint)) continue;
    index.set(fingerprint, {
      sourceRunId,
      sourceBatchId: result.batchId,
      result
    });
  }

  return index;
}

export async function findReusableCoverageBaseline({
  runStore,
  repoPath,
  goal,
  executionIdentity,
  maxRuns = 40
} = {}) {
  if (!runStore || typeof runStore.listRunIds !== "function") return null;

  const targetRepo = normalizeRepositoryPath(repoPath);
  const targetGoal = normalizeGoal(goal);
  if (!targetRepo || !targetGoal) return null;

  const candidates = [];
  for (const runId of (await runStore.listRunIds()).slice(0, maxRuns)) {
    try {
      const run = await runStore.readJson(runId, "run.json");
      if (run?.status === "RUNNING") continue;
      if (run?.mode !== "full-coverage-audit") continue;
      if (normalizeRepositoryPath(run.repoPath) !== targetRepo) continue;
      if (normalizeGoal(run.goal) !== targetGoal) continue;
      if (!compareResumeIdentity(run.executionIdentity, executionIdentity).ok) continue;

      const [plan, results] = await Promise.all([
        runStore.readJson(runId, "coverage-plan.json"),
        runStore.readJson(runId, "batch-results.json")
      ]);
      const reusable = buildReusableBatchIndex(plan, results, runId);
      if (!reusable.size) continue;

      candidates.push({
        runId,
        run,
        plan,
        results,
        reusable,
        sortTime: Date.parse(run.completedAt || run.interruptedAt || run.createdAt || "") || 0
      });
    } catch {
      // A broken historical run must not block a new audit.
    }
  }

  candidates.sort((left, right) => right.sortTime - left.sortTime);
  return candidates[0] ?? null;
}
