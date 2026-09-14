import {
  EVENT_TOP_PROCESSES_MAX,
  MemoryPressureLevel,
  type AnomalyEventDetails,
  type ProcessesCollectorData,
} from "@afk/shared";
import { INACTIVE, Sustain, type Rule, type RuleContext } from "./types.ts";

const CPU_HIGH_PERCENT = 90;
const CPU_HIGH_SUSTAIN_MS = 30_000;

/** Short sustain so a single flapping sample does not open and close an event. */
const MEMORY_PRESSURE_SUSTAIN_MS = 5_000;

/** The stream the processes collector writes to; consulted when cpu.high opens. */
const PROCESSES_STREAM = "processes";

type TopProcesses = NonNullable<AnomalyEventDetails["topProcesses"]>;

/** The last path segment: "/opt/homebrew/bin/node" reads as "node" in a message. */
function commandBasename(command: string): string {
  return command.slice(command.lastIndexOf("/") + 1);
}

/** The busiest processes from the newest `processes` frame, or undefined when there is none. */
function topProcessesNow(context: RuleContext): TopProcesses | undefined {
  const latest = context.latestFrame(PROCESSES_STREAM);
  if (latest === undefined || latest.frame.collector !== "processes") {
    return undefined;
  }
  const data: ProcessesCollectorData = latest.frame.data;
  const busiest = [...data.top].sort((a, b) => b.cpuPercent - a.cpuPercent);
  return busiest
    .slice(0, EVENT_TOP_PROCESSES_MAX)
    .map(({ pid, cpuPercent, command }) => ({ pid, cpuPercent, command }));
}

function describeTopProcesses(top: TopProcesses): string {
  return top.map((p) => `${commandBasename(p.command)} ${p.cpuPercent.toFixed(0)}%`).join(", ");
}

/**
 * Whole-machine cpu above a threshold for a sustained period. When the event opens it
 * names the busiest processes from the latest `processes` frame, and keeps that
 * snapshot for as long as it stays open: the point is to say what was running when
 * the cpu went high, not to track the top list afterwards (and a changing message
 * would re-emit the event on every processes sample).
 */
export const cpuHigh: Rule<"system"> = {
  kind: "cpu.high",
  collector: "system",
  create() {
    const sustain = new Sustain(CPU_HIGH_SUSTAIN_MS);
    let snapshot: TopProcesses | undefined;
    let captured = false;
    return {
      onFrame(frame, atMs, context) {
        const since = sustain.update(frame.data.cpu.percent >= CPU_HIGH_PERCENT, atMs);
        if (since === null) {
          captured = false;
          snapshot = undefined;
          return INACTIVE;
        }
        if (!captured) {
          snapshot = topProcessesNow(context);
          captured = true;
        }
        const base = `cpu above ${CPU_HIGH_PERCENT}% for over ${CPU_HIGH_SUSTAIN_MS / 1000}s`;
        if (snapshot === undefined || snapshot.length === 0) {
          return { active: true, severity: "warning", message: base, since };
        }
        return {
          active: true,
          severity: "warning",
          message: `${base} (top: ${describeTopProcesses(snapshot)})`,
          since,
          details: { topProcesses: snapshot },
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
