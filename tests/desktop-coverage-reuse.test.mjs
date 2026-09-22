import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function read(path) {
  return readFile(new URL("../" + path, import.meta.url), "utf8");
}

test("desktop exposes safe coverage reuse as a boolean setting and fixed CLI flag", async () => {
  const [main, html, renderer] = await Promise.all([
    read("desktop/main.mjs"),
    read("desktop/renderer/index.html"),
    read("desktop/renderer/renderer.mjs")
  ]);

  assert.match(html, /id="reuseCoverage"/);
  assert.match(main, /reuseCoverage: true/);
  assert.match(main, /reuseCoverage: input\?\.reuseCoverage !== false/);
  assert.match(main, /"--reuse-coverage", String\(reuseCoverage\)/);
  assert.match(renderer, /reuseCoverage: state\.settings\.reuseCoverage !== false/);
  assert.match(renderer, /progress\.type === "batch-reused"/);
  assert.match(renderer, /progress\.type === "reuse-plan"/);
});

test("desktop parses reuse progress without exposing a new privileged IPC surface", async () => {
  const [main, preload] = await Promise.all([
    read("desktop/main.mjs"),
    read("desktop/preload.cjs")
  ]);

  assert.match(main, /type: "batch-reused"/);
  assert.match(main, /type: "reuse-plan"/);
  assert.doesNotMatch(preload, /reuseCoverage|coverageReuse|cachePath|reusePath/);
});
