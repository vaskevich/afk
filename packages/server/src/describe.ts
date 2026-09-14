import type { Frame } from "@afk/shared";

const GIB = 1024 ** 3;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)}G`;

/**
 * One-line human summary of a frame for server logs. Interpretation such as the
 * pressure label lives here on the server, not in the client, by design.
 */
export function describeFrame(frame: Frame): string {
  switch (frame.collector) {
    case "system": {
      const { cpu, loadAverage, memory } = frame.data;
      const pressure =
        { 1: "normal", 2: "warn", 4: "critical" }[memory.pressureLevel] ??
        `level ${memory.pressureLevel}`;
      const used = memory.activeBytes + memory.wiredBytes + memory.compressedBytes;
      return (
        `${frame.stream} #${frame.sequence} ` +
        `cpu=${cpu.percent.toFixed(1)}% load=${loadAverage.oneMinute.toFixed(2)} ` +
        `mem=${pressure} used=${gib(used)}/${gib(memory.totalBytes)} ` +
        `swap=${gib(memory.swapUsedBytes)}/${gib(memory.swapTotalBytes)}`
      );
    }
  }
}
