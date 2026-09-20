import test from "node:test";
import assert from "node:assert/strict";
import { buildCommandSpec, isValidRunId } from "../src/desktop/command-spec.mjs";

test("coverage command uses direct argv without a shell string", () => {
  const spec = buildCommandSpec({
    command: "coverage",
    appRoot: "/tmp/local-ai-lab",
    modelProfile: "bonsai-2-27b",
    repository: "C:\\repo with spaces",
    goal: "監査する & echo unsafe",
  });
  assert.equal(spec.args[1], "coverage");
  assert.deepEqual(spec.args.slice(2), [
    "--repo",
    "C:\\repo with spaces",
    "--goal",
    "監査する & echo unsafe",
    "--model-profile",
    "bonsai-2-27b",
  ]);
});

test("tests command runs the node test runner", () => {
  const spec = buildCommandSpec({ command: "tests", appRoot: "/tmp/local-ai-lab" });
  assert.deepEqual(spec.args, ["--test"]);
});

test("invalid model profile and run id are rejected", () => {
  assert.throws(() => buildCommandSpec({
    command: "doctor",
    appRoot: "/tmp/local-ai-lab",
    modelProfile: "../../bad",
  }));
  assert.equal(isValidRunId("run-2026-09-20T10-00-00-000Z"), true);
  assert.equal(isValidRunId("../run-bad"), false);
});
