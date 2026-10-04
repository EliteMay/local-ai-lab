import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("AI Hub module manifest exposes the shared desktop runtime", async () => {
  const manifest = JSON.parse(await readFile(new URL("../hub/module.json", import.meta.url), "utf8"));

  assert.equal(manifest.schemaVersion, "1.0");
  assert.equal(manifest.hubApiVersion, "0.1");
  assert.equal(manifest.id, "local-ai-lab");
  assert.equal(manifest.mode, "hub-renderer");
  assert.equal(manifest.renderer, "desktop/renderer/index.html");
  assert.equal(manifest.preload, "hub/preload.cjs");
  assert.equal(manifest.adapter, "hub/adapter.mjs");
  assert.equal(manifest.dataRootKey, "local-ai-lab");
  assert.ok(manifest.capabilities.includes("repository-read"));
  assert.ok(manifest.capabilities.includes("long-running-process"));
  assert.ok(manifest.capabilities.includes("history"));
  assert.ok(manifest.capabilities.includes("diagnostics"));
  assert.ok(manifest.capabilities.includes("shared-settings"));
});
