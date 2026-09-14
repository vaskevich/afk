import {
  EVENT_TOP_PROCESSES_MAX,
  MemoryPressureLevel,
  PROCESSES_TOP_MAX,
  RUN_TAIL_MAX_LINES,
} from "@afk/shared";
import type {
  AgentsCollectorData,
  AnomalyEvent,
  AnomalyEventDetails,
  FramesResponse,
  ProcessEntry,
  RunOutputTail,
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
 * `cpu-burn` node process dominating during the burn. A third, `run:…`, is a short
 * `afk run` of a fake migration that crashes with exit code 3; its final frame carries
 * the last lines it printed. A fourth, `agents`, counts the coding agents every 5 s:
 * two Claude Code sessions, one of which works (with two subagents for a while), asks
 * a question at 6:30 that goes unanswered until 10:00, then sits idle like the other;
 * and a Codex thread that appears at 3:00, works until 8:30, and then sits idle too,
 * so that from 10:00 every agent is idle. The anomaly events below are what the
 * server's rules would derive from these frames.
 */

/** What `deleteSession` rejects with; the same words the server answers `DELETE /api/sessions/demo` with. */
export const DEMO_DELETE_REFUSAL = "the demo session cannot be deleted";

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
/** A wrapped `scenarios/migration-hang --crash 3` that runs for 15 s from 4:00 and exits 3. */
const RUN_STREAM = "run:3f2a9c1e";
const RUN_START = 4 * 60;
const RUN_DURATION_SECONDS = 15;
const RUN_END = RUN_START + RUN_DURATION_SECONDS;
const RUN_COMMAND = "scenarios/migration-hang --crash 3 --hang-at 300 --rate 20";
const RUN_PID = 58120;
const RUN_EXIT_CODE = 3;
const RUN_TOTAL_ITEMS = 10_000;
const RUN_LINES_PER_SECOND = 20;
/** The scenario prints this many item lines and then dies. */
const RUN_CRASH_ITEM = 300;
const RUN_HEADER_LINE = `migration-hang: migrating ${RUN_TOTAL_ITEMS} items at ${RUN_LINES_PER_SECOND}/s, will exit ${RUN_EXIT_CODE} after item ${RUN_CRASH_ITEM} (pid ${RUN_PID})`;
const RUN_FATAL_LINE = `migration-hang: fatal: lost connection to database after item ${RUN_CRASH_ITEM}`;
/** The client samples agents every 5 s (AGENTS_INTERVAL_SECONDS in cli/afk). */
const AGENTS_STREAM = "agents";
const AGENTS_INTERVAL_SECONDS = 5;
/** Two Claude Code sessions all along: one busy, one idle. */
const AGENT_SESSIONS = 2;
/** The busy session fans out two subagents for a while. */
const AGENT_SUBAGENTS_START = 2 * 60;
const AGENT_SUBAGENTS_END = 5 * 60;
const AGENT_SUBAGENTS = 2;
/** Then asks a question nobody answers until 10:00, after which it is idle too. */
const AGENT_WAITING_START = 6 * 60 + 30;
const AGENT_WAITING_END = 10 * 60;
/** One Codex thread appears at 3:00, works until 8:30, and then sits idle. */
const CODEX_SESSIONS = 1;
const CODEX_START = 3 * 60;
const CODEX_WORKING_END = 8 * 60 + 30;
/** How long the server waits before calling a waiting agent an anomaly (AGENT_WAITING_AFTER_MS). */
const AGENT_WAITING_DELAY_SECONDS = 120;
/** How long every agent has to be idle before the server says so (AGENTS_ALL_IDLE_AFTER_MS). */
const AGENTS_ALL_IDLE_DELAY_SECONDS = 60;
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

/** What the migration has printed after `elapsed` seconds: the header, then 20 items a second. */
function migrationItemsAt(elapsed: number): number {
  return Math.min(RUN_CRASH_ITEM, elapsed * RUN_LINES_PER_SECOND);
}

function migrationLine(item: number): string {
  return `processing ${item}/${RUN_TOTAL_ITEMS} items`;
}

/** Cumulative stdout bytes, newlines included, as the client's byte counter would see them. */
function migrationStdoutBytes(items: number): number {
  let total = RUN_HEADER_LINE.length + 1;
  for (let item = 1; item <= items; item++) {
    total += migrationLine(item).length + 1;
  }
  return total;
}

/** The tail the client puts on the final frame: the last 20 item lines and the fatal line. */
function migrationTail(): RunOutputTail {
  const first = RUN_CRASH_ITEM - RUN_TAIL_MAX_LINES + 1;
  return {
    stdout: Array.from({ length: RUN_TAIL_MAX_LINES }, (_, i) => migrationLine(first + i)),
    stderr: [RUN_FATAL_LINE],
    // The header plus 300 item lines is far more than the 20 kept.
    truncated: true,
  };
}

/** The agents on the machine at second `i`: see the AGENT_* and CODEX_* constants for the story. */
function agentsAt(i: number): AgentsCollectorData {
  const waiting = i >= AGENT_WAITING_START && i < AGENT_WAITING_END;
  const working = i < AGENT_WAITING_START;
  const subagents = i >= AGENT_SUBAGENTS_START && i < AGENT_SUBAGENTS_END ? AGENT_SUBAGENTS : 0;
  const codexSessions = i >= CODEX_START ? CODEX_SESSIONS : 0;
  const codexWorking = i >= CODEX_START && i < CODEX_WORKING_END ? CODEX_SESSIONS : 0;
  return {
    available: true,
    claude: {
      sessions: AGENT_SESSIONS,
      working: working ? 1 : 0,
      waitingOnInput: waiting ? 1 : 0,
      idle: AGENT_SESSIONS - (working || waiting ? 1 : 0),
      subagentsWorking: subagents,
    },
    codex: {
      sessions: codexSessions,
      working: codexWorking,
      waitingOnInput: 0,
      idle: codexSessions - codexWorking,
      subagentsWorking: 0,
    },
  };
}

/** One frame of the run stream at `elapsed` seconds in; the last one is the exit. */
function runFrameData(elapsed: number): StoredFrame["frame"] {
  const exited = elapsed >= RUN_DURATION_SECONDS;
  const tail = migrationTail();
  return {
    stream: RUN_STREAM,
    collector: "run",
    sequence: elapsed + 1,
    timestamp: 0, // filled in by the caller
    data: {
      command: RUN_COMMAND,
      pid: RUN_PID,
      state: exited ? "exited" : "running",
      exitCode: exited ? RUN_EXIT_CODE : null,
      elapsedSeconds: elapsed,
      process: exited
        ? { cpuPercent: 0, rssBytes: 0 }
        : { cpuPercent: 2.5 + (elapsed % 3) * 0.4, rssBytes: 42 * MIB + elapsed * 64 * 1024 },
      output: {
        flavor: "volume",
        stdoutBytes: migrationStdoutBytes(migrationItemsAt(elapsed)),
        stderrBytes: exited ? RUN_FATAL_LINE.length + 1 : 0,
        ...(exited ? { tail } : {}),
      },
    },
  };
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
    stream: string,
    kind: string,
    severity: AnomalyEvent["severity"],
    startSeconds: number,
    endSeconds: number,
    message: string,
    details?: AnomalyEventDetails,
  ): AnomalyEvent => ({
    id: `${stream}:${kind}:${at(startSeconds)}`,
    stream,
    kind,
    severity,
    message,
    startedAt: at(startSeconds),
    endedAt: at(endSeconds),
    ...(details === undefined ? {} : { details }),
  });

  const flaps = PRESSURE_FLAPS.map(([start, end]) =>
    event(
      STREAM,
      "memory.pressure",
      "warning",
      start,
      end,
      `memory pressure at warn for ${end - start}s`,
    ),
  );
  const cpuHighStart = BURN_START + CPU_HIGH_DELAY_SECONDS;
  const details = topProcessesDetails(processesWhenCpuHighOpened);
  const topSummary = (details.topProcesses ?? [])
    .map((p) => `${commandBasename(p.command)} ${p.cpuPercent.toFixed(0)}%`)
    .join(", ");
  const outputTail = migrationTail();
  const events = [
    ...flaps,
    // An instant event: the run.exited rule ends the message with the last stderr line
    // and keeps the whole tail in details.
    event(
      RUN_STREAM,
      "run.exited",
      "critical",
      RUN_END,
      RUN_END,
      `command failed with exit code ${RUN_EXIT_CODE} after ${RUN_DURATION_SECONDS}s: ${RUN_FATAL_LINE}`,
      { outputTail },
    ),
    event(
      STREAM,
      "cpu.high",
      "warning",
      cpuHighStart,
      BURN_END,
      `cpu above 90% for ${describeSeconds(BURN_END - cpuHighStart)}, peak 97% (top: ${topSummary})`,
      details,
    ),
    event(
      STREAM,
      "memory.pressure",
      "warning",
      PRESSURE_WARN_START,
      PRESSURE_WARN_END,
      `memory pressure at warn for ${describeSeconds(PRESSURE_WARN_END - PRESSURE_WARN_START)}`,
    ),
    event(
      STREAM,
      "client.stale",
      "info",
      STALE_START,
      STALE_END,
      `no frames received for ${describeSeconds(STALE_END - STALE_START)}`,
    ),
    // Backdated to when the question was asked, though the rule only fires 2 m later;
    // the tool is named because only Claude Code sessions are waiting.
    event(
      AGENTS_STREAM,
      "agents.waiting",
      "warning",
      AGENT_WAITING_START,
      AGENT_WAITING_END,
      `1 Claude Code agent has been waiting on you for over ${AGENT_WAITING_DELAY_SECONDS / 60}m`,
    ),
    // Once the question is answered nothing is working any more, the Codex thread
    // included, so the count covers both tools and names neither; open until the end.
    event(
      AGENTS_STREAM,
      "agents.all-idle",
      "info",
      AGENT_WAITING_END,
      DURATION_SECONDS,
      `all ${AGENT_SESSIONS + CODEX_SESSIONS} agents idle for over ${AGENTS_ALL_IDLE_DELAY_SECONDS}s`,
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
    streamCount: 4,
    maxStreams: 10,
    previousSessionId: null,
    nextSessionId: null,
  };

  const frames: StoredFrame[] = [];
  // Separate generator for the processes stream so it does not disturb the cpu series.
  const processRand = prng(0xbadcafe);
  let systemSequence = 0;
  let processesSequence = 0;
  let agentsSequence = 0;
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

    if (i % AGENTS_INTERVAL_SECONDS === 0) {
      agentsSequence += 1;
      frames.push({
        index: frames.length + 1,
        receivedAt: timestamp * 1000 + 70 + Math.round(processRand() * 120),
        frame: {
          stream: AGENTS_STREAM,
          collector: "agents",
          sequence: agentsSequence,
          timestamp,
          data: agentsAt(i),
        },
      });
    }

    if (i >= RUN_START && i <= RUN_END) {
      frames.push({
        index: frames.length + 1,
        receivedAt: timestamp * 1000 + 80 + Math.round(rand() * 120),
        frame: { ...runFrameData(i - RUN_START), timestamp },
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
  // The page never offers it for the demo (SessionHeader hides the control), and the
  // server refuses it by name too; this is the same answer for anything that asks.
  deleteSession() {
    return Promise.reject(new Error(DEMO_DELETE_REFUSAL));
  },
};
