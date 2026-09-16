import { createHash } from "node:crypto";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function classifyReadError(error) {
  const message = String(error?.message ?? error);
  if (message.startsWith("Binary file rejected:")) return "binary";
  if (message.startsWith("File exceeds read limit:")) return "oversized";
  if (message.startsWith("Sensitive file blocked:")) return "sensitive";
  return "unreadable";
}

function numberedLine(line, lineNumber) {
  return `${String(lineNumber).padStart(6, " ")}: ${line}`;
}

function splitLongNumberedLine(line, lineNumber, maxChunkChars) {
  const prefix = `${String(lineNumber).padStart(6, " ")}: `;
  const available = Math.max(1, maxChunkChars - prefix.length - 20);
  const parts = [];
  for (let offset = 0; offset < line.length; offset += available) {
    parts.push(`${prefix}${line.slice(offset, offset + available)}`);
  }
  return parts.length ? parts : [prefix];
}

export function splitFileIntoChunks(path, text, { maxChunkChars = 8000 } = {}) {
  const lines = String(text).split(/\r?\n/);
  const chunks = [];
  let buffer = [];
  let chars = 0;
  let startLine = 1;
  let endLine = 1;
  let part = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    part += 1;
    const content = buffer.join("\n");
    chunks.push({
      id: `${path}#L${startLine}-L${endLine}-P${part}`,
      path,
      startLine,
      endLine,
      part,
      chars: content.length,
      content
    });
    buffer = [];
    chars = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const renderedParts = numberedLine(lines[index], lineNumber).length <= maxChunkChars
      ? [numberedLine(lines[index], lineNumber)]
      : splitLongNumberedLine(lines[index], lineNumber, maxChunkChars);

    for (const rendered of renderedParts) {
      const additional = rendered.length + (buffer.length ? 1 : 0);
      if (buffer.length > 0 && chars + additional > maxChunkChars) {
        flush();
      }
      if (buffer.length === 0) startLine = lineNumber;
      buffer.push(rendered);
      chars += rendered.length + (buffer.length > 1 ? 1 : 0);
      endLine = lineNumber;
    }
  }

  flush();
  return chunks;
}

function packBatches(chunks, maxBatchChars) {
  const batches = [];
  let current = [];
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const index = batches.length + 1;
    batches.push({
      id: `batch-${String(index).padStart(4, "0")}`,
      chunks: current,
      chars
    });
    current = [];
    chars = 0;
  };

  for (const chunk of chunks) {
    if (current.length > 0 && chars + chunk.chars > maxBatchChars) {
      flush();
    }
    current.push(chunk);
    chars += chunk.chars;
  }
  flush();
  return batches;
}

export async function buildCoveragePlan(reader, options = {}) {
  const maxChunkChars = options.maxChunkChars ?? 8000;
  const maxBatchChars = options.maxBatchChars ?? 18000;
  const inventory = typeof reader.listFilesDetailed === "function"
    ? await reader.listFilesDetailed()
    : { files: await reader.listFiles(), truncated: false };

  if (inventory.truncated) {
    throw new Error(`Repository inventory exceeded maxFiles=${reader.maxFiles}; refusing to claim full coverage`);
  }

  const files = [];
  const excluded = [];
  const chunks = [];

  for (const path of inventory.files) {
    try {
      const text = await reader.readTextFile(path);
      const fileChunks = splitFileIntoChunks(path, text, { maxChunkChars });
      files.push({
        path,
        sha256: sha256(text),
        chars: text.length,
        lines: text.split(/\r?\n/).length,
        chunks: fileChunks.map((chunk) => chunk.id)
      });
      chunks.push(...fileChunks);
    } catch (error) {
      excluded.push({
        path,
        reason: classifyReadError(error),
        detail: String(error?.message ?? error)
      });
    }
  }

  const batches = packBatches(chunks, maxBatchChars);
  return {
    createdAt: new Date().toISOString(),
    inventoryFiles: inventory.files.length,
    auditableFiles: files.length,
    excludedFiles: excluded.length,
    totalChunks: chunks.length,
    totalBatches: batches.length,
    maxChunkChars,
    maxBatchChars,
    files,
    excluded,
    chunks,
    batches
  };
}

export function publicCoveragePlan(plan) {
  return {
    createdAt: plan.createdAt,
    inventoryFiles: plan.inventoryFiles,
    auditableFiles: plan.auditableFiles,
    excludedFiles: plan.excludedFiles,
    totalChunks: plan.totalChunks,
    totalBatches: plan.totalBatches,
    maxChunkChars: plan.maxChunkChars,
    maxBatchChars: plan.maxBatchChars,
    files: plan.files,
    excluded: plan.excluded,
    batches: plan.batches.map((batch) => ({
      id: batch.id,
      chars: batch.chars,
      chunks: batch.chunks.map((chunk) => ({
        id: chunk.id,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        chars: chunk.chars
      }))
    }))
  };
}
