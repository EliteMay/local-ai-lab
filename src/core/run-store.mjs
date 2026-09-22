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

export function assertRunId(value) {
  const runId = String(value || "");
  if (!RUN_ID_PATTERN.test(runId)) {
    const error = new Error("Invalid run id");
    error.code = "INVALID_RUN_ID";
    throw error;
  }
  return runId;
}

function runAlreadyExistsError(runId) {
  const error = new Error(`Run already exists: ${runId}`);
  error.code = "RUN_ID_ALREADY_EXISTS";
  error.runId = runId;
  return error;
}

export class RunStore {
  constructor(rootPath = "runtime-data/runs") {
    this.root = resolve(rootPath);
  }

  async createRun(metadata = {}) {
    const explicitRunId = metadata.runId == null ? null : assertRunId(metadata.runId);
    const runId = explicitRunId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const directory = this.#runDirectory(runId);

    await mkdir(this.root, { recursive: true });
    try {
      await mkdir(directory);
    } catch (error) {
      if (error?.code === "EEXIST") throw runAlreadyExistsError(runId);
      throw error;
    }

    const { runId: _ignoredRunId, createdAt: _ignoredCreatedAt, ...rest } = metadata;
    await this.writeJson(runId, "run.json", {
      ...rest,
      runId,
      createdAt: new Date().toISOString()
    });
    return runId;
  }

  async hasRun(runId) {
    const id = assertRunId(runId);
    try {
      await access(resolve(this.#runDirectory(id), "run.json"));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async listRunIds() {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
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
    const id = assertRunId(runId);
    const path = this.#path(id, fileName);
    await mkdir(this.#runDirectory(id), { recursive: true });
    await atomicWriteJson(path, value);
  }

  async readJson(runId, fileName) {
    if (!ALLOWED_FILES.has(fileName) || !fileName.endsWith(".json")) {
      throw new Error(`RunStore cannot read file: ${fileName}`);
    }
    return readJsonWithBackup(this.#path(assertRunId(runId), fileName));
  }

  async writeSummary(runId, markdown) {
    const id = assertRunId(runId);
    const path = this.#path(id, "summary.md");
    await mkdir(this.#runDirectory(id), { recursive: true });
    await atomicWriteText(path, String(markdown));
  }

  async readSummary(runId) {
    return readTextWithBackup(this.#path(assertRunId(runId), "summary.md"));
  }

  #runDirectory(runId) {
    const id = assertRunId(runId);
    const directory = resolve(this.root, id);
    if (!isInside(this.root, directory)) {
      const error = new Error("Run path escapes runtime-data root");
      error.code = "INVALID_RUN_ID";
      throw error;
    }
    return directory;
  }

  #path(runId, fileName) {
    if (!ALLOWED_FILES.has(fileName)) {
      throw new Error(`RunStore file is not allowed: ${fileName}`);
    }
    const directory = this.#runDirectory(runId);
    const target = resolve(directory, fileName);
    if (!isInside(directory, target)) {
      throw new Error("Run path escapes runtime-data root");
    }
    return target;
  }
}
