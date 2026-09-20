import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProfiles } from "../src/desktop/profile-service.mjs";

test("profiles merge model and coverage overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-profile-"));
  try {
    await mkdir(join(root, "config", "model-profiles"), { recursive: true });
    await writeFile(join(root, "config", "default.json"), JSON.stringify({
      model: { runtime: "lm-studio", providerName: "LM Studio", model: "qwen", maxTokens: 2048 },
      coverage: { maxBatchChars: 16000, batchMaxTokens: 1000 },
    }));
    await writeFile(join(root, "config", "model-profiles", "bonsai.json"), JSON.stringify({
      model: { runtime: "prism", providerName: "Prism", model: "bonsai", maxTokens: 4096 },
      coverage: { batchMaxTokens: 1600 },
    }));
    const profiles = await listProfiles(root);
    assert.equal(profiles.length, 2);
    const bonsai = profiles.find((item) => item.id === "bonsai");
    assert.equal(bonsai.coverage.maxBatchChars, 16000);
    assert.equal(bonsai.coverage.batchMaxTokens, 1600);
    assert.equal(bonsai.maxTokens, 4096);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
