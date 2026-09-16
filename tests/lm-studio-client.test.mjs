import test from "node:test";
import assert from "node:assert/strict";
import { LMStudioClient } from "../src/model/lm-studio-client.mjs";

test("chatJson uses LM Studio json_schema structured output and bounds output tokens", async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;

  globalThis.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "{\"status\":\"completed\"}" } }]
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

  const result = await client.chatJson({ system: "system", user: "user" });

  assert.deepEqual(result, { status: "completed" });
  assert.equal(capturedBody.max_tokens, 1536);
  assert.equal(capturedBody.response_format.type, "json_schema");
  assert.equal(capturedBody.response_format.json_schema.name, "structured_response");
  assert.deepEqual(capturedBody.response_format.json_schema.schema, { type: "object" });
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
