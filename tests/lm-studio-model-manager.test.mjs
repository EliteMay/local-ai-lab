import test from "node:test";
import assert from "node:assert/strict";
import { LMStudioModelManager } from "../src/model/lm-studio-model-manager.mjs";

function catalog() {
  return {
    models: [
      {
        id: "qwen3-8b",
        label: "Qwen3 8B",
        runtime: "lm-studio",
        matchTerms: ["qwen3-8b"],
        download: { model: "https://huggingface.co/example/qwen3", quantization: "Q4_K_M" },
        load: { context_length: 16384, flash_attention: true }
      },
      {
        id: "coder",
        label: "Coder",
        runtime: "lm-studio",
        matchTerms: ["coder-7b"],
        download: { model: "https://huggingface.co/example/coder", quantization: "Q4_K_M" },
        load: { context_length: 16384 }
      }
    ]
  };
}

test("LM Studio manager only loads catalog models and unloads other managed instances first", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let qwenLoaded = true;
  let coderLoaded = false;

  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method || "GET", body });

    if (path === "/api/v1/models") {
      return new Response(JSON.stringify({
        models: [
          {
            type: "llm",
            key: "qwen/qwen3-8b",
            display_name: "Qwen3 8B",
            loaded_instances: qwenLoaded ? [{ id: "qwen/qwen3-8b", config: {} }] : [],
            size_bytes: 5000
          },
          {
            type: "llm",
            key: "local/coder-7b",
            display_name: "Coder 7B",
            loaded_instances: coderLoaded ? [{ id: "local/coder-7b", config: {} }] : [],
            size_bytes: 4000
          }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === "/api/v1/models/unload") {
      if (body.instance_id === "qwen/qwen3-8b") qwenLoaded = false;
      return new Response(JSON.stringify({ instance_id: body.instance_id }), { status: 200 });
    }
    if (path === "/api/v1/models/load") {
      coderLoaded = true;
      return new Response(JSON.stringify({ instance_id: "local/coder-7b" }), { status: 200 });
    }
    throw new Error("Unexpected request " + path);
  };

  t.after(() => { globalThis.fetch = originalFetch; });

  const manager = new LMStudioModelManager({ catalog: catalog() });
  const result = await manager.ensureLoaded(catalog().models[1], { autoManage: true });

  assert.equal(result.instanceId, "local/coder-7b");
  assert.ok(calls.some((call) => call.path === "/api/v1/models/unload" && call.body.instance_id === "qwen/qwen3-8b"));
  assert.ok(calls.some((call) => call.path === "/api/v1/models/load" && call.body.model === "local/coder-7b"));
});

test("LM Studio manager starts downloads from fixed catalog metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ job_id: "job_test", status: "downloading" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const data = catalog();
  const manager = new LMStudioModelManager({ catalog: data });
  const result = await manager.download(data.models[1]);

  assert.equal(result.job_id, "job_test");
  assert.match(captured.url, /\/api\/v1\/models\/download$/);
  assert.deepEqual(captured.body, {
    model: "https://huggingface.co/example/coder",
    quantization: "Q4_K_M"
  });
});
