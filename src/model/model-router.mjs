import { LMStudioClient } from "./lm-studio-client.mjs";
import { LMStudioModelManager } from "./lm-studio-model-manager.mjs";
import { findCatalogModel } from "./model-catalog.mjs";

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
  }

  candidates(taskType) {
    const ids = this.routing.routes?.[taskType]
      ?? this.routing.routes?.[this.routing.defaultRoute]
      ?? [];
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
    const candidates = this.candidates(taskType);
    if (!candidates.length) throw new Error("No model route for task: " + taskType);

    async function call(method, input) {
      const failures = [];
      for (let index = 0; index < candidates.length; index += 1) {
        const entry = candidates[index];
        const startedAt = Date.now();
        try {
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
          if (result?.meta && typeof result.meta === "object") {
            result.meta = {
              ...result.meta,
              route: { taskType, modelId: entry.id, label: entry.label, runtime: entry.runtime }
            };
          }
          return result;
        } catch (error) {
          router.#record(entry, { ok: false, durationMs: Date.now() - startedAt });
          failures.push(entry.label + ": " + error.message);
          router.onRoute({
            type: "model_fallback",
            taskType,
            modelId: entry.id,
            label: entry.label,
            runtime: entry.runtime,
            error: error.message,
            fallbackIndex: index
          });
        }
      }
      throw new Error("All routed models failed for " + taskType + ": " + failures.join(" | "));
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
      mode: "auto",
      autoManageModels: this.autoManageModels,
      totalCalls: models.reduce((sum, item) => sum + item.calls, 0),
      models
    };
  }
}
