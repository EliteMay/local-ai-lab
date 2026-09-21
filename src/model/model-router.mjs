import { LMStudioClient } from "./lm-studio-client.mjs";
import { LMStudioModelManager } from "./lm-studio-model-manager.mjs";
import { createHash } from "node:crypto";
import { findCatalogModel } from "./model-catalog.mjs";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function emptyUsage(entry) {
  return {
    modelId: entry.id,
    label: entry.label,
    runtime: entry.runtime,
    calls: 0,
    successes: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    durationMs: 0
  };
}

export class ModelRouter {
  constructor({ config, catalog, routing, autoManageModels = true, onRoute = null, manager = null } = {}) {
    if (!config || !catalog || !routing) throw new Error("config, catalog and routing are required");
    this.config = config;
    this.catalog = catalog;
    this.routing = routing;
    this.autoManageModels = autoManageModels !== false;
    this.onRoute = typeof onRoute === "function" ? onRoute : () => {};
    this.manager = manager ?? new LMStudioModelManager({ catalog });
    this.usage = new Map();
    this.blockedModels = new Map();
    this.pins = new Map();
  }

  identity() {
    return {
      mode: "auto",
      catalogHash: stableHash(this.catalog),
      routingHash: stableHash(this.routing),
      autoManageModels: this.autoManageModels
    };
  }

  importPins(pins = {}) {
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) return;
    for (const [taskType, modelId] of Object.entries(pins)) {
      const entry = findCatalogModel(this.catalog, modelId);
      if (!entry || entry.autoRoute === false) {
        const error = new Error("Saved model routing pin is no longer available: " + taskType + " -> " + modelId);
        error.code = "MODEL_ROUTING_PIN_INVALID";
        throw error;
      }
      this.pins.set(taskType, modelId);
    }
  }

  candidates(taskType) {
    const pinnedId = this.pins.get(taskType);
    const ids = pinnedId
      ? [pinnedId]
      : (this.routing.routes?.[taskType]
        ?? this.routing.routes?.[this.routing.defaultRoute]
        ?? []);
    return ids
      .map((id) => findCatalogModel(this.catalog, id))
      .filter((entry) => entry?.autoRoute !== false);
  }

  #usageFor(entry) {
    if (!this.usage.has(entry.id)) this.usage.set(entry.id, emptyUsage(entry));
    return this.usage.get(entry.id);
  }

  #record(entry, { ok, durationMs, meta = null }) {
    const usage = this.#usageFor(entry);
    usage.calls += 1;
    usage.durationMs += durationMs;
    if (ok) usage.successes += 1;
    else usage.failures += 1;
    usage.promptTokens += meta?.usage?.prompt_tokens ?? 0;
    usage.completionTokens += meta?.usage?.completion_tokens ?? 0;
    usage.reasoningTokens += meta?.reasoningTokens ?? 0;
  }

  async #clientForEntry(entry) {
    if (entry.runtime === "prism-llama.cpp") {
      if (this.autoManageModels) {
        try { await this.manager.unloadManaged(); } catch {}
      }
      return new LMStudioClient(entry.connection);
    }
    if (entry.runtime !== "lm-studio") {
      throw new Error("Unsupported model runtime: " + entry.runtime);
    }

    try {
      const loaded = await this.manager.ensureLoaded(entry, { autoManage: this.autoManageModels });
      return new LMStudioClient({
        ...this.config.model,
        providerName: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        nativeModelDetailsPath: "/api/v1/models",
        transport: "fetch",
        model: loaded.instanceId
      });
    } catch (error) {
      if (entry.id === "qwen3-8b") {
        return new LMStudioClient(this.config.model);
      }
      throw error;
    }
  }

  clientFor(taskType) {
    const router = this;
    if (!this.candidates(taskType).length) throw new Error("No model route for task: " + taskType);

    async function call(method, input) {
      const pinnedAtStart = router.pins.get(taskType) ?? null;
      const candidates = router.candidates(taskType);
      const failures = [];
      let lastError = null;
      let attempted = 0;
      for (let index = 0; index < candidates.length; index += 1) {
        const entry = candidates[index];
        if (router.blockedModels.has(entry.id)) {
          failures.push(entry.label + ": " + router.blockedModels.get(entry.id));
          continue;
        }
        attempted += 1;
        const startedAt = Date.now();
        try {
          router.onRoute({
            type: "model_prepare",
            taskType,
            modelId: entry.id,
            label: entry.label,
            runtime: entry.runtime,
            fallbackIndex: index
          });
          const client = await router.#clientForEntry(entry);
          router.onRoute({
            type: "model_route",
            taskType,
            modelId: entry.id,
            label: entry.label,
            runtime: entry.runtime,
            fallbackIndex: index
          });
          const result = await client[method](input);
          const meta = result?.meta ?? result;
          router.#record(entry, { ok: true, durationMs: Date.now() - startedAt, meta });
          if (!router.pins.has(taskType)) {
            router.pins.set(taskType, entry.id);
            router.onRoute({
              type: "model_pin",
              taskType,
              modelId: entry.id,
              label: entry.label,
              runtime: entry.runtime
            });
          }
          if (result?.meta && typeof result.meta === "object") {
            result.meta = {
              ...result.meta,
              route: { taskType, modelId: entry.id, label: entry.label, runtime: entry.runtime }
            };
          }
          return result;
        } catch (error) {
          lastError = error;
          router.#record(entry, { ok: false, durationMs: Date.now() - startedAt });
          failures.push(entry.label + ": " + error.message);
          if (
            error?.code === "MODEL_NOT_INSTALLED" ||
            error?.code === "LM_STUDIO_MODEL_API" ||
            /ECONNREFUSED|fetch failed/i.test(String(error?.message || ""))
          ) {
            router.blockedModels.set(entry.id, error.message);
          }
          router.onRoute({
            type: "model_fallback",
            taskType,
            modelId: entry.id,
            label: entry.label,
            runtime: entry.runtime,
            error: error.message,
            fallbackIndex: index
          });
          if (pinnedAtStart) {
            const pinnedError = new Error(
              "前回まで使用していたモデル " + entry.label + " をこの処理で利用できません。モデルを復旧してから再開してください。"
            );
            pinnedError.code = "PINNED_MODEL_UNAVAILABLE";
            pinnedError.cause = error;
            throw pinnedError;
          }
        }
      }
      if (lastError?.code === "OUTPUT_TOKEN_LIMIT" || lastError?.code === "CONTEXT_LIMIT") {
        lastError.message += " | routed attempts: " + failures.join(" | ");
        throw lastError;
      }
      const error = new Error("All routed models failed for " + taskType + ": " + failures.join(" | "));
      error.code = attempted === 0 ? "NO_ROUTED_MODEL_AVAILABLE" : "MODEL_ROUTING_FAILED";
      throw error;
    }

    return {
      chatJsonDetailed(input) { return call("chatJsonDetailed", input); },
      async chatJson(input) { return (await call("chatJsonDetailed", input)).value; },
      chatDetailed(input) { return call("chatDetailed", input); },
      async chat(input) { return (await call("chatDetailed", input)).content; }
    };
  }

  snapshot() {
    const models = [...this.usage.values()].map((item) => ({
      ...item,
      averageDurationMs: item.calls ? Math.round(item.durationMs / item.calls) : 0
    }));
    return {
      ...this.identity(),
      pins: Object.fromEntries(this.pins),
      totalCalls: models.reduce((sum, item) => sum + item.calls, 0),
      models
    };
  }
}


export function mergeModelUsageSnapshots(...snapshots) {
  const valid = snapshots.filter((item) => item && Array.isArray(item.models));
  if (!valid.length) return null;
  const merged = new Map();
  const pins = {};
  for (const snapshot of valid) {
    for (const [taskType, modelId] of Object.entries(snapshot.pins ?? {})) {
      if (pins[taskType] && pins[taskType] !== modelId) {
        throw new Error("Model routing pin changed for " + taskType + ": " + pins[taskType] + " -> " + modelId);
      }
      pins[taskType] = modelId;
    }
    for (const item of snapshot.models) {
      const key = item.modelId || item.label;
      if (!key) continue;
      const current = merged.get(key) ?? {
        modelId: item.modelId ?? key,
        label: item.label ?? key,
        runtime: item.runtime ?? "",
        calls: 0,
        successes: 0,
        failures: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        durationMs: 0
      };
      for (const field of ["calls", "successes", "failures", "promptTokens", "completionTokens", "reasoningTokens", "durationMs"]) {
        current[field] += Number(item[field]) || 0;
      }
      current.averageDurationMs = current.calls ? Math.round(current.durationMs / current.calls) : 0;
      merged.set(key, current);
    }
  }
  const models = [...merged.values()];
  return {
    mode: "auto",
    catalogHash: valid.at(-1)?.catalogHash ?? null,
    routingHash: valid.at(-1)?.routingHash ?? null,
    autoManageModels: valid.at(-1)?.autoManageModels !== false,
    pins,
    totalCalls: models.reduce((sum, item) => sum + item.calls, 0),
    models
  };
}
