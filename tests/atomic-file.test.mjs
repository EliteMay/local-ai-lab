import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, backupPathFor, readJsonWithBackup } from "../src/core/atomic-file.mjs";

test("atomic JSON writes keep the previous valid snapshot and recover a corrupt primary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.json");

  await atomicWriteJson(path, { version: 1 });
  await atomicWriteJson(path, { version: 2 });

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 2 });
  assert.deepEqual(JSON.parse(await readFile(backupPathFor(path), "utf8")), { version: 1 });

  await writeFile(path, "{broken", "utf8");
  const recovered = await readJsonWithBackup(path);

  assert.deepEqual(recovered, { version: 1 });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1 });
});
