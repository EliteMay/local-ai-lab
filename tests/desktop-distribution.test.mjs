import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function read(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("desktop distribution uses NSIS GitHub Releases auto update", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  assert.equal(pkg.version, "0.2.0");
  assert.equal(pkg.dependencies?.["electron-updater"], "6.8.9");
  assert.equal(pkg.devDependencies?.["electron-builder"], "26.15.3");
  assert.equal(pkg.build?.publish?.[0]?.provider, "github");
  assert.equal(pkg.build?.publish?.[0]?.owner, "EliteMay");
  assert.equal(pkg.build?.publish?.[0]?.repo, "local-ai-lab");
  assert.match(JSON.stringify(pkg.build?.win?.target), /nsis/);
  assert.equal(pkg.build?.asar, false);
  assert.match(pkg.build?.win?.artifactName || "", /local_ai_lab_/);
});

test("auto updater has fixed release provider and one-click install flow", async () => {
  const updater = await read("../desktop/updater.mjs");
  for (const marker of [
    "https://github.com/EliteMay/local-ai-lab/releases/latest",
    "autoUpdater.autoDownload = false",
    "autoUpdater.checkForUpdates()",
    "autoUpdater.downloadUpdate()",
    "autoUpdater.quitAndInstall(false, true)",
    "app.isPackaged",
    "update:check",
    "update:install",
    "update:open-release",
    "今すぐ更新"
  ]) {
    assert.ok(updater.includes(marker), "missing updater marker: " + marker);
  }
  assert.doesNotMatch(updater, /openExternal\(\s*(?:url|target)\s*\)/i);
});

test("packaged desktop runs CLI with Electron node mode and userData runtime storage", async () => {
  const main = await read("../desktop/main.mjs");
  const index = await read("../src/index.mjs");
  assert.match(main, /ELECTRON_RUN_AS_NODE/);
  assert.match(main, /LOCAL_AI_RUNTIME_DATA_ROOT/);
  assert.match(main, /app\.getPath\("userData"\)/);
  assert.match(main, /runtime-data/);
  assert.match(index, /process\.env\.LOCAL_AI_RUNTIME_DATA_ROOT/);
});

test("repository update is explicit clean-tree fast-forward only", async () => {
  const main = await read("../desktop/main.mjs");
  const preload = await read("../desktop/preload.cjs");
  const renderer = await read("../desktop/renderer/renderer.mjs");
  const html = await read("../desktop/renderer/index.html");
  assert.match(main, /repository:update/);
  assert.match(main, /status", "--porcelain/);
  assert.match(main, /fetch", "--prune", "origin/);
  assert.match(main, /pull", "--ff-only"/);
  assert.match(main, /未コミットの変更があるため更新を中止/);
  assert.match(preload, /updateRepository/);
  assert.match(renderer, /updateRepositoryFromGitHub/);
  assert.match(html, /GitHubから最新化/);
});

test("windows build workflow verifies installer updater metadata and immutable version release", async () => {
  const workflow = await read("../.github/workflows/build-windows.yml");
  for (const marker of [
    "npm run build:win",
    "dist/latest.yml",
    ".blockmap",
    "local_ai_lab_${version}_setup.exe",
    "gh release view",
    "already exists",
    "gh release create",
    "actions/upload-artifact@v4"
  ]) {
    assert.ok(workflow.includes(marker), "missing workflow marker: " + marker);
  }
});

test("renderer exposes app update controls and startup update preference", async () => {
  const html = await read("../desktop/renderer/index.html");
  const preload = await read("../desktop/preload.cjs");
  const renderer = await read("../desktop/renderer/renderer.mjs");
  assert.match(html, /id="checkUpdate"/);
  assert.match(html, /id="installUpdate"/);
  assert.match(html, /id="autoCheckUpdates"/);
  assert.match(preload, /checkForUpdate/);
  assert.match(preload, /installUpdate/);
  assert.match(preload, /onUpdateStatus/);
  assert.match(renderer, /applyUpdateState/);
  assert.match(renderer, /autoCheckUpdates/);
});
