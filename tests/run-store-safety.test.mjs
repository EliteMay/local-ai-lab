import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/core/run-store.mjs";

test("RunStore refuses to overwrite an existing explicit run id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-run-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RunStore(root);
  const runId = "run-explicit-safety";
  await store.createRun({ runId, status: "RUNNING" });

  await assert.rejects(
    async () => {
      try {
        await store.createRun({ runId, status: "RUNNING" });
      } catch (error) {
        assert.equal(error.code, "RUN_ID_ALREADY_EXISTS");
        throw error;
      }
    },
    /Run already exists/
  );

  const saved = await store.readJson(runId, "run.json");
  assert.equal(saved.status, "RUNNING");
});

test("RunStore validates run ids before filesystem access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-run-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RunStore(root);
  await assert.rejects(() => store.hasRun("../outside"), /Invalid run id/);
  await assert.rejects(() => store.hasRun("not-a-run"), /Invalid run id/);
});
