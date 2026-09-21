import test from "node:test";
import assert from "node:assert/strict";
import { buildExecutionIdentity, compareResumeIdentity } from "../src/core/run-identity.mjs";

test("run identity is deterministic for the same effective configuration", () => {
  const first = buildExecutionIdentity({
    appVersion: "0.2.10",
    activeModelProfile: "default",
    model: { model: "qwen/qwen3-8b", baseUrl: "http://127.0.0.1:1234/v1" },
    coverage: { maxBatchChars: 16000, batchMaxTokens: 1000 }
  });
  const second = buildExecutionIdentity({
    coverage: { batchMaxTokens: 1000, maxBatchChars: 16000 },
    model: { baseUrl: "http://127.0.0.1:1234/v1", model: "qwen/qwen3-8b" },
    activeModelProfile: "default",
    appVersion: "0.2.10"
  });

  assert.equal(first.configHash, second.configHash);
  assert.equal(first.runSchemaVersion, 3);
  assert.equal(compareResumeIdentity(first, second).ok, true);
});

test("resume identity rejects a model or profile change", () => {
  const saved = buildExecutionIdentity({
    activeModelProfile: "default",
    model: { model: "qwen/qwen3-8b" }
  });
  const changed = buildExecutionIdentity({
    activeModelProfile: "bonsai-2-27b",
    model: { model: "bonsai-2-27b" }
  });

  const result = compareResumeIdentity(saved, changed);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((item) => item.includes("使用モデル")));
  assert.ok(result.reasons.some((item) => item.includes("モデル設定")));
});

test("legacy run without execution identity is not silently resumable", () => {
  const current = buildExecutionIdentity({ model: { model: "qwen/qwen3-8b" } });
  const result = compareResumeIdentity(null, current);
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /旧版/);
});


test("auto-routing identity pins catalog and routing hashes for safe resume", () => {
  const first = buildExecutionIdentity({
    appVersion: "0.3.0",
    modelRoutingMode: "auto",
    modelRoutingIdentity: {
      catalogHash: "catalog-a",
      routingHash: "routing-a",
      autoManageModels: true
    },
    coverage: { maxBatchChars: 16000 }
  });
  const same = buildExecutionIdentity({
    appVersion: "0.3.0",
    modelRoutingMode: "auto",
    modelRoutingIdentity: {
      catalogHash: "catalog-a",
      routingHash: "routing-a",
      autoManageModels: true
    },
    coverage: { maxBatchChars: 16000 }
  });
  const changed = buildExecutionIdentity({
    appVersion: "0.3.0",
    modelRoutingMode: "auto",
    modelRoutingIdentity: {
      catalogHash: "catalog-a",
      routingHash: "routing-b",
      autoManageModels: true
    },
    coverage: { maxBatchChars: 16000 }
  });

  assert.equal(first.model, "auto");
  assert.equal(first.routingCatalogHash, "catalog-a");
  assert.equal(compareResumeIdentity(first, same).ok, true);
  const mismatch = compareResumeIdentity(first, changed);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.reasons.some((item) => item.includes("監査設定") || item.includes("モデル振り分け")));
});
