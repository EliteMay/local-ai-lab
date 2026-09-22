import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/core/run-store.mjs";

test("RunStore rejects creating a new run over an existing run id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-runs-"));
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
    /Run already exists/
  );

  const saved = await store.readJson("run-existing", "run.json");
  assert.equal(saved.status, "RUNNING");
});

test("RunStore validates run ids before checking filesystem paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-runs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RunStore(root);

  await assert.rejects(
    async () => {
      try {
        await store.hasRun("../outside");
      } catch (error) {
        assert.equal(error.code, "INVALID_RUN_ID");
        throw error;
      }
    },
    /Invalid run id/
  );
});

test("RunStore still supports explicit unique run ids for tests and CLI callers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-runs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RunStore(root);
  const runId = await store.createRun({ runId: "run-explicit-new", goal: "Audit" });

  assert.equal(runId, "run-explicit-new");
  assert.equal(await store.hasRun(runId), true);
  const saved = await store.readJson(runId, "run.json");
  assert.equal(saved.goal, "Audit");
});
