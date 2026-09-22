import test from "node:test";
import assert from "node:assert/strict";
import { LMStudioClient } from "../src/model/lm-studio-client.mjs";

test("LM Studio client sends LM_API_TOKEN only to LM Studio requests", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.LM_API_TOKEN;
  const captured = [];

  process.env.LM_API_TOKEN = "test-token";
  globalThis.fetch = async (url, options = {}) => {
    captured.push({ url: String(url), authorization: options.headers?.authorization || "" });
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.LM_API_TOKEN;
    else process.env.LM_API_TOKEN = originalToken;
  });

  const lmStudio = new LMStudioClient({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3-8b",
    providerName: "LM Studio"
  });
  const prism = new LMStudioClient({
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "bonsai-2-27b",
    providerName: "PrismML llama.cpp",
    nativeModelDetailsPath: null
  });

  await lmStudio.listModels();
  await prism.listModels();

  assert.equal(captured[0].authorization, "Bearer test-token");
  assert.equal(captured[1].authorization, "");
});

test("fetch transport stops while streaming once the response limit is exceeded", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(96));
      controller.enqueue(new Uint8Array(96));
      controller.close();
    }
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const client = new LMStudioClient({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3-8b",
    maxResponseBytes: 128
  });

  await assert.rejects(
    async () => {
      try {
        await client.listModels();
      } catch (error) {
        assert.equal(error.code, "RESPONSE_TOO_LARGE");
        throw error;
      }
    },
    /response exceeded/
  );
});
