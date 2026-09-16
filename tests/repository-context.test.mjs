import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoReader } from "../src/security/repo-reader.mjs";
import { buildRepositoryContext } from "../src/core/repository-context.mjs";

test("repository context prioritizes source-of-truth files and stays bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "# Demo\nread me\n", "utf8");
  await writeFile(join(root, "REQUIREMENTS.md"), "# Requirements\nimportant contract\n", "utf8");
  await writeFile(join(root, "src", "app.js"), "export const app = true;\n", "utf8");
  await writeFile(join(root, "src", "extra.js"), "x".repeat(5000), "utf8");

  const reader = new RepoReader(root);
  const context = await buildRepositoryContext(reader, {
    maxFiles: 3,
    maxChars: 500,
    maxFileChars: 220
  });

  assert.equal(context.documents[0].path, "REQUIREMENTS.md");
  assert.equal(context.documents[1].path, "README.md");
  assert.ok(context.coverage.includedChars <= 500);
  assert.match(context.documents[0].content, /1: # Requirements/);
  assert.equal(context.coverage.manifestFiles, 4);
});
