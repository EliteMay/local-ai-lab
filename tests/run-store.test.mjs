import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/core/run-store.mjs";

test("RunStore rejects reusing an existing explicit run id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-runstore-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RunStore(root);
  await store.createRun({ runId: "run-existing", status: "RUNNING" });

  await assert.rejects(
    async () => {
      try {
        await store.createRun({ runId: "run-existing", status: "RUNNING" });
      } catch (error) {
        assert.equal(error.code, "RUN_ID_ALREADY_EXISTS");
        throw error;
      }
    },
    /already exists/
  );
});

test("RunStore validates run ids consistently for reads and existence checks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-runstore-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RunStore(root);
  await assert.rejects(() => store.hasRun("../outside"), /Invalid run id/);
  await assert.rejects(() => store.readJson("../outside", "run.json"), /Invalid run id/);
});
