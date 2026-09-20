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
  assert.equal("strict" in capturedBody.response_format.json_schema, false);
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

test("finish_reason length at max_tokens is classified as output token limit", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: { content: "{\"status\":\"completed\",\"summary\":\"cut" },
      finish_reason: "length"
    }],
    usage: { prompt_tokens: 5140, completion_tokens: 1000 }
  }), { status: 200, headers: { "content-type": "application/json" } });

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new LMStudioClient({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3-8b"
  });

  await assert.rejects(
    async () => {
      try {
        await client.chatJsonDetailed({ system: "system", user: "user", maxTokens: 1000 });
      } catch (error) {
        assert.equal(error.code, "OUTPUT_TOKEN_LIMIT");
        assert.equal(error.maxTokens, 1000);
        assert.equal(error.totalTokens, 6140);
        throw error;
      }
    },
    /max output tokens.*max_tokens=1000.*prompt=5140, completion=1000, total=6140/
  );
});

test("finish_reason length below max_tokens is classified as context limit", async (t) => {
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
    async () => {
      try {
        await client.chatJsonDetailed({ system: "system", user: "user", maxTokens: 2048 });
      } catch (error) {
        assert.equal(error.code, "CONTEXT_LIMIT");
        assert.equal(error.totalTokens, 16384);
        throw error;
      }
    },
    /context limit.*prompt=14864, completion=1520, total=16384/
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


test("llama.cpp profile uses schema-constrained response_format without LM Studio nesting", async (t) => {
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
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "bonsai-2-27b",
    providerName: "PrismML llama.cpp",
    structuredOutputStyle: "llama-cpp-json-schema",
    nativeModelDetailsPath: null
  });

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { status: { const: "completed" } },
    required: ["status"]
  };
  const result = await client.chatJson({ system: "system", user: "user", jsonSchema: schema });

  assert.deepEqual(result, { status: "completed" });
  assert.equal(capturedBody.response_format.type, "json_schema");
  assert.deepEqual(capturedBody.response_format.schema, schema);
  assert.equal("json_schema" in capturedBody.response_format, false);
});

test("generic OpenAI-compatible runtime can disable LM Studio native model details", async () => {
  const client = new LMStudioClient({
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "bonsai-2-27b",
    providerName: "PrismML llama.cpp",
    nativeModelDetailsPath: null
  });

  assert.equal(await client.listModelDetails(), null);
});


test("chatJson accepts fenced JSON responses", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: { content: "```json\n{\"status\":\"completed\"}\n```" },
      finish_reason: "stop"
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new LMStudioClient({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3-8b"
  });

  const result = await client.chatJson({ system: "system", user: "user" });
  assert.deepEqual(result, { status: "completed" });
});
