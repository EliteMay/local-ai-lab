const SEVERITY_ORDER = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

const CONFIDENCE_ORDER = {
  high: 3,
  medium: 2,
  low: 1
};

function findingList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.findings)) return value.findings;
  return [];
}

function countSeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    const key = String(finding?.severity || "").toLowerCase();
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

function compactFinding(finding) {
  const evidence = Array.isArray(finding?.evidence) ? finding.evidence[0] : null;
  return {
    id: finding?.id ?? null,
    severity: finding?.severity ?? "unknown",
    confidence: finding?.confidence ?? "unknown",
    title: String(finding?.title || "名称のない指摘"),
    evidence: evidence ? {
      file: evidence.file ?? null,
      lineStart: evidence.lineStart ?? null,
      lineEnd: evidence.lineEnd ?? null
    } : null
  };
}

export function buildRunOverview({
  run = {},
  coverage = {},
  findings = [],
  synthesis = {}
} = {}) {
  const list = findingList(findings);
  const severity = countSeverity(list);
  const topFindings = [...list]
    .sort((left, right) => {
      const severityDiff = (SEVERITY_ORDER[right?.severity] ?? 0) - (SEVERITY_ORDER[left?.severity] ?? 0);
      if (severityDiff !== 0) return severityDiff;
      return (CONFIDENCE_ORDER[right?.confidence] ?? 0) - (CONFIDENCE_ORDER[left?.confidence] ?? 0);
    })
    .slice(0, 3)
    .map(compactFinding);

  return {
    status: run.status || coverage.status || (coverage.complete ? "COMPLETED" : "UNKNOWN"),
    coveragePercent: Number.isFinite(Number(coverage.coveragePercent))
      ? Number(coverage.coveragePercent)
      : null,
    auditableFiles: Number.isFinite(Number(coverage.auditableFiles))
      ? Number(coverage.auditableFiles)
      : null,
    excludedFiles: Number.isFinite(Number(coverage.excludedFiles))
      ? Number(coverage.excludedFiles)
      : null,
    completedChunks: Number.isFinite(Number(coverage.completedChunks))
      ? Number(coverage.completedChunks)
      : null,
    totalChunks: Number.isFinite(Number(coverage.totalChunks))
      ? Number(coverage.totalChunks)
      : null,
    findingCount: list.length,
    severity,
    modelUsage: Array.isArray(run.modelRouting?.models)
      ? run.modelRouting.models.map((item) => ({
          modelId: item.modelId ?? null,
          label: item.label ?? item.modelId ?? "不明",
          calls: Number(item.calls) || 0,
          failures: Number(item.failures) || 0,
          durationMs: Number(item.durationMs) || 0
        }))
      : [],
    topFindings,
    reviewerDecision:
      run.reviewerDecision ||
      synthesis?.reviewer?.result?.decision ||
      synthesis?.reviewer?.decision ||
      null
  };
}
