import { modelMatchesCatalogEntry } from "./model-catalog.mjs";

const JOB_PATTERN = /^job_[a-z0-9_-]+$/i;

function makeError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

export class LMStudioModelManager {
  constructor({ rootUrl = "http://127.0.0.1:1234", catalog, token = process.env.LM_API_TOKEN || "", timeoutMs = 30000 } = {}) {
    if (!catalog) throw new Error("catalog is required");
    this.rootUrl = String(rootUrl).replace(/\/$/, "");
    this.catalog = catalog;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async #request(path, { method = "GET", body = undefined } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { "content-type": "application/json" };
      if (this.token) headers.authorization = "Bearer " + this.token;
      const response = await fetch(this.rootUrl + path, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const text = await response.text();
      if (!response.ok) throw makeError("LM Studio model API failed (" + response.status + "): " + text.slice(0, 400), "LM_STUDIO_MODEL_API");
      return text ? JSON.parse(text) : {};
    } catch (error) {
      if (error?.name === "AbortError") throw makeError("LM Studio model API timed out", "LM_STUDIO_MODEL_API");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels() {
    const data = await this.#request("/api/v1/models");
    return Array.isArray(data.models) ? data.models : [];
  }

  resolveInstalled(entry, models) {
    return models.find((model) => model.type === "llm" && modelMatchesCatalogEntry(model, entry)) ?? null;
  }

  async snapshot() {
    const models = await this.listModels();
    return this.catalog.models.map((entry) => {
      if (entry.runtime !== "lm-studio") return { ...entry, installed: null, loaded: null, instances: [] };
      const installed = this.resolveInstalled(entry, models);
      return {
        ...entry,
        installed: Boolean(installed),
        loaded: Boolean(installed?.loaded_instances?.length),
        installedKey: installed?.key ?? "",
        displayName: installed?.display_name ?? entry.label,
        quantization: installed?.quantization?.name ?? installed?.selected_variant ?? "",
        sizeBytes: installed?.size_bytes ?? null,
        instances: (installed?.loaded_instances ?? []).map((instance) => ({
          id: instance.id,
          contextLength: instance.config?.context_length ?? null
        }))
      };
    });
  }

  async download(entry) {
    if (entry.runtime !== "lm-studio" || !entry.download?.model) {
      throw makeError("このモデルはアプリからダウンロードできません", "MODEL_DOWNLOAD_UNAVAILABLE");
    }
    return this.#request("/api/v1/models/download", {
      method: "POST",
      body: {
        model: entry.download.model,
        ...(entry.download.quantization ? { quantization: entry.download.quantization } : {})
      }
    });
  }

  async downloadStatus(jobId) {
    if (!JOB_PATTERN.test(String(jobId || ""))) throw new Error("Invalid model download job id");
    return this.#request("/api/v1/models/download/status/" + jobId);
  }

  async unloadInstance(instanceId) {
    if (!instanceId || typeof instanceId !== "string") throw new Error("Invalid model instance id");
    return this.#request("/api/v1/models/unload", { method: "POST", body: { instance_id: instanceId } });
  }

  async unloadEntry(entry) {
    if (entry.runtime !== "lm-studio") return { unloaded: 0 };
    const models = await this.listModels();
    const installed = this.resolveInstalled(entry, models);
    let unloaded = 0;
    for (const instance of installed?.loaded_instances ?? []) {
      await this.unloadInstance(instance.id);
      unloaded += 1;
    }
    return { unloaded };
  }

  async #unloadManagedExcept(entry, models) {
    for (const other of this.catalog.models) {
      if (other.runtime !== "lm-studio" || other.id === entry.id) continue;
      const installed = this.resolveInstalled(other, models);
      for (const instance of installed?.loaded_instances ?? []) await this.unloadInstance(instance.id);
    }
  }

  async unloadManaged() {
    const models = await this.listModels();
    let unloaded = 0;
    for (const entry of this.catalog.models) {
      if (entry.runtime !== "lm-studio") continue;
      const installed = this.resolveInstalled(entry, models);
      for (const instance of installed?.loaded_instances ?? []) {
        await this.unloadInstance(instance.id);
        unloaded += 1;
      }
    }
    return { unloaded };
  }

  async ensureLoaded(entry, { autoManage = true, allowLoad = true } = {}) {
    if (entry.runtime !== "lm-studio") throw new Error("ensureLoaded only supports LM Studio models");
    let models = await this.listModels();
    let installed = this.resolveInstalled(entry, models);
    if (!installed) throw makeError(entry.label + " はまだダウンロードされていません", "MODEL_NOT_INSTALLED");

    const current = installed.loaded_instances?.[0];
    if (current?.id) return { instanceId: current.id, model: installed, alreadyLoaded: true };

    if (!allowLoad) {
      throw makeError(entry.label + " は読み込まれていません。自動モデル管理をONにするか、先に手動で読み込んでください", "MODEL_NOT_LOADED");
    }

    if (autoManage) {
      await this.#unloadManagedExcept(entry, models);
      models = await this.listModels();
      installed = this.resolveInstalled(entry, models) ?? installed;
    }

    const result = await this.#request("/api/v1/models/load", {
      method: "POST",
      body: { model: installed.key, ...(entry.load ?? {}), echo_load_config: true }
    });
    return {
      instanceId: result.instance_id || installed.key,
      model: installed,
      alreadyLoaded: false,
      loadConfig: result.load_config ?? null
    };
  }
}
