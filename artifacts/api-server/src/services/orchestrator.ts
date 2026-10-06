export type RuntimeSnapshot = {
  activeWorkers: number;
  queuedJobs: number;
  maxWorkers: number;
  maxQueue: number;
  cpuUtilization: number;
  dvmRunning: boolean;
};

let activeWorkers = 0;
let queuedJobs = 0;
let maxWorkers = 4;
let maxQueue = 32;
let dvmRunning = false;
let previousCpu = process.cpuUsage();
let previousSample = process.hrtime.bigint();
let sampledCpuUtilization = 0;

function sampleCpu(): number {
  const currentTime = process.hrtime.bigint();
  const elapsedMicros = Number(currentTime - previousSample) / 1_000;
  if (elapsedMicros < 100_000) return sampledCpuUtilization;
  const currentCpu = process.cpuUsage();
  const usedMicros =
    currentCpu.user - previousCpu.user + currentCpu.system - previousCpu.system;
  previousCpu = currentCpu;
  previousSample = currentTime;
  sampledCpuUtilization = Math.min(1, Math.max(0, usedMicros / elapsedMicros));
  return sampledCpuUtilization;
}

export function updateDvmRuntime(input: {
  activeWorkers: number;
  queuedJobs: number;
  maxWorkers: number;
  maxQueue: number;
  running?: boolean;
}): void {
  activeWorkers = Math.max(0, input.activeWorkers);
  queuedJobs = Math.max(0, input.queuedJobs);
  maxWorkers = Math.max(1, input.maxWorkers);
  maxQueue = Math.max(1, input.maxQueue);
  if (input.running !== undefined) dvmRunning = input.running;
}

export function getRuntimeSnapshot(): RuntimeSnapshot {
  return {
    activeWorkers,
    queuedJobs,
    maxWorkers,
    maxQueue,
    cpuUtilization: Number(sampleCpu().toFixed(4)),
    dvmRunning,
  };
}

export function runtimePricingLoad() {
  const snapshot = getRuntimeSnapshot();
  return {
    queueLength: snapshot.queuedJobs + snapshot.activeWorkers,
    queueCapacity: snapshot.maxWorkers,
    cpuUtilization: snapshot.cpuUtilization,
  };
}
