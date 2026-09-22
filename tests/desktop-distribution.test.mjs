import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function read(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("desktop distribution uses NSIS GitHub Releases auto update", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  assert.equal(pkg.version, "0.3.1");
  assert.equal(pkg.main, "desktop/main.mjs");
  assert.equal(pkg.dependencies?.["electron-updater"], "6.8.9");
  assert.equal(pkg.devDependencies?.["electron-builder"], "26.15.3");
  assert.equal(pkg.build?.publish?.[0]?.provider, "github");
  assert.equal(pkg.build?.publish?.[0]?.owner, "EliteMay");
  assert.equal(pkg.build?.publish?.[0]?.repo, "local-ai-lab");
  assert.match(JSON.stringify(pkg.build?.win?.target), /nsis/);
  assert.equal(pkg.build?.asar, false);
  assert.match(pkg.build?.win?.artifactName || "", /local_ai_lab_/);
  assert.equal(pkg.build?.win?.icon, "desktop/assets/generated/icon.ico");
  assert.equal(pkg.build?.win?.signAndEditExecutable, true);
  assert.equal(pkg.build?.win?.signExecutable, false);
});

test("auto updater has fixed provider and staged download/restart recovery flow", async () => {
  const updater = await read("../desktop/updater.mjs");
  for (const marker of [
    "https://github.com/EliteMay/local-ai-lab/releases/latest",
    "autoUpdater.autoDownload = false",
    "autoUpdater.checkForUpdates()",
    "autoUpdater.downloadUpdate()",
    "downloadedInstallerPath",
    "autoUpdater.quitAndInstall(false, true)",
    "shell.openPath(downloadedInstallerPath)",
    "app.isPackaged",
    "update:check",
    "update:install",
    "update:open-release",
    "ダウンロード",
    "再起動して更新"
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
  assert.match(html, /リモートから最新化/);
  assert.doesNotMatch(html, /GitHubから最新化/);
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
    "actions/upload-artifact@v4",
    "ErrorActionPreference = 'SilentlyContinue'",
    "tagLookupExit",
    "releaseLookupExit",
    "$global:LASTEXITCODE = 0"
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
  assert.match(renderer, /ダウンロード中/);
  assert.match(renderer, /再起動して更新/);
});


test("desktop builds a dedicated multi-size Local AI Lab icon", async () => {
  const pkg = JSON.parse(await read("../package.json"));
  const main = await read("../desktop/main.mjs");
  const source = await read("../desktop/assets/icon.svg");
  const generator = await read("../scripts/generate-app-icon.mjs");

  assert.equal(pkg.version, "0.3.0");
  assert.equal(pkg.build?.win?.icon, "desktop/assets/generated/icon.ico");
  assert.equal(pkg.build?.win?.signAndEditExecutable, true);
  assert.equal(pkg.build?.win?.signExecutable, false);
  assert.match(main, /icon:\s*join\(__dirname, "assets", "generated", process\.platform === "win32" \? "icon\.ico" : "icon\.png"\)/);
  assert.match(main, /setAppUserModelId\("local\.elitemay\.localailab"\)/);

  assert.match(source, /<svg/);
  assert.doesNotMatch(source, /<text/);
  assert.match(source, /#0B1220/);
  assert.match(source, /#6096FF/);
  assert.match(source, /#56E1D2/);

  assert.match(generator, /\[16, 24, 32, 48, 64, 128, 256, 512\]/);
  assert.match(generator, /pngToIco/);
  assert.equal(pkg.scripts?.["icon:build"], "node scripts/generate-app-icon.mjs");
  assert.match(pkg.scripts?.desktop || "", /npm run icon:build/);
  assert.match(pkg.scripts?.["build:win"] || "", /npm run icon:build/);
  assert.equal(pkg.devDependencies?.sharp, "^0.34.4");
  assert.equal(pkg.devDependencies?.["png-to-ico"], "^3.0.1");
});
