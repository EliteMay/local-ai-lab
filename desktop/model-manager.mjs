import { loadModelCatalog, findCatalogModel } from "../src/model/model-catalog.mjs";
import { LMStudioModelManager } from "../src/model/lm-studio-model-manager.mjs";

export function createDesktopModelManager({ registerIpc, readSettings, appendDiagnostic, isBusy }) {
  let catalog = null;
  let manager = null;
  const jobs = new Map();

  async function ensure() {
    if (!catalog) catalog = await loadModelCatalog();
    if (!manager) manager = new LMStudioModelManager({ catalog });
    return { catalog, manager };
  }

  async function jobStatusFor(modelId) {
    const job = jobs.get(modelId);
    if (!job?.job_id) return job ?? null;
    try {
      const { manager: active } = await ensure();
      const next = await active.downloadStatus(job.job_id);
      jobs.set(modelId, next);
      return next;
    } catch (error) {
      return { ...job, status: "failed", error: error.message };
    }
  }

  async function snapshot() {
    const { catalog: activeCatalog, manager: activeManager } = await ensure();
    let models;
    let providerAvailable = true;
    let providerMessage = "LM Studioのモデル管理APIに接続中";
    try {
      models = await activeManager.snapshot();
    } catch (error) {
      providerAvailable = false;
      providerMessage = "LM Studioのモデル管理APIへ接続できません。LM Studio 0.4以降とServer設定を確認してください。";
      models = activeCatalog.models.map((entry) => ({
        ...entry,
        installed: entry.runtime === "lm-studio" ? null : null,
        loaded: entry.runtime === "lm-studio" ? null : null,
        instances: []
      }));
    }

    for (const model of models) {
      model.downloadJob = await jobStatusFor(model.id);
    }

    return {
      providerAvailable,
      providerMessage,
      models
    };
  }

  async function download(modelId) {
    if (isBusy()) throw new Error("処理実行中はモデルをダウンロードできません。");
    const { catalog: activeCatalog, manager: activeManager } = await ensure();
    const entry = findCatalogModel(activeCatalog, modelId);
    if (!entry) throw new Error("モデルが見つかりません");
    const result = await activeManager.download(entry);
    jobs.set(entry.id, result);
    await appendDiagnostic({
      type: "model.download.started",
      modelId: entry.id,
      status: result.status,
      hasJob: Boolean(result.job_id)
    });
    return result;
  }

  async function load(modelId) {
    if (isBusy()) throw new Error("処理実行中はモデルを読み込めません。");
    const { catalog: activeCatalog, manager: activeManager } = await ensure();
    const entry = findCatalogModel(activeCatalog, modelId);
    if (!entry) throw new Error("モデルが見つかりません");
    if (entry.runtime !== "lm-studio") throw new Error("このモデルは専用の実行環境から起動します。");
    const settings = await readSettings();
    const result = await activeManager.ensureLoaded(entry, {
      autoManage: settings.autoManageModels !== false,
      allowLoad: true
    });
    await appendDiagnostic({
      type: "model.loaded",
      modelId: entry.id,
      alreadyLoaded: result.alreadyLoaded
    });
    return { ok: true, modelId: entry.id, instanceId: result.instanceId };
  }

  async function unload(modelId) {
    if (isBusy()) throw new Error("処理実行中はモデルを解放できません。");
    const { catalog: activeCatalog, manager: activeManager } = await ensure();
    const entry = findCatalogModel(activeCatalog, modelId);
    if (!entry) throw new Error("モデルが見つかりません");
    const result = await activeManager.unloadEntry(entry);
    await appendDiagnostic({ type: "model.unloaded", modelId: entry.id, unloaded: result.unloaded });
    return { ok: true, modelId: entry.id, ...result };
  }

  registerIpc("models:list", () => snapshot());
  registerIpc("models:download", (modelId) => download(String(modelId || "")));
  registerIpc("models:load", (modelId) => load(String(modelId || "")));
  registerIpc("models:unload", (modelId) => unload(String(modelId || "")));

  return { snapshot };
}
