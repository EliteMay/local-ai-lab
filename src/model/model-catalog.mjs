import { readFile } from "node:fs/promises";

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/i;

async function readJson(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}

function validateCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.models)) {
    throw new Error("Invalid model catalog");
  }
  const ids = new Set();
  for (const model of catalog.models) {
    if (!ID_PATTERN.test(String(model?.id || ""))) throw new Error("Invalid model catalog id");
    if (ids.has(model.id)) throw new Error("Duplicate model catalog id: " + model.id);
    if (!["lm-studio", "prism-llama.cpp"].includes(model.runtime)) {
      throw new Error("Unsupported model runtime: " + model.runtime);
    }
    ids.add(model.id);
  }
  return catalog;
}

function validateRouting(routing, catalog) {
  if (routing?.schemaVersion !== 1 || !routing.routes || typeof routing.routes !== "object") {
    throw new Error("Invalid model routing config");
  }
  const ids = new Set(catalog.models.map((item) => item.id));
  for (const [taskType, candidates] of Object.entries(routing.routes)) {
    if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("Invalid model route: " + taskType);
    for (const id of candidates) {
      if (!ids.has(id)) throw new Error("Unknown model id in route " + taskType + ": " + id);
    }
  }
  return routing;
}

export async function loadModelCatalog() {
  return validateCatalog(await readJson("../../config/model-catalog.json"));
}

export async function loadModelRouting(catalog = null) {
  const resolvedCatalog = catalog ?? await loadModelCatalog();
  return validateRouting(await readJson("../../config/model-routing.json"), resolvedCatalog);
}

export function findCatalogModel(catalog, id) {
  return catalog.models.find((item) => item.id === id) ?? null;
}

export function modelMatchesCatalogEntry(model, entry) {
  const haystack = [
    model?.key,
    model?.display_name,
    model?.selected_variant,
    ...(Array.isArray(model?.variants) ? model.variants : [])
  ].filter(Boolean).join(" ").toLowerCase();
  return (entry.matchTerms ?? [entry.id]).some((term) => haystack.includes(String(term).toLowerCase()));
}

export function classifyCoveragePlan(plan, routing) {
  const extensions = (routing.codeExtensions ?? []).map((value) => String(value).toLowerCase());
  let total = 0;
  let code = 0;
  for (const batch of plan?.batches ?? []) {
    for (const chunk of batch.chunks ?? []) {
      total += 1;
      const path = String(chunk.path || "").toLowerCase();
      if (extensions.some((ext) => path.endsWith(ext))) code += 1;
    }
  }
  if (!total) return "coverage-general";
  return code / total >= (routing.codeRatioThreshold ?? 0.45) ? "coverage-code" : "coverage-general";
}
