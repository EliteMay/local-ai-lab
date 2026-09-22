import { access, mkdir, readdir } from "node:fs/promises";
import { atomicWriteJson, atomicWriteText, readJsonWithBackup, readTextWithBackup } from "./atomic-file.mjs";
import { resolve, sep } from "node:path";

const RUN_ID_PATTERN = /^run-[a-zA-Z0-9._-]+$/;

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

function isInside(root, target) {
  return target === root || target.startsWith(`${root}${sep}`);
}

export class RunStore {
  constructor(rootPath = "runtime-data/runs") {
    this.root = resolve(rootPath);
  }

  async createRun(metadata = {}) {
    const explicitRunId = metadata.runId ?? null;
    const runId = explicitRunId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const directory = this.#runDirectory(runId);

    if (explicitRunId && await this.hasRun(runId)) {
      const error = new Error("Run id already exists: " + runId);
      error.code = "RUN_ID_ALREADY_EXISTS";
      throw error;
    }

    await mkdir(directory, { recursive: true });
    await this.writeJson(runId, "run.json", {
      runId,
      createdAt: new Date().toISOString(),
      ...metadata
    });
    return runId;
  }

  async hasRun(runId) {
    try {
      await access(resolve(this.#runDirectory(runId), "run.json"));
      return true;
    } catch {
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

  #runDirectory(runId) {
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
      throw new Error("Invalid run id");
    }
    const directory = resolve(this.root, runId);
    if (!isInside(this.root, directory)) {
      throw new Error("Run path escapes runtime-data root");
    }
    return directory;
  }

  #path(runId, fileName) {
    if (!ALLOWED_FILES.has(fileName)) {
      throw new Error(`RunStore file is not allowed: ${fileName}`);
    }
    return resolve(this.#runDirectory(runId), fileName);
  }
}
