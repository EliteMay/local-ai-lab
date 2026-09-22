import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const RUN_SCHEMA_VERSION = 3;
export const PROMPT_SCHEMA_VERSION = "2026-09-21.2";

const AUDIT_ENGINE_SOURCE_FILES = [
  "./coverage-orchestrator.mjs",
  "./coverage-plan.mjs",
  "./coverage-synthesis.mjs",
  "./hierarchical-synthesis.mjs",
  "./response-schemas.mjs",
  "../roles/role-definitions.mjs",
  "../security/repo-reader.mjs"
];

function computeAuditEngineHash() {
  const hash = createHash("sha256");
  for (const relativePath of AUDIT_ENGINE_SOURCE_FILES) {
    const url = new URL(relativePath, import.meta.url);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(url, "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export const AUDIT_ENGINE_HASH = computeAuditEngineHash();

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
  const modelRoutingMode = String(config.modelRoutingMode || "fixed");
  const routingIdentity = config.modelRoutingIdentity && typeof config.modelRoutingIdentity === "object"
    ? config.modelRoutingIdentity
    : null;

  const relevantConfig = {
    model: modelRoutingMode === "fixed" ? (config.model ?? {}) : {},
    modelRoutingMode,
    modelRoutingIdentity: routingIdentity,
    limits: config.limits ?? {},
    orchestrator: config.orchestrator ?? {},
    context: config.context ?? {},
    coverage: config.coverage ?? {},
    repoReader: config.repoReader ?? {}
  };

  return {
    runSchemaVersion: RUN_SCHEMA_VERSION,
    appVersion: String(config.appVersion || "unknown"),
    modelRoutingMode,
    model: modelRoutingMode === "auto" ? "auto" : String(config.model?.model || "unknown"),
    modelProfile: modelRoutingMode === "auto" ? "auto" : String(config.activeModelProfile || "default"),
    providerName: modelRoutingMode === "auto" ? "multi-model-router" : String(config.model?.providerName || "LM Studio"),
    routingCatalogHash: routingIdentity?.catalogHash ?? null,
    routingHash: routingIdentity?.routingHash ?? null,
    autoManageModels: routingIdentity?.autoManageModels ?? null,
    configHash: sha256(relevantConfig),
    auditEngineHash: AUDIT_ENGINE_HASH,
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
  const commonKeys = [
    ["modelRoutingMode", "モデル運用"],
    ["configHash", "監査設定"],
    ["auditEngineHash", "監査Engine"]
  ];

  for (const [key, label] of commonKeys) {
    if (String(saved[key] ?? "") !== String(current[key] ?? "")) {
      reasons.push(`${label}が前回実行と異なります。`);
    }
  }

  if ((current.modelRoutingMode || "fixed") === "auto") {
    for (const [key, label] of [
      ["routingCatalogHash", "モデルCatalog"],
      ["routingHash", "モデル振り分けRule"],
      ["autoManageModels", "モデル自動管理設定"]
    ]) {
      if (String(saved[key] ?? "") !== String(current[key] ?? "")) {
        reasons.push(`${label}が前回実行と異なります。`);
      }
    }
  } else {
    for (const [key, label] of [
      ["model", "使用モデル"],
      ["modelProfile", "モデル設定"],
      ["providerName", "モデル実行環境"]
    ]) {
      if (String(saved[key] ?? "") !== String(current[key] ?? "")) {
        reasons.push(`${label}が前回実行と異なります。`);
      }
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
