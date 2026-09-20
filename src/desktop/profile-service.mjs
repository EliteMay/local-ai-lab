import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

function mergeConfig(base, override) {
  const merged = { ...base, ...override };
  for (const key of ["model", "limits", "orchestrator", "context", "coverage", "repoReader", "runtimeData"]) {
    if (base[key] && override[key]) merged[key] = { ...base[key], ...override[key] };
  }
  return merged;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function publicProfile(id, config) {
  return {
    id,
    runtime: config.model?.runtime ?? "unknown",
    providerName: config.model?.providerName ?? "Unknown runtime",
    model: config.model?.model ?? "unknown",
    baseUrl: config.model?.baseUrl ?? "",
    timeoutMs: config.model?.timeoutMs ?? null,
    maxTokens: config.model?.maxTokens ?? null,
    temperature: config.model?.temperature ?? null,
    coverage: {
      maxBatchChars: config.coverage?.maxBatchChars ?? null,
      batchMaxTokens: config.coverage?.batchMaxTokens ?? null,
      singleChunkMaxTokens: config.coverage?.singleChunkMaxTokens ?? null,
      maxSynthesisChars: config.coverage?.maxSynthesisChars ?? null,
      reductionMaxTokens: config.coverage?.reductionMaxTokens ?? null,
    },
  };
}

export async function listProfiles(appRoot) {
  const base = await readJson(resolve(appRoot, "config", "default.json"));
  const profiles = [publicProfile("default", base)];
  const dir = resolve(appRoot, "config", "model-profiles");
  let files = [];
  try {
    files = await readdir(dir, { withFileTypes: true });
  } catch {
    return profiles;
  }

  for (const item of files) {
    if (!item.isFile() || !item.name.endsWith(".json")) continue;
    const id = item.name.slice(0, -5);
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) continue;
    const override = await readJson(resolve(dir, item.name));
    profiles.push(publicProfile(id, mergeConfig(base, override)));
  }
  profiles.sort((a, b) => (a.id === "default" ? -1 : b.id === "default" ? 1 : a.id.localeCompare(b.id)));
  return profiles;
}

export async function getProfile(appRoot, profileId = "default") {
  const profiles = await listProfiles(appRoot);
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Unknown model profile: ${profileId}`);
  return profile;
}
