import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildBonsaiStartSpec,
  containsBonsaiModel,
  validateBonsaiDemoPath
} from "../desktop/bonsai-runtime.mjs";

test("Bonsai start spec uses the fixed supported launch contract", () => {
  const spec = buildBonsaiStartSpec(join(tmpdir(), "Bonsai-demo"));
  assert.equal(spec.file, "powershell.exe");
  assert.equal(spec.args[0], "-NoLogo");
  assert.ok(spec.args.includes("-NoProfile"));
  assert.ok(spec.args.includes("-ExecutionPolicy"));
  assert.ok(spec.args.includes("Bypass"));
  assert.ok(spec.args.some((value) => value.endsWith("start_llama_server.ps1")));
  assert.deepEqual(spec.args.slice(-6), [
    "--alias",
    "bonsai-2-27b",
    "--parallel",
    "1",
    "--reasoning-budget",
    "1024"
  ]);
  assert.deepEqual(spec.env, {
    BONSAI_CTX: "16384",
    BONSAI_MMPROJ_CPU: "1",
    BONSAI_SPECULATIVE: "0",
    BONSAI_KV4: "0"
  });
});

test("Bonsai folder validation requires the official start script location", async () => {
  const root = await mkdtemp(join(tmpdir(), "bonsai-runtime-test-"));
  try {
    await assert.rejects(
      async () => validateBonsaiDemoPath(root),
      /起動スクリプトが見つかりません/
    );

    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts", "start_llama_server.ps1"), "# fixture\n", "utf8");
    assert.equal(validateBonsaiDemoPath(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Bonsai server identity requires the expected model id", () => {
  assert.equal(containsBonsaiModel({ data: [{ id: "bonsai-2-27b" }] }), true);
  assert.equal(containsBonsaiModel({ models: [{ key: "local/bonsai-2-27b" }] }), true);
  assert.equal(containsBonsaiModel({ data: [{ id: "other-model" }] }), false);
  assert.equal(containsBonsaiModel({ error: "unauthorized" }), false);
});
