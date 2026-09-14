import { MemoryPressureLevel } from "@afk/shared";
import { INACTIVE, Sustain, type Rule } from "./types.ts";

const CPU_HIGH_PERCENT = 90;
const CPU_HIGH_SUSTAIN_MS = 30_000;

/** Short sustain so a single flapping sample does not open and close an event. */
const MEMORY_PRESSURE_SUSTAIN_MS = 5_000;

/** Whole-machine cpu above a threshold for a sustained period. */
export const cpuHigh: Rule<"system"> = {
  kind: "cpu.high",
  collector: "system",
  create() {
    const sustain = new Sustain(CPU_HIGH_SUSTAIN_MS);
    return {
      onFrame(frame, atMs) {
        const since = sustain.update(frame.data.cpu.percent >= CPU_HIGH_PERCENT, atMs);
        if (since === null) {
          return INACTIVE;
        }
        return {
          active: true,
          severity: "warning",
          message: `cpu above ${CPU_HIGH_PERCENT}% for over ${CPU_HIGH_SUSTAIN_MS / 1000}s`,
          since,
        };
      },
    };
  },
};

/** Kernel memory pressure at warn or critical. */
export const memoryPressure: Rule<"system"> = {
  kind: "memory.pressure",
  collector: "system",
  create() {
    const sustain = new Sustain(MEMORY_PRESSURE_SUSTAIN_MS);
    return {
      onFrame(frame, atMs) {
        const level = frame.data.memory.pressureLevel;
        const since = sustain.update(level >= MemoryPressureLevel.Warn, atMs);
        if (since === null) {
          return INACTIVE;
        }
        const critical = level >= MemoryPressureLevel.Critical;
        return {
          active: true,
          severity: critical ? "critical" : "warning",
          message: critical ? "memory pressure is critical" : "memory pressure is high",
          since,
        };
      },
    };
  },
};
