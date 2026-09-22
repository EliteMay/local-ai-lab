import { access, mkdir, readdir } from "node:fs/promises";
import { atomicWriteJson, atomicWriteText, readJsonWithBackup, readTextWithBackup } from "./atomic-file.mjs";
import { resolve, sep } from "node:path";

const ALLOWED_FILES = new Set([
  "run.json",
  "tasks.json",
  "findings.json",
  "research.json",
  "review.json",
  "summary.md",
  "coverage-plan.json",
  "batch-results.json",
  "coverage.json",
  "synthesis.json",
  "synthesis-reduction.json",
  "model-usage.json"
]);

const RUN_ID_PATTERN = /^run-[a-zA-Z0-9._-]+$/;

function isInside(root, target) {
  return target === root || target.startsWith(`${root}${sep}`);
}

export function validateRunId(value) {
  const runId = String(value || "");
  if (!RUN_ID_PATTERN.test(runId)) {
    const error = new Error("Invalid run id");
    error.code = "INVALID_RUN_ID";
    throw error;
  }
  return runId;
}

export class RunStore {
  constructor(rootPath = "runtime-data/runs") {
    this.root = resolve(rootPath);
  }

  async createRun(metadata = {}) {
    const runId = validateRunId(metadata.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    const directory = this.#directory(runId);
    await mkdir(this.root, { recursive: true });
    try {
      await mkdir(directory, { recursive: false });
    } catch (error) {
      if (error?.code === "EEXIST") {
        const conflict = new Error(`Run already exists: ${runId}`);
        conflict.code = "RUN_ID_ALREADY_EXISTS";
        throw conflict;
      }
      throw error;
    }

    await this.writeJson(runId, "run.json", {
      ...metadata,
      runId,
      createdAt: new Date().toISOString()
    });
    return runId;
  }

  async hasRun(runId) {
    try {
      await access(this.#path(runId, "run.json"));
      return true;
    } catch (error) {
      if (error?.code === "INVALID_RUN_ID") throw error;
      return false;
    }
  }

  async listRunIds() {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && /^run-[a-zA-Z0-9._-]+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async writeJson(runId, fileName, value) {
    if (!ALLOWED_FILES.has(fileName) || !fileName.endsWith(".json")) {
      throw new Error(`RunStore cannot write file: ${fileName}`);
    }
    const path = this.#path(runId, fileName);
    await mkdir(resolve(this.root, runId), { recursive: true });
    await atomicWriteJson(path, value);
  }

  async readJson(runId, fileName) {
    if (!ALLOWED_FILES.has(fileName) || !fileName.endsWith(".json")) {
      throw new Error(`RunStore cannot read file: ${fileName}`);
    }
    return readJsonWithBackup(this.#path(runId, fileName));
  }

  async writeSummary(runId, markdown) {
    const path = this.#path(runId, "summary.md");
    await mkdir(resolve(this.root, runId), { recursive: true });
    await atomicWriteText(path, String(markdown));
  }

  async readSummary(runId) {
    return readTextWithBackup(this.#path(runId, "summary.md"));
  }

  #directory(runId) {
    const id = validateRunId(runId);
    const directory = resolve(this.root, id);
    if (!isInside(this.root, directory)) {
      throw new Error("Run path escapes runtime-data root");
    }
    return directory;
  }

  #path(runId, fileName) {
    if (!ALLOWED_FILES.has(fileName)) {
      throw new Error(`RunStore file is not allowed: ${fileName}`);
    }
    const target = resolve(this.#directory(runId), fileName);
    if (!isInside(this.root, target)) {
      throw new Error("Run path escapes runtime-data root");
    }
    return target;
  }
}
