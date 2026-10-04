import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { activateLocalAiLabRuntime } from "../desktop/runtime-host.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const rendererPath = join(projectRoot, "desktop", "renderer", "index.html");
const preloadPath = join(__dirname, "preload.cjs");

export async function activate({ hostWindow, webContents, dataRoot }) {
  const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  return activateLocalAiLabRuntime({
    hostWindow,
    webContents,
    trustedUrl: pathToFileURL(rendererPath).href,
    dataRoot,
    ipcPrefix: "local-ai-lab:",
    packaged: true,
    moduleVersion: pkg.version,
    enableUpdater: false
  });
}

export const modulePaths = {
  projectRoot,
  rendererPath,
  preloadPath,
  rendererUrl: pathToFileURL(rendererPath).href
};
