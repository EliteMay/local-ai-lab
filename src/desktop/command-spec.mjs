import { resolve } from "node:path";

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const RUN_ID_PATTERN = /^run-[A-Za-z0-9._-]+$/;

function requireString(value, name, maxLength = 10000) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${name} is too long`);
  return trimmed;
}

function profileArgs(modelProfile) {
  if (!modelProfile || modelProfile === "default") return [];
  if (!PROFILE_PATTERN.test(modelProfile)) throw new Error("Invalid model profile");
  return ["--model-profile", modelProfile];
}

function runIdArg(runId) {
  const value = requireString(runId, "runId", 180);
  if (!RUN_ID_PATTERN.test(value)) throw new Error("Invalid run id");
  return value;
}

export function buildCommandSpec({
  command,
  appRoot,
  modelProfile = "default",
  repository = null,
  goal = null,
  search = null,
  runId = null,
} = {}) {
  const cwd = resolve(requireString(appRoot, "appRoot", 1000));
  const entry = resolve(cwd, "src", "index.mjs");
  const profile = profileArgs(modelProfile);

  if (command === "doctor") {
    return { cwd, args: [entry, "doctor", ...profile] };
  }

  if (command === "inspect") {
    const repo = requireString(repository, "repository", 2000);
    const args = [entry, "inspect", "--repo", repo, ...profile];
    if (typeof search === "string" && search.trim() !== "") {
      args.push("--search", search.trim().slice(0, 500));
    }
    return { cwd, args };
  }

  if (command === "coverage") {
    const repo = requireString(repository, "repository", 2000);
    const objective = requireString(goal, "goal", 12000);
    return {
      cwd,
      args: [entry, "coverage", "--repo", repo, "--goal", objective, ...profile],
    };
  }

  if (command === "coverage-resume") {
    const repo = requireString(repository, "repository", 2000);
    const objective = requireString(goal, "goal", 12000);
    const savedRunId = runIdArg(runId);
    return {
      cwd,
      args: [
        entry,
        "coverage",
        "--repo",
        repo,
        "--goal",
        objective,
        "--run-id",
        savedRunId,
        "--resume",
        ...profile,
      ],
    };
  }

  if (command === "coverage-synthesize") {
    const savedRunId = runIdArg(runId);
    return {
      cwd,
      args: [entry, "coverage-synthesize", "--run-id", savedRunId, ...profile],
    };
  }

  if (command === "tests") {
    return { cwd, args: ["--test"] };
  }

  throw new Error(`Unsupported command: ${command}`);
}

export function isValidRunId(value) {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}
