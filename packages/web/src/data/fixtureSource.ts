import { EVENT_TOP_PROCESSES_MAX, MemoryPressureLevel, PROCESSES_TOP_MAX } from "@afk/shared";
import type {
  AnomalyEvent,
  AnomalyEventDetails,
  FramesResponse,
  ProcessEntry,
  StoredFrame,
  SessionSummary,
} from "@afk/shared";
import type { SessionSource } from "./source.ts";

/**
 * A deterministic ~15 minute ended session so the dashboard can be developed and
 * demoed without a server. The shape is deliberately "interesting": a quiet machine,
 * then a three minute cpu burn during which memory pressure goes to Warn and swap
 * starts creeping up. Earlier there is a short burst of pressure flaps (to exercise
 * marker clustering) and later a 90 s stretch with no frames at all (a stale client).
 * A second stream, `processes`, samples the busiest processes every 5 s and shows a
 * `cpu-burn` node process dominating during the burn. The anomaly events below are
 * what the server's rules would derive from these frames.
 */

const DURATION_SECONDS = 15 * 60;
const BURN_START = 6 * 60;
const BURN_END = 9 * 60;
/** How long the server waits before calling sustained cpu an anomaly. */
const CPU_HIGH_DELAY_SECONDS = 30;
/** Memory pressure lags the burn slightly and lingers after it. */
const PRESSURE_WARN_START = BURN_START + 25;
const PRESSURE_WARN_END = BURN_END + 40;
/** Three short pressure flaps within 40 s, as [start, end) offsets in seconds. */
const PRESSURE_FLAPS: ReadonlyArray<readonly [number, number]> = [
  [180, 185],
  [196, 200],
  [214, 220],
];
/** No frames at all for this stretch, as if the laptop went to sleep. */
const STALE_START = 11 * 60;
const STALE_END = STALE_START + 90;
const STREAM = "system";
const PROCESSES_STREAM = "processes";
/** The client samples processes every 5 s (PROCESSES_INTERVAL_SECONDS in cli/afk). */
const PROCESSES_INTERVAL_SECONDS = 5;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** The workload behind the burn: `scenarios/cpu-burn`, one worker thread per core. */
const BURN_PROCESS = {
  pid: 51234,
  parentPid: 51200,
  command: "/opt/homebrew/bin/node",
};

/** What the machine is usually doing; cpu wobbles around these, memory is steady. */
const BACKGROUND_PROCESSES: readonly ProcessEntry[] = [
  {
    pid: 442,
    parentPid: 1,
    cpuPercent: 12,
    memoryPercent: 0.5,
    rssBytes: 96 * MIB,
    command: "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer",
  },
  {
    pid: 60300,
    parentPid: 13869,
    cpuPercent: 9,
    memoryPercent: 1.4,
    rssBytes: 320 * MIB,
    command:
      "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)",
  },
  {
    pid: 38445,
    parentPid: 38440,
    cpuPercent: 6,
    memoryPercent: 0.3,
    rssBytes: 54 * MIB,
    command:
      "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper",
  },
  {
    pid: 0,
    parentPid: 0,
    cpuPercent: 4,
    memoryPercent: 0.1,
    rssBytes: 20 * MIB,
    command: "kernel_task",
  },
  {
    pid: 13869,
    parentPid: 1,
    cpuPercent: 3,
    memoryPercent: 0.9,
    rssBytes: 290 * MIB,
    command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
  {
    pid: 95541,
    parentPid: 1,
    cpuPercent: 2,
    memoryPercent: 0.1,
    rssBytes: 18 * MIB,
    command:
      "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared",
  },
  {
    pid: 812,
    parentPid: 1,
    cpuPercent: 1.5,
    memoryPercent: 0.2,
    rssBytes: 48 * MIB,
    command: "/usr/libexec/coreduetd",
  },
  {
    pid: 2210,
    parentPid: 1,
    cpuPercent: 1,
    memoryPercent: 0.4,
    rssBytes: 120 * MIB,
    command: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
  },
  {
    pid: 3320,
    parentPid: 2210,
    cpuPercent: 0.5,
    memoryPercent: 0.1,
    rssBytes: 22 * MIB,
    command: "/opt/homebrew/bin/fish",
  },
  {
    pid: 1,
    parentPid: 0,
    cpuPercent: 0.2,
    memoryPercent: 0.1,
    rssBytes: 14 * MIB,
    command: "/sbin/launchd",
  },
];

/** mulberry32: tiny seeded PRNG so the fixture is identical on every load. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const bytes = (gib: number) => Math.round(gib * GIB);

/** "45s" or "2m 30s", for event messages. */
function describeSeconds(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function isFlapping(second: number): boolean {
  return PRESSURE_FLAPS.some(([start, end]) => second >= start && second < end);
}

/**
 * The busiest processes at second `i`: the background set with a little wobble, plus
 * the burn process while the burn is on. cpu descending, capped like the client does.
 */
function processesAt(
  i: number,
  machineCpuPercent: number,
  cpuCount: number,
  rand: () => number,
): ProcessEntry[] {
  const entries: ProcessEntry[] = BACKGROUND_PROCESSES.map((p) => ({
    ...p,
    cpuPercent: Math.round(p.cpuPercent * (0.6 + rand() * 0.8) * 10) / 10,
  }));
  if (i >= BURN_START && i < BURN_END) {
    // The burn takes the whole machine: its %cpu is close to cores x 100.
    const burnCpu = Math.round(machineCpuPercent * cpuCount * (0.94 + rand() * 0.04) * 10) / 10;
    entries.push({
      ...BURN_PROCESS,
      cpuPercent: burnCpu,
      memoryPercent: 0.8,
      rssBytes: 260 * MIB,
    });
  }
  entries.sort((a, b) => b.cpuPercent - a.cpuPercent);
  return entries.slice(0, PROCESSES_TOP_MAX);
}

/** What the server's cpu.high rule snapshots into `details` when it opens: the busiest three. */
function topProcessesDetails(top: readonly ProcessEntry[]): AnomalyEventDetails {
  return {
    topProcesses: top
      .slice(0, EVENT_TOP_PROCESSES_MAX)
      .map(({ pid, cpuPercent, command }) => ({ pid, cpuPercent, command })),
  };
}

function commandBasename(command: string): string {
  return command.slice(command.lastIndexOf("/") + 1);
}

/**
 * Events in the shape the server will produce: id is `<stream>:<kind>:<startedAt>`.
 * `processesWhenCpuHighOpened` is the processes frame the rule would have consulted.
 */
function demoEvents(
  startedAt: number,
  processesWhenCpuHighOpened: readonly ProcessEntry[],
): AnomalyEvent[] {
  const at = (seconds: number) => startedAt + seconds * 1000;
  const event = (
    kind: string,
    severity: AnomalyEvent["severity"],
    startSeconds: number,
    endSeconds: number,
    message: string,
    details?: AnomalyEventDetails,
  ): AnomalyEvent => ({
    id: `${STREAM}:${kind}:${at(startSeconds)}`,
    stream: STREAM,
    kind,
    severity,
    message,
    startedAt: at(startSeconds),
    endedAt: at(endSeconds),
    ...(details === undefined ? {} : { details }),
  });

  const flaps = PRESSURE_FLAPS.map(([start, end]) =>
    event("memory.pressure", "warning", start, end, `memory pressure at warn for ${end - start}s`),
  );
  const cpuHighStart = BURN_START + CPU_HIGH_DELAY_SECONDS;
  const details = topProcessesDetails(processesWhenCpuHighOpened);
  const topSummary = (details.topProcesses ?? [])
    .map((p) => `${commandBasename(p.command)} ${p.cpuPercent.toFixed(0)}%`)
    .join(", ");
  const events = [
    ...flaps,
    event(
      "cpu.high",
      "warning",
      cpuHighStart,
      BURN_END,
      `cpu above 90% for ${describeSeconds(BURN_END - cpuHighStart)}, peak 97% (top: ${topSummary})`,
      details,
    ),
    event(
      "memory.pressure",
      "warning",
      PRESSURE_WARN_START,
      PRESSURE_WARN_END,
      `memory pressure at warn for ${describeSeconds(PRESSURE_WARN_END - PRESSURE_WARN_START)}`,
    ),
    event(
      "client.stale",
      "info",
      STALE_START,
      STALE_END,
      `no frames received for ${describeSeconds(STALE_END - STALE_START)}`,
    ),
  ];
  events.sort((a, b) => a.startedAt - b.startedAt);
  return events;
}

export function generateDemoSession(sessionId: string): FramesResponse {
  const rand = prng(0xafc0ffee);
  // Fixed start so timestamps are stable across reloads: 2026-09-14 09:12:00 UTC.
  const startedAt = Date.UTC(2026, 8, 14, 9, 12, 0);
  const startSeconds = Math.floor(startedAt / 1000);

  const memoryTotalBytes = bytes(32);
  const swapTotalBytes = bytes(4);

  const session: SessionSummary = {
    sessionId,
    status: "ended",
    host: {
      hostname: "olegs-macbook.local",
      platform: "darwin",
      osVersion: "26.5.0",
      cpuCount: 12,
      memoryTotalBytes,
    },
    clientVersion: "0.1.0",
    startedAt,
    endedAt: startedAt + DURATION_SECONDS * 1000,
    maxDurationSeconds: 60 * 60,
    streamCount: 2,
    maxStreams: 10,
  };

  const frames: StoredFrame[] = [];
  // Separate generator for the processes stream so it does not disturb the cpu series.
  const processRand = prng(0xbadcafe);
  let systemSequence = 0;
  let processesSequence = 0;
  /** The busiest processes as of the last processes sample at or before cpu.high opened. */
  let processesWhenCpuHighOpened: ProcessEntry[] = [];
  // Low-pass filtered noise so the cpu line wobbles instead of looking like static.
  let cpuNoise = 0;
  let load1 = 1.8;
  let swapUsed = bytes(0.4);

  for (let i = 0; i < DURATION_SECONDS; i++) {
    const inBurn = i >= BURN_START && i < BURN_END;
    // Ramp in/out over ~8 s so the edges of the burn are not perfectly vertical.
    const burnWeight = clamp(Math.min((i - BURN_START + 4) / 8, (BURN_END + 4 - i) / 8), 0, 1);

    cpuNoise = cpuNoise * 0.85 + (rand() - 0.5) * 6;
    const baseline = 20 + 4 * Math.sin(i / 47) + cpuNoise;
    const burn = 95 + (rand() - 0.5) * 4;
    const cpuPercent = clamp(baseline + (burn - baseline) * burnWeight, 0, 100);

    const targetLoad = (cpuPercent / 100) * session.host.cpuCount * 1.05;
    load1 += (targetLoad - load1) / 60;
    const load5 = load1 * (inBurn ? 0.7 : 1.1);
    const load15 = load1 * (inBurn ? 0.5 : 1.15);

    const pressureLevel =
      (i >= PRESSURE_WARN_START && i < PRESSURE_WARN_END) || isFlapping(i)
        ? MemoryPressureLevel.Warn
        : MemoryPressureLevel.Normal;

    // Swap creeps up slowly all session, faster while under pressure.
    swapUsed += bytes(0.0004) + (pressureLevel === MemoryPressureLevel.Warn ? bytes(0.003) : 0);
    swapUsed = Math.min(swapUsed, swapTotalBytes);

    const activeBytes = bytes(11.5 + 6 * burnWeight + Math.sin(i / 90));
    const wiredBytes = bytes(3.1 + 0.4 * burnWeight);
    const compressedBytes = bytes(2.2 + 2.5 * burnWeight);
    const inactiveBytes = bytes(6.5 - 2 * burnWeight);
    const freeBytes = Math.max(
      bytes(0.25),
      memoryTotalBytes - activeBytes - wiredBytes - compressedBytes - inactiveBytes,
    );

    // The stale stretch produces no frames; sequence and index simply continue after it.
    if (i >= STALE_START && i < STALE_END) {
      continue;
    }

    const timestamp = startSeconds + i;
    systemSequence += 1;
    frames.push({
      index: frames.length + 1,
      receivedAt: timestamp * 1000 + 40 + Math.round(rand() * 120),
      frame: {
        stream: STREAM,
        collector: "system",
        sequence: systemSequence,
        timestamp,
        data: {
          cpu: { percent: Math.round(cpuPercent * 10) / 10 },
          loadAverage: {
            oneMinute: Math.round(load1 * 100) / 100,
            fiveMinutes: Math.round(load5 * 100) / 100,
            fifteenMinutes: Math.round(load15 * 100) / 100,
          },
          memory: {
            pressureLevel,
            totalBytes: memoryTotalBytes,
            freeBytes,
            activeBytes,
            inactiveBytes,
            wiredBytes,
            compressedBytes,
            swapUsedBytes: Math.round(swapUsed),
            swapTotalBytes,
          },
        },
      },
    });

    if (i % PROCESSES_INTERVAL_SECONDS === 0) {
      const top = processesAt(i, cpuPercent, session.host.cpuCount, processRand);
      if (i <= BURN_START + CPU_HIGH_DELAY_SECONDS) {
        processesWhenCpuHighOpened = top;
      }
      processesSequence += 1;
      frames.push({
        index: frames.length + 1,
        receivedAt: timestamp * 1000 + 60 + Math.round(processRand() * 120),
        frame: {
          stream: PROCESSES_STREAM,
          collector: "processes",
          sequence: processesSequence,
          timestamp,
          data: {
            sampledCount: 400 + Math.round(processRand() * 30),
            top,
          },
        },
      });
    }
  }

  return { session, frames, events: demoEvents(startedAt, processesWhenCpuHighOpened) };
}

export const fixtureSource: SessionSource = {
  load(sessionId) {
    return Promise.resolve(generateDemoSession(sessionId));
  },
  // The demo session is already over, so there is nothing to follow.
  // TODO(dev): optionally replay the generated tail on a timer to exercise live mode offline.
  subscribe(_sessionId, _afterIndex, handlers) {
    handlers.onConnection("closed");
    return () => {};
  },
};
