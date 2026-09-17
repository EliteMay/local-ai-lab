import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
  "synthesis-reduction.json"
]);

function isInside(root, target) {
  return target === root || target.startsWith(`${root}${sep}`);
}

export class RunStore {
  constructor(rootPath = "runtime-data/runs") {
    this.root = resolve(rootPath);
  }

  async createRun(metadata = {}) {
    const runId = metadata.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const directory = resolve(this.root, runId);
    if (!isInside(this.root, directory)) {
      throw new Error("Invalid run id");
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
      await access(resolve(this.root, runId, "run.json"));
      return true;
    } catch {
      return false;
    }
  }

  async writeJson(runId, fileName, value) {
    if (!ALLOWED_FILES.has(fileName) || !fileName.endsWith(".json")) {
      throw new Error(`RunStore cannot write file: ${fileName}`);
    }
    const path = this.#path(runId, fileName);
    await mkdir(resolve(this.root, runId), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  async readJson(runId, fileName) {
    if (!ALLOWED_FILES.has(fileName) || !fileName.endsWith(".json")) {
      throw new Error(`RunStore cannot read file: ${fileName}`);
    }
    return JSON.parse(await readFile(this.#path(runId, fileName), "utf8"));
  }

  async writeSummary(runId, markdown) {
    const path = this.#path(runId, "summary.md");
    await mkdir(resolve(this.root, runId), { recursive: true });
    await writeFile(path, String(markdown), "utf8");
  }

  #path(runId, fileName) {
    if (typeof runId !== "string" || runId.trim() === "") {
      throw new Error("runId is required");
    }
    if (!ALLOWED_FILES.has(fileName)) {
      throw new Error(`RunStore file is not allowed: ${fileName}`);
    }
    const target = resolve(this.root, runId, fileName);
    if (!isInside(this.root, target)) {
      throw new Error("Run path escapes runtime-data root");
    }
    return target;
  }
}
