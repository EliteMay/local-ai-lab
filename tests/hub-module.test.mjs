import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("AI Hub module manifest is valid", async () => {
  const manifest = JSON.parse(await readFile(new URL("../hub/module.json", import.meta.url), "utf8"));

  assert.equal(manifest.schemaVersion, "0.1");
  assert.equal(manifest.hubApiVersion, "0.1");
  assert.equal(manifest.id, "local-ai-lab");
  assert.equal(manifest.entry, "index.html");
  assert.ok(manifest.capabilities.includes("module-context"));
  assert.ok(manifest.capabilities.includes("open-full-app"));
});
