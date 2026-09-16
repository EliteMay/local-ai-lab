import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoReader } from "../src/security/repo-reader.mjs";

test("RepoReader lists and reads regular text files only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, "src"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "README.md"), "hello repository\n", "utf8");
  await writeFile(join(root, "src", "app.js"), "const value = 'needle';\n", "utf8");
  await writeFile(join(root, ".git", "secret"), "ignored\n", "utf8");

  const reader = new RepoReader(root);
  const files = await reader.listFiles();

  assert.deepEqual(files.sort(), ["README.md", "src/app.js"]);
  assert.equal(await reader.readTextFile("README.md"), "hello repository\n");

  const results = await reader.searchText("needle");
  assert.equal(results.length, 1);
  assert.equal(results[0].file, "src/app.js");
});

test("RepoReader rejects path traversal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const reader = new RepoReader(root);
  await assert.rejects(() => reader.readTextFile("../outside.txt"), /escapes repository root/);
});

test("RepoReader rejects oversized files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, "large.txt"), "1234567890", "utf8");
  const reader = new RepoReader(root, { maxFileBytes: 5 });

  await assert.rejects(() => reader.readTextFile("large.txt"), /exceeds read limit/);
});

test("RepoReader excludes obvious credential files from listings and direct reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-lab-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, ".env"), "API_KEY=secret\n", "utf8");
  await writeFile(join(root, "private.pem"), "secret-key\n", "utf8");
  await writeFile(join(root, ".env.example"), "API_KEY=placeholder\n", "utf8");

  const reader = new RepoReader(root);
  const files = await reader.listFiles();

  assert.deepEqual(files, [".env.example"]);
  await assert.rejects(() => reader.readTextFile(".env"), /Sensitive file blocked/);
  await assert.rejects(() => reader.readTextFile("private.pem"), /Sensitive file blocked/);
  assert.match(await reader.readTextFile(".env.example"), /placeholder/);
});
