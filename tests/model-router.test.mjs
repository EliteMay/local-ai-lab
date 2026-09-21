import test from "node:test";
import assert from "node:assert/strict";
import { ModelRouter } from "../src/model/model-router.mjs";

test("model router falls back deterministically and records per-model usage", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 4 }
  }), { status: 200, headers: { "content-type": "application/json" } });
  t.after(() => { globalThis.fetch = originalFetch; });

  const catalog = {
    models: [
      { id: "coder", label: "Coder", runtime: "lm-studio", autoRoute: true },
      { id: "qwen", label: "Qwen", runtime: "lm-studio", autoRoute: true }
    ]
  };
  const routing = {
    defaultRoute: "general",
    routes: {
      general: ["qwen"],
      "coverage-code": ["coder", "qwen"]
    }
  };
  const manager = {
    async ensureLoaded(entry) {
      if (entry.id === "coder") {
        const error = new Error("not installed");
        error.code = "MODEL_NOT_INSTALLED";
        throw error;
      }
      return { instanceId: "qwen-instance" };
    },
    async unloadManaged() { return { unloaded: 0 }; }
  };
  const events = [];
  const router = new ModelRouter({
    config: {
      model: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "qwen-instance",
        providerName: "LM Studio",
        structuredOutputStyle: "openai-json-schema"
      }
    },
    catalog,
    routing,
    manager,
    onRoute: (event) => events.push(event)
  });

  const result = await router.clientFor("coverage-code").chatJsonDetailed({
    system: "system",
    user: "user",
    jsonSchema: { type: "object" }
  });

  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.meta.route.modelId, "qwen");
  assert.ok(events.some((event) => event.type === "model_fallback" && event.modelId === "coder"));
  assert.ok(events.some((event) => event.type === "model_route" && event.modelId === "qwen"));

  const usage = router.snapshot();
  assert.equal(usage.models.find((item) => item.modelId === "coder").failures, 1);
  assert.equal(usage.models.find((item) => item.modelId === "qwen").successes, 1);
});


test("successful routed model is pinned for the task and exported in usage evidence", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2 }
  }), { status: 200, headers: { "content-type": "application/json" } });
  t.after(() => { globalThis.fetch = originalFetch; });

  const catalog = {
    models: [{ id: "qwen", label: "Qwen", runtime: "lm-studio", autoRoute: true }]
  };
  const router = new ModelRouter({
    config: { model: { baseUrl: "http://127.0.0.1:1234/v1", model: "qwen", structuredOutputStyle: "openai-json-schema" } },
    catalog,
    routing: { defaultRoute: "general", routes: { general: ["qwen"] } },
    manager: {
      async ensureLoaded() { return { instanceId: "qwen-instance" }; },
      async unloadManaged() { return { unloaded: 0 }; }
    }
  });

  await router.clientFor("general").chatJsonDetailed({
    system: "system",
    user: "user",
    jsonSchema: { type: "object" }
  });

  assert.equal(router.snapshot().pins.general, "qwen");
});
