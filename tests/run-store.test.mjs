import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/core/run-store.mjs";

test("RunStore refuses to overwrite an existing explicit run id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-runs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RunStore(root);
  await store.createRun({ runId: "run-existing", goal: "first" });

  await assert.rejects(
    () => store.createRun({ runId: "run-existing", goal: "second" }),
    (error) => error?.code === "RUN_ID_ALREADY_EXISTS"
  );

  const metadata = await store.readJson("run-existing", "run.json");
  assert.equal(metadata.goal, "first");
});

test("RunStore rejects invalid run ids consistently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-runs-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RunStore(root);
  await assert.rejects(() => store.createRun({ runId: "../outside" }), /Invalid run id/);
  await assert.rejects(() => store.hasRun("../outside"), /Invalid run id/);
  await assert.rejects(() => store.readJson("../outside", "run.json"), /Invalid run id/);
});
