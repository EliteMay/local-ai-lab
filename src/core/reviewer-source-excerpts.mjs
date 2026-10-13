// Raw source excerpts help review, but do not prove semantic correctness.
const MAX_SPAN_LINES = 32;
const MAX_EXCERPT_CHARS = 1700;

function verifiedLines(chunks, file, first, last) {
  if (typeof file !== "string" || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)
    || first < 1 || last < first || last - first + 1 > MAX_SPAN_LINES) return null;
  const rows = new Map();
  for (const chunk of chunks) {
    if (chunk.path !== file || chunk.startLine > last || chunk.endLine < first) continue;
    for (const row of String(chunk.content ?? "").split("\n")) {
      const match = /^ *(\d+): (.*)$/.exec(row);
      if (!match) continue;
      const line = Number(match[1]);
      if (line >= first && line <= last) {
        // Long source lines may span chunks: reassemble their numbered pieces.
        rows.set(line, (rows.get(line) ?? "") + match[2]);
      }
    }
  }
  if (rows.size !== last - first + 1) return null;
  return Array.from({length: last - first + 1}, (_, i) => {
    const n = first + i;
    return n + ": " + rows.get(n);
  }).join("\n");
}

export function buildReviewerSourceExcerpts(findings, plan, {maxChars = 6000, maxEvidence = 40} = {}) {
  const chunks = Array.isArray(plan?.chunks) ? plan.chunks : [];
  const items = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    for (const ev of Array.isArray(finding?.evidence) ? finding.evidence : []) {
      const key = String(ev?.file ?? "?") + ":" + String(ev?.lineStart ?? "?") + "-" + String(ev?.lineEnd ?? "?");
      const lines = verifiedLines(chunks, ev?.file, ev?.lineStart, ev?.lineEnd);
      const text = lines && lines.length <= MAX_EXCERPT_CHARS
        ? "SOURCE " + key + "\n" + lines
        : "SOURCE " + key + "\n[unavailable or invalid source location]";
      items.push(text);
    }
  }
  const unique = [...new Set(items)];
  const accepted = [];
  let used = 0;
  let limited = false;
  for (const item of unique) {
    if (accepted.length >= maxEvidence || used + item.length + 2 > maxChars) {
      limited = true;
      break;
    }
    accepted.push(item);
    used += item.length + 2;
  }
  const unavailable = accepted.filter(x => x.includes("[unavailable or invalid source location]")).length;
  return {
    text: accepted.join("\n\n"),
    evidenceCount: items.length,
    excerptCount: accepted.length,
    unavailable,
    truncated: limited || accepted.length < unique.length
  };
}
