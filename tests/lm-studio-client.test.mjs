import test from "node:test";
import assert from "node:assert/strict";
import { LMStudioClient } from "../src/model/lm-studio-client.mjs";

test("chatJson uses LM Studio json_schema structured output and bounds output tokens", async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;

  globalThis.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "{\"status\":\"completed\"}" }, finish_reason: "stop" }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new LMStudioClient({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3-8b",
    maxTokens: 1536
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { status: { const: "completed" } },
    required: ["status"]
  };
  const result = await client.chatJson({ system: "system", user: "user", jsonSchema: schema });

  assert.deepEqual(result, { status: "completed" });
  assert.equal(capturedBody.max_tokens, 1536);
  assert.equal(capturedBody.response_format.type, "json_schema");
  assert.equal(capturedBody.response_format.json_schema.name, "structured_response");
  assert.equal(capturedBody.response_format.json_schema.strict, true);
  assert.deepEqual(capturedBody.response_format.json_schema.schema, schema);
});

test("chatJsonDetailed returns finish reason and usage metadata", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: { content: "{\"status\":\"completed\"}", reasoning_content: "hidden reasoning" },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 7 }
    }
  }), { status: 200, headers: { "content-type": "application/json" } });

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new LMStudioClient({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3-8b"
  });
  const result = await client.chatJsonDetailed({ system: "system", user: "user" });

  assert.deepEqual(result.value, { status: "completed" });
  assert.equal(result.meta.finishReason, "stop");
  assert.equal(result.meta.usage.prompt_tokens, 100);
  assert.equal(result.meta.reasoningTokens, 7);
});

test("finish_reason length is reported as an explicit context or output budget failure", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: { content: "{\"status\":\"completed\",\"summary\":\"cut" },
      finish_reason: "length"
    }],
    usage: { prompt_tokens: 14864, completion_tokens: 1520 }
  }), { status: 200, headers: { "content-type": "application/json" } });

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new LMStudioClient({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3-8b"
  });

  await assert.rejects(
    () => client.chatJsonDetailed({ system: "system", user: "user" }),
    /context\/output limit.*prompt=14864, completion=1520, total=16384/
  );
});

test("listModelDetails uses the native LM Studio model endpoint", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = null;

  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ models: [{ key: "qwen/qwen3-8b", loaded_instances: [] }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new LMStudioClient({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3-8b"
  });
  const models = await client.listModelDetails();

  assert.equal(requestedUrl, "http://127.0.0.1:1234/api/v1/models");
  assert.equal(models[0].key, "qwen/qwen3-8b");
});

test("request timeout reports an actionable LM Studio timeout error", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new LMStudioClient({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3-8b",
    timeoutMs: 10
  });

  await assert.rejects(
    () => client.listModels(),
    /LM Studio request timed out after 0 seconds/
  );
});
