import os from "node:os";
import { spawn } from "node:child_process";

const NVIDIA_QUERY_ARGS = [
  "--query-gpu=utilization.gpu,memory.used,memory.total",
  "--format=csv,noheader,nounits"
];
const NVIDIA_TIMEOUT_MS = 1500;
const MB = 1024 * 1024;

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

export function snapshotCpuTimes(cpus = os.cpus()) {
  return cpus.reduce((acc, cpu) => {
    const times = cpu?.times ?? {};
    const idle = Number(times.idle) || 0;
    const total = Object.values(times).reduce((sum, value) => sum + (Number(value) || 0), 0);
    acc.idle += idle;
    acc.total += total;
    return acc;
  }, { idle: 0, total: 0 });
}

export function calculateCpuUsage(previous, current) {
  if (!previous || !current) return null;
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null;
  return clampPercent((1 - (idleDelta / totalDelta)) * 100);
}

export function parseNvidiaSmi(text) {
  const line = String(text || "").split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  if (!line) return null;
  const [gpu, usedMb, totalMb] = line.split(",").map((value) => Number(value.trim()));
  if (![gpu, usedMb, totalMb].every(Number.isFinite) || totalMb <= 0) return null;
  return {
    gpuPercent: clampPercent(gpu),
    vramUsedBytes: Math.round(usedMb * MB),
    vramTotalBytes: Math.round(totalMb * MB)
  };
}

function queryNvidiaMetrics({ spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    try {
      child = spawnImpl("nvidia-smi", NVIDIA_QUERY_ARGS, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      resolve(null);
      return;
    }

    child.stdout?.on?.("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4096) stdout = stdout.slice(-4096);
    });
    child.on?.("error", () => finish(null));
    child.on?.("close", (code) => finish(code === 0 ? parseNvidiaSmi(stdout) : null));

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(null);
    }, NVIDIA_TIMEOUT_MS);
    timer.unref?.();
  });
}

export function createSystemMetricsSampler({
  cpuSnapshot = () => snapshotCpuTimes(),
  totalMemory = () => os.totalmem(),
  freeMemory = () => os.freemem(),
  spawnImpl = spawn
} = {}) {
  let previousCpu = cpuSnapshot();

  return async function sampleSystemMetrics() {
    const currentCpu = cpuSnapshot();
    const cpuPercent = calculateCpuUsage(previousCpu, currentCpu);
    previousCpu = currentCpu;

    const memoryTotalBytes = Math.max(0, Number(totalMemory()) || 0);
    const memoryFreeBytes = Math.max(0, Number(freeMemory()) || 0);
    const memoryUsedBytes = Math.max(0, memoryTotalBytes - memoryFreeBytes);
    const gpu = await queryNvidiaMetrics({ spawnImpl });

    return {
      at: new Date().toISOString(),
      cpuPercent,
      memoryUsedBytes,
      memoryTotalBytes,
      gpuPercent: gpu?.gpuPercent ?? null,
      vramUsedBytes: gpu?.vramUsedBytes ?? null,
      vramTotalBytes: gpu?.vramTotalBytes ?? null,
      gpuAvailable: Boolean(gpu)
    };
  };
}
