import test from "node:test";
import assert from "node:assert/strict";
import { classifyCoveragePlan, loadModelCatalog, loadModelRouting } from "../src/model/model-catalog.mjs";

test("model catalog has deterministic task routes and keeps heavy optional models out of auto routing", async () => {
  const catalog = await loadModelCatalog();
  const routing = await loadModelRouting(catalog);
  const ids = catalog.models.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(routing.routes["coverage-code"].includes("qwen2.5-coder-7b"));
  assert.equal(routing.routes.reviewer[0], "bonsai-2-27b");
  assert.equal(routing.routes.planner[0], "ministral-3-8b-reasoning");
  assert.ok(routing.routes.general.includes("qwen3-4b"));
  for (const optional of ["gemma-3-4b-it", "qwen3-vl-4b", "gpt-oss-20b", "qwen3-coder-30b-a3b"]) {
    assert.ok(!Object.values(routing.routes).flat().includes(optional), optional + " must remain manual-only");
  }
});

test("coverage plan classification chooses code specialist only for code-heavy repositories", async () => {
  const catalog = await loadModelCatalog();
  const routing = await loadModelRouting(catalog);
  const codePlan = {
    batches: [{ chunks: [{ path: "src/a.js" }, { path: "src/b.ts" }, { path: "README.md" }] }]
  };
  const contentPlan = {
    batches: [{ chunks: [{ path: "README.md" }, { path: "docs/guide.md" }, { path: "data.json" }] }]
  };
  assert.equal(classifyCoveragePlan(codePlan, routing), "coverage-code");
  assert.equal(classifyCoveragePlan(contentPlan, routing), "coverage-general");
});
