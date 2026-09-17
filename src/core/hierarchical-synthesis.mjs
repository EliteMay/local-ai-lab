import { SYNTHESIS_REDUCTION_SCHEMA } from "./response-schemas.mjs";

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

function unique(values) {
  return [...new Set(values)];
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function highestSeverity(items) {
  return items.reduce((best, item) => (
    (SEVERITY_RANK[item.severity] ?? 0) > (SEVERITY_RANK[best] ?? 0) ? item.severity : best
  ), "low");
}

function conservativeConfidence(items) {
  return items.reduce((lowest, item) => (
    (CONFIDENCE_RANK[item.confidence] ?? 0) < (CONFIDENCE_RANK[lowest] ?? 0) ? item.confidence : lowest
  ), "high");
}

function evidenceKey(item) {
  return `${item.file}:${item.lineStart}:${item.lineEnd}:${item.claim}`;
}

function representativeEvidence(items, limit = 2) {
  const result = [];
  const seen = new Set();
  const ordered = [...items].sort((a, b) => (
    (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
    || (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0)
  ));

  for (const item of ordered) {
    for (const evidence of item.evidence ?? []) {
      const key = evidenceKey(evidence);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(evidence);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function originalItem(finding) {
  return {
    id: finding.id,
    severity: finding.severity ?? "low",
    title: finding.title ?? finding.id,
    confidence: finding.confidence ?? "low",
    evidence: finding.evidence ?? [],
    sourceFindingIds: [finding.id]
  };
}

function promptItem(item) {
  return {
    id: item.id,
    severity: item.severity,
    title: item.title,
    confidence: item.confidence,
    evidence: (item.evidence ?? []).slice(0, 2)
  };
}

function promptChars(items) {
  return JSON.stringify(items.map(promptItem)).length;
}

function packByChars(items, maxChars) {
  const groups = [];
  let current = [];

  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };

  for (const item of items) {
    const candidate = [...current, item];
    if (current.length && promptChars(candidate) > maxChars) flush();
    current.push(item);
  }
  flush();
  return groups;
}

function renderReductionPrompt({ goal, level, groupId, items, correction = false }) {
  const ids = items.map((item) => item.id);
  return `Goal:\n${goal}\n\nYou are reducing audit findings for hierarchical synthesis. Group related findings into at most 8 concise themes. This is classification only: do not invent, rewrite, or add evidence.\n\nLevel: ${level}\nGroup: ${groupId}\nRequired inputItemIds (copy exactly):\n${ids.join("\n")}\n\nRules:\n- Every required ID must appear exactly once across cluster memberIds.\n- Do not drop any finding, even if low severity or uncertain.\n- Only group findings that can share a useful improvement theme.\n- Cluster title must be a short neutral description, not a fix implementation.\n- Return only the required structured response.\n${correction ? "- Previous response failed partition validation; correct the IDs and keep the response smaller.\n" : ""}\nInput findings:\n${JSON.stringify(items.map(promptItem))}\n\n/no_think`;
}

function validatePartition(result, items) {
  const expected = items.map((item) => item.id);
  if (!sameStringSet(result.inputItemIds, expected)) {
    throw new Error("Synthesis reducer did not acknowledge every input item");
  }

  const memberIds = result.clusters.flatMap((cluster) => cluster.memberIds ?? []);
  if (!sameStringSet(memberIds, expected)) {
    throw new Error("Synthesis reducer clusters do not partition every input item exactly once");
  }
}

function materializeClusters({ clusters, items, level, groupIndex }) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return clusters.map((cluster, clusterIndex) => {
    const members = cluster.memberIds.map((id) => byId.get(id)).filter(Boolean);
    return {
      id: `synth-L${level}-G${String(groupIndex + 1).padStart(3, "0")}-C${String(clusterIndex + 1).padStart(2, "0")}`,
      severity: highestSeverity(members),
      title: cluster.title,
      confidence: conservativeConfidence(members),
      evidence: representativeEvidence(members),
      sourceFindingIds: unique(members.flatMap((item) => item.sourceFindingIds ?? [item.id]))
    };
  });
}

async function reduceGroup({ modelClient, goal, level, groupIndex, items, maxTokens, temperature, onProgress, depth = 0 }) {
  if (items.length === 1) return { items, calls: [] };

  const groupId = `L${level}-G${String(groupIndex + 1).padStart(3, "0")}${depth ? `-D${depth}` : ""}`;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      onProgress?.({ type: "synthesis_group_started", level, groupId, items: items.length, chars: promptChars(items) });
      const detailed = await modelClient.chatJsonDetailed({
        system: "You are a finding-clustering worker. Classify existing evidence-backed findings into compact themes without adding facts.",
        user: renderReductionPrompt({ goal, level, groupId, items, correction: attempt > 1 }),
        jsonSchema: SYNTHESIS_REDUCTION_SCHEMA,
        maxTokens,
        temperature
      });
      validatePartition(detailed.value, items);
      const reduced = materializeClusters({ clusters: detailed.value.clusters, items, level, groupIndex });
      onProgress?.({
        type: "synthesis_group_completed",
        level,
        groupId,
        inputItems: items.length,
        outputItems: reduced.length,
        model: detailed.meta
      });
      return { items: reduced, calls: [detailed.meta] };
    } catch (error) {
      lastError = error;
      if (error?.code === "OUTPUT_TOKEN_LIMIT" && items.length > 2) {
        const midpoint = Math.ceil(items.length / 2);
        onProgress?.({
          type: "synthesis_group_split",
          level,
          groupId,
          leftItems: midpoint,
          rightItems: items.length - midpoint,
          reason: error.message
        });
        const left = await reduceGroup({
          modelClient, goal, level, groupIndex, items: items.slice(0, midpoint), maxTokens, temperature, onProgress, depth: depth + 1
        });
        const right = await reduceGroup({
          modelClient, goal, level, groupIndex, items: items.slice(midpoint), maxTokens, temperature, onProgress, depth: depth + 1
        });
        return { items: [...left.items, ...right.items], calls: [...left.calls, ...right.calls] };
      }
      if (attempt === 1) {
        onProgress?.({ type: "synthesis_group_retry", level, groupId, error: error.message });
        continue;
      }
    }
  }

  throw lastError ?? new Error(`Synthesis reduction failed for ${groupId}`);
}

export async function reduceFindingsHierarchically({
  modelClient,
  goal,
  findings,
  targetChars = 24000,
  groupChars = 9000,
  maxTokens = 900,
  temperature = 0.1,
  maxLevels = 6,
  onProgress = null,
  onLevelCheckpoint = null
}) {
  if (!Array.isArray(findings)) throw new Error("findings must be an array");
  if (findings.some((finding) => typeof finding?.id !== "string" || !finding.id)) {
    throw new Error("Every finding requires a stable id for hierarchical synthesis");
  }

  const originalIds = findings.map((finding) => finding.id);
  let current = findings.map(originalItem);
  const levels = [];

  if (JSON.stringify(current).length <= targetChars) {
    return { findings: current, levels, originalFindingIds: originalIds, reduced: false };
  }

  for (let level = 1; level <= maxLevels; level += 1) {
    const beforeChars = JSON.stringify(current).length;
    const groups = packByChars(current, groupChars);
    const next = [];
    const calls = [];

    onProgress?.({ type: "synthesis_level_started", level, inputItems: current.length, groups: groups.length, chars: beforeChars });

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const reduced = await reduceGroup({
        modelClient,
        goal,
        level,
        groupIndex,
        items: groups[groupIndex],
        maxTokens,
        temperature,
        onProgress
      });
      next.push(...reduced.items);
      calls.push(...reduced.calls);
    }

    const coveredOriginalIds = unique(next.flatMap((item) => item.sourceFindingIds));
    if (!sameStringSet(coveredOriginalIds, originalIds)) {
      throw new Error("Hierarchical synthesis lost or duplicated source finding coverage");
    }

    const afterChars = JSON.stringify(next).length;
    const levelResult = {
      level,
      inputItems: current.length,
      outputItems: next.length,
      inputChars: beforeChars,
      outputChars: afterChars,
      groups: groups.length,
      modelCalls: calls.length
    };
    levels.push(levelResult);
    current = next;

    onProgress?.({ type: "synthesis_level_completed", ...levelResult });
    await onLevelCheckpoint?.({ findings: current, levels: [...levels], originalFindingIds: originalIds, reduced: true });

    if (afterChars <= targetChars) {
      return { findings: current, levels, originalFindingIds: originalIds, reduced: true };
    }

    if (next.length >= levelResult.inputItems && afterChars >= Math.floor(beforeChars * 0.98)) {
      throw new Error(`Hierarchical synthesis made no useful reduction at level ${level} (${beforeChars} -> ${afterChars} chars)`);
    }
  }

  throw new Error(`Hierarchical synthesis still exceeds target after ${maxLevels} levels`);
}
