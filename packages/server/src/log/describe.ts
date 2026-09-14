import { MemoryPressureLevel, type Frame } from "@afk/shared";

const GIB = 1024 ** 3;
const KIB = 1024;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)}G`;
const kib = (bytes: number) => `${(bytes / KIB).toFixed(1)}K`;

const MEMORY_PRESSURE_LABELS: Record<MemoryPressureLevel, string> = {
  [MemoryPressureLevel.Normal]: "normal",
  [MemoryPressureLevel.Warn]: "warn",
  [MemoryPressureLevel.Critical]: "critical",
};

/**
 * One-line human summary of a frame for server logs. Interpretation such as the
 * pressure label lives here on the server, not in the client, by design.
 */
export function describeFrame(frame: Frame): string {
  switch (frame.collector) {
    case "system": {
      const { cpu, loadAverage, memory } = frame.data;
      const pressure =
        MEMORY_PRESSURE_LABELS[memory.pressureLevel as MemoryPressureLevel] ??
        `level ${memory.pressureLevel}`;
      const used = memory.activeBytes + memory.wiredBytes + memory.compressedBytes;
      return (
        `${frame.stream} #${frame.sequence} ` +
        `cpu=${cpu.percent.toFixed(1)}% load=${loadAverage.oneMinute.toFixed(2)} ` +
        `mem=${pressure} used=${gib(used)}/${gib(memory.totalBytes)} ` +
        `swap=${gib(memory.swapUsedBytes)}/${gib(memory.swapTotalBytes)}`
      );
    }
    case "run": {
      const { command, state, exitCode, elapsedSeconds, process, output } = frame.data;
      const status = state === "exited" ? `exited=${exitCode}` : "running";
      return (
        `${frame.stream} #${frame.sequence} ${status} t=${elapsedSeconds}s ` +
        `out=${kib(output.stdoutBytes)} err=${kib(output.stderrBytes)} ` +
        `cpu=${process.cpuPercent}% rss=${kib(process.rssBytes)} (${command})`
      );
    }
  }
}
