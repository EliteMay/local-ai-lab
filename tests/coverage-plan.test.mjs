import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoReader } from "../src/security/repo-reader.mjs";
import { buildCoveragePlan, splitFileIntoChunks } from "../src/core/coverage-plan.mjs";

async function fixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("coverage plan reads every auditable text file and records unreadable binary exclusions", async (t) => {
  const root = await fixture(t, "local-ai-lab-coverage-plan-");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(root, "src", "a.js"), "export const a = 1;\n", "utf8");
  await writeFile(join(root, "binary.bin"), Buffer.from([1, 0, 2, 3]));
  await writeFile(join(root, ".env"), "SECRET=blocked\n", "utf8");

  const reader = new RepoReader(root, { maxFiles: 100, maxFileBytes: 10000 });
  const plan = await buildCoveragePlan(reader, { maxChunkChars: 200, maxBatchChars: 400 });

  assert.equal(plan.inventoryFiles, 3);
  assert.equal(plan.auditableFiles, 2);
  assert.equal(plan.excludedFiles, 1);
  assert.deepEqual(plan.files.map((file) => file.path), ["README.md", "src/a.js"]);
  assert.deepEqual(plan.excluded.map((file) => [file.path, file.reason]), [["binary.bin", "binary"]]);
  assert.ok(plan.totalChunks >= 2);
  assert.ok(plan.totalBatches >= 1);
  assert.equal(plan.chunks.length, plan.totalChunks);
});

test("coverage plan refuses to claim completeness when repository inventory hits maxFiles", async (t) => {
  const root = await fixture(t, "local-ai-lab-coverage-limit-");
  await writeFile(join(root, "a.txt"), "a\n", "utf8");
  await writeFile(join(root, "b.txt"), "b\n", "utf8");

  const reader = new RepoReader(root, { maxFiles: 1, maxFileBytes: 1000 });

  await assert.rejects(
    () => buildCoveragePlan(reader),
    /refusing to claim full coverage/
  );
});

test("line-preserving chunking covers a large source file without dropping lines", () => {
  const text = Array.from({ length: 30 }, (_, index) => `line-${index + 1}-${"x".repeat(20)}`).join("\n");
  const chunks = splitFileIntoChunks("src/large.js", text, { maxChunkChars: 180 });

  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks.at(-1).endLine, 30);
  assert.ok(chunks.every((chunk) => chunk.path === "src/large.js"));
  assert.ok(chunks.every((chunk) => chunk.content.includes(":")));

  const covered = new Set();
  for (const chunk of chunks) {
    for (let line = chunk.startLine; line <= chunk.endLine; line += 1) covered.add(line);
  }
  assert.equal(covered.size, 30);
});
