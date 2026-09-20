import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("desktop Electron boundary keeps renderer isolated", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /preload\.cjs/);
  assert.match(main, /setWindowOpenHandler/);
});

test("desktop command runner is allowlisted and does not enable shell execution", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /allowedCommands\s*=\s*new Set/);
  assert.match(main, /shell:\s*false/);
  assert.doesNotMatch(main, /exec\(/);
});

test("sandboxed desktop preload uses CommonJS and exposes only the narrow bridge", async () => {
  const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /require\("electron"\)/);
  assert.doesNotMatch(preload, /^\s*import\s/m);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("localAI"/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/);
});
