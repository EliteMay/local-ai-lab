const DEFAULT_TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".html", ".css", ".scss", ".yml", ".yaml", ".toml", ".ini", ".xml", ".py",
  ".java", ".cs", ".go", ".rs", ".php", ".rb", ".sh", ".ps1", ".sql"
]);

const ROOT_PRIORITY = new Map([
  ["REQUIREMENTS.md", 100],
  ["README.md", 95],
  ["PROJECT_LEARNINGS.md", 92],
  ["AGENTS.md", 90],
  ["package.json", 88],
  ["pyproject.toml", 88],
  ["Cargo.toml", 88],
  ["go.mod", 88],
  ["pom.xml", 86]
]);

function extensionOf(path) {
  const name = path.toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

function scorePath(path) {
  if (ROOT_PRIORITY.has(path)) return ROOT_PRIORITY.get(path);
  const lower = path.toLowerCase();
  let score = 0;
  if (lower.startsWith("src/")) score += 60;
  if (lower.startsWith("app/")) score += 58;
  if (lower.startsWith("lib/")) score += 55;
  if (lower.startsWith("tests/") || lower.startsWith("test/")) score += 50;
  if (lower.includes("config")) score += 35;
  if (lower.includes("security")) score += 30;
  if (lower.includes("auth")) score += 25;
  if (lower.endsWith(".md")) score += 20;
  score -= Math.min(path.split("/").length * 2, 20);
  return score;
}

function lineNumbered(text) {
  return text
    .split(/\r?\n/)
    .map((line, index) => `${String(index + 1).padStart(4, " ")}: ${line}`)
    .join("\n");
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 80))}\n... [truncated by context budget]`, truncated: true };
}

export async function buildRepositoryContext(reader, options = {}) {
  const maxFiles = options.maxFiles ?? 12;
  const maxChars = options.maxChars ?? 32000;
  const maxFileChars = options.maxFileChars ?? 6000;
  const allowedExtensions = new Set(options.textExtensions ?? DEFAULT_TEXT_EXTENSIONS);

  const manifest = await reader.listFiles();
  const candidates = manifest
    .filter((path) => ROOT_PRIORITY.has(path) || allowedExtensions.has(extensionOf(path)))
    .sort((a, b) => scorePath(b) - scorePath(a) || a.localeCompare(b));

  const documents = [];
  let usedChars = 0;

  for (const path of candidates) {
    if (documents.length >= maxFiles || usedChars >= maxChars) break;
    try {
      const raw = await reader.readTextFile(path);
      const numbered = lineNumbered(raw);
      const remaining = maxChars - usedChars;
      const budget = Math.min(maxFileChars, remaining);
      if (budget <= 100) break;
      const clipped = truncate(numbered, budget);
      documents.push({ path, content: clipped.text, truncated: clipped.truncated });
      usedChars += clipped.text.length;
    } catch {
      // Binary, oversized, blocked, or unreadable files are omitted from model context.
    }
  }

  return {
    manifest,
    documents,
    coverage: {
      manifestFiles: manifest.length,
      includedFiles: documents.length,
      includedChars: usedChars,
      omittedCandidateFiles: Math.max(0, candidates.length - documents.length)
    }
  };
}
