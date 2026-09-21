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


test("desktop validates privileged IPC senders and prevents renderer navigation", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /function assertTrustedSender/);
  assert.match(main, /senderFrame\?\.url/);
  assert.match(main, /registerIpc\(/);
  assert.match(main, /will-navigate/);
  assert.match(main, /event\.preventDefault\(\)/);
});

test("desktop renderer separates task selection from execution", async () => {
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");

  assert.match(renderer, /button\.dataset\.command\)\)\);/);
  assert.match(renderer, /selectCommand\(button\.dataset\.command\)/);
  assert.doesNotMatch(renderer, /run\(button\.dataset\.command\)/);
  assert.match(renderer, /#execute/);
  assert.match(renderer, /run\(state\.selectedCommand\)/);
  assert.match(html, /id="execute"/);
});

test("desktop exposes recovery state for partial coverage and synthesis", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");

  assert.match(main, /coverageComplete:/);
  assert.match(main, /synthesisError/);
  assert.match(main, /reviewerDecision/);
  assert.match(renderer, /prepareSynthesis/);
  assert.match(renderer, /prepareCoverageResume/);
  assert.match(renderer, /Synthesis再開/);
  assert.match(renderer, /Coverage再開/);
});

test("desktop renderer has a restrictive CSP and avoids dynamic error HTML injection", async () => {
  const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../desktop/renderer/renderer.mjs", import.meta.url), "utf8");

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(renderer, /innerHTML\s*=\s*.*error/i);
});

test("desktop diagnostics are bounded and exposed through narrow IPC", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");

  assert.match(main, /MAX_DIAGNOSTIC_EVENTS\s*=\s*100/);
  assert.match(main, /slice\(-MAX_DIAGNOSTIC_EVENTS\)/);
  assert.match(main, /diagnostics:list/);
  assert.match(main, /diagnostics:clear/);
  assert.match(preload, /listDiagnostics/);
  assert.match(preload, /clearDiagnostics/);
});
