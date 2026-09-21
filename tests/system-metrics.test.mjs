import test from "node:test";
import assert from "node:assert/strict";
import { calculateCpuUsage, parseNvidiaSmi, snapshotCpuTimes } from "../desktop/system-metrics.mjs";

test("system metrics calculates bounded CPU utilization from snapshots", () => {
  assert.equal(calculateCpuUsage(
    { idle: 200, total: 1000 },
    { idle: 250, total: 1200 }
  ), 75);
  assert.equal(calculateCpuUsage({ idle: 1, total: 1 }, { idle: 1, total: 1 }), null);
});

test("system metrics parses NVIDIA utilization and VRAM", () => {
  const parsed = parseNvidiaSmi("94, 7424, 8192\n");
  assert.equal(parsed.gpuPercent, 94);
  assert.equal(parsed.vramUsedBytes, 7424 * 1024 * 1024);
  assert.equal(parsed.vramTotalBytes, 8192 * 1024 * 1024);
  assert.equal(parseNvidiaSmi("not available"), null);
});

test("CPU snapshot aggregates every logical processor", () => {
  const snapshot = snapshotCpuTimes([
    { times: { user: 10, nice: 0, sys: 5, idle: 85, irq: 0 } },
    { times: { user: 20, nice: 0, sys: 10, idle: 70, irq: 0 } }
  ]);
  assert.deepEqual(snapshot, { idle: 155, total: 200 });
});
