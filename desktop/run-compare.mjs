const SEVERITIES = ["critical", "high", "medium", "low"];

function findings(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.findings)) return value.findings;
  return [];
}

function normalizedText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function primaryEvidence(finding) {
  return Array.isArray(finding?.evidence) ? finding.evidence[0] ?? null : null;
}

export function findingComparisonKey(finding) {
  const evidence = primaryEvidence(finding);
  const file = normalizedText(evidence?.file);
  const lineStart = Number.isFinite(Number(evidence?.lineStart)) ? Number(evidence.lineStart) : "";
  const title = normalizedText(finding?.title);
  if (file || lineStart !== "") return [file, lineStart, title].join("|");
  return [normalizedText(finding?.id), title].join("|");
}

function severityCounts(list) {
  const result = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const item of list) {
    const key = normalizedText(item?.severity);
    if (key in result) result[key] += 1;
  }
  return result;
}

function compactFinding(finding) {
  const evidence = primaryEvidence(finding);
  return {
    id: finding?.id ?? null,
    title: String(finding?.title || "名称のない指摘"),
    severity: normalizedText(finding?.severity) || "unknown",
    confidence: normalizedText(finding?.confidence) || "unknown",
    evidence: evidence ? {
      file: evidence.file ?? null,
      lineStart: evidence.lineStart ?? null,
      lineEnd: evidence.lineEnd ?? null
    } : null
  };
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function modelCalls(details) {
  const models = details?.modelUsage?.models;
  if (!Array.isArray(models)) return null;
  return models.reduce((sum, item) => sum + (Number(item?.calls) || 0), 0);
}

function elapsedMs(details) {
  const start = Date.parse(details?.run?.createdAt || "");
  const end = Date.parse(details?.run?.completedAt || details?.run?.interruptedAt || "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function repoPath(details) {
  return String(details?.run?.repoPath || "");
}

export function compareRunDetails(baseline, current) {
  if (!baseline?.runId || !current?.runId) throw new Error("比較する実行履歴が不足しています");
  const baselineRepo = repoPath(baseline);
  const currentRepo = repoPath(current);
  if (baselineRepo && currentRepo && baselineRepo !== currentRepo) {
    throw new Error("別の対象フォルダの実行履歴は比較できません");
  }

  const before = findings(baseline.findings);
  const after = findings(current.findings);
  const beforeMap = new Map(before.map((item) => [findingComparisonKey(item), item]));
  const afterMap = new Map(after.map((item) => [findingComparisonKey(item), item]));

  const added = [];
  const resolved = [];
  const persisting = [];

  for (const [key, item] of afterMap) {
    if (beforeMap.has(key)) persisting.push(compactFinding(item));
    else added.push(compactFinding(item));
  }
  for (const [key, item] of beforeMap) {
    if (!afterMap.has(key)) resolved.push(compactFinding(item));
  }

  const beforeSeverity = severityCounts(before);
  const afterSeverity = severityCounts(after);
  const severityDelta = Object.fromEntries(
    SEVERITIES.map((key) => [key, afterSeverity[key] - beforeSeverity[key]])
  );

  const baselineCoverage = numeric(baseline?.coverage?.coveragePercent);
  const currentCoverage = numeric(current?.coverage?.coveragePercent);
  const baselineCalls = modelCalls(baseline);
  const currentCalls = modelCalls(current);
  const baselineDurationMs = elapsedMs(baseline);
  const currentDurationMs = elapsedMs(current);

  return {
    schemaVersion: 1,
    baseline: {
      runId: baseline.runId,
      repoPath: baselineRepo,
      status: baseline?.run?.status || baseline?.coverage?.status || null,
      findingCount: before.length,
      coveragePercent: baselineCoverage,
      modelCalls: baselineCalls,
      durationMs: baselineDurationMs
    },
    current: {
      runId: current.runId,
      repoPath: currentRepo,
      status: current?.run?.status || current?.coverage?.status || null,
      findingCount: after.length,
      coveragePercent: currentCoverage,
      modelCalls: currentCalls,
      durationMs: currentDurationMs
    },
    delta: {
      findingCount: after.length - before.length,
      coveragePercent: baselineCoverage == null || currentCoverage == null
        ? null
        : currentCoverage - baselineCoverage,
      modelCalls: baselineCalls == null || currentCalls == null ? null : currentCalls - baselineCalls,
      durationMs: baselineDurationMs == null || currentDurationMs == null
        ? null
        : currentDurationMs - baselineDurationMs,
      severity: severityDelta
    },
    added,
    resolved,
    persisting
  };
}
