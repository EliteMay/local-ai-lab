import { createHash } from "node:crypto";

export const RUN_SCHEMA_VERSION = 2;
export const PROMPT_SCHEMA_VERSION = "2026-09-21.1";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function buildExecutionIdentity(config = {}) {
  const relevantConfig = {
    model: config.model ?? {},
    limits: config.limits ?? {},
    orchestrator: config.orchestrator ?? {},
    context: config.context ?? {},
    coverage: config.coverage ?? {},
    repoReader: config.repoReader ?? {}
  };

  return {
    runSchemaVersion: RUN_SCHEMA_VERSION,
    appVersion: String(config.appVersion || "unknown"),
    model: String(config.model?.model || "unknown"),
    modelProfile: String(config.activeModelProfile || "default"),
    providerName: String(config.model?.providerName || "LM Studio"),
    configHash: sha256(relevantConfig),
    promptSchemaVersion: PROMPT_SCHEMA_VERSION
  };
}

export function compareResumeIdentity(saved, current) {
  if (!saved || typeof saved !== "object") {
    return {
      ok: false,
      reasons: ["この実行は旧版で作成され、使用モデル・設定Hashが記録されていません。"]
    };
  }

  const reasons = [];
  for (const [key, label] of [
    ["model", "使用モデル"],
    ["modelProfile", "モデル設定"],
    ["configHash", "監査設定"],
    ["promptSchemaVersion", "Prompt/Schema版"]
  ]) {
    if (String(saved[key] ?? "") !== String(current[key] ?? "")) {
      reasons.push(`${label}が前回実行と異なります。`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export function assertResumeIdentity(saved, current) {
  const comparison = compareResumeIdentity(saved, current);
  if (comparison.ok) return;
  const error = new Error(
    "安全に再開できません。前回と同じAI/監査設定であることを確認できません。\n" +
    comparison.reasons.join("\n") +
    "\n新しい全体監査として開始してください。保存済み結果は履歴から閲覧できます。"
  );
  error.code = "RUN_IDENTITY_MISMATCH";
  throw error;
}
