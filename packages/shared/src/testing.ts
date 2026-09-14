/**
 * Builders for tests. Every builder returns a valid, schema-conforming value with
 * boring defaults, and takes a partial override so a test states only what matters
 * to it. Import from "@afk/shared/testing"; never from app code.
 */
import type {
  AnomalyEvent,
  HostInfo,
  RunCollectorData,
  RunFrame,
  SessionSummary,
  StoredFrame,
  SystemCollectorData,
  SystemFrame,
} from "./protocol.ts";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS, MemoryPressureLevel } from "./protocol.ts";

type Frame = SystemFrame | RunFrame;

/** A fixed, readable origin for timestamps: 2026-01-01T00:00:00Z. */
export const T0_SECONDS = 1_767_225_600;
export const T0_MS = T0_SECONDS * 1000;

const GIB = 1024 ** 3;

export function makeHost(overrides: Partial<HostInfo> = {}): HostInfo {
  return {
    hostname: "test-host",
    platform: "darwin",
    osVersion: "26.0",
    cpuCount: 8,
    memoryTotalBytes: 16 * GIB,
    ...overrides,
  };
}

export function makeSystemData(
  overrides: Partial<{
    cpuPercent: number;
    pressureLevel: number;
    load: number;
    swapUsedBytes: number;
  }> = {},
): SystemCollectorData {
  const load = overrides.load ?? 2;
  return {
    cpu: { percent: overrides.cpuPercent ?? 20 },
    loadAverage: { oneMinute: load, fiveMinutes: load, fifteenMinutes: load },
    memory: {
      pressureLevel: overrides.pressureLevel ?? MemoryPressureLevel.Normal,
      totalBytes: 16 * GIB,
      freeBytes: 4 * GIB,
      activeBytes: 6 * GIB,
      inactiveBytes: 2 * GIB,
      wiredBytes: 3 * GIB,
      compressedBytes: 1 * GIB,
      swapUsedBytes: overrides.swapUsedBytes ?? 0,
      swapTotalBytes: 8 * GIB,
    },
  };
}

/**
 * A system frame `atSeconds` after T0. Sequence defaults to the offset plus one, so a
 * series built with consecutive offsets is automatically in order.
 */
export function makeSystemFrame(
  atSeconds: number,
  overrides: Partial<Parameters<typeof makeSystemData>[0]> & { sequence?: number } = {},
): SystemFrame {
  const { sequence, ...data } = overrides;
  return {
    stream: "system",
    collector: "system",
    sequence: sequence ?? atSeconds + 1,
    timestamp: T0_SECONDS + atSeconds,
    data: makeSystemData(data),
  };
}

export function makeRunData(overrides: Partial<RunCollectorData> = {}): RunCollectorData {
  return {
    command: "sleep 10",
    pid: 4242,
    state: "running",
    exitCode: null,
    elapsedSeconds: 0,
    process: { cpuPercent: 1, rssBytes: 10 * 1024 * 1024 },
    output: { flavor: "volume", stdoutBytes: 0, stderrBytes: 0 },
    ...overrides,
  };
}

export function makeRunFrame(
  atSeconds: number,
  overrides: Partial<RunCollectorData> & { sequence?: number; runId?: string } = {},
): RunFrame {
  const { sequence, runId, ...data } = overrides;
  return {
    stream: `run:${runId ?? "abcd1234"}`,
    collector: "run",
    sequence: sequence ?? atSeconds + 1,
    timestamp: T0_SECONDS + atSeconds,
    data: makeRunData({ elapsedSeconds: atSeconds, ...data }),
  };
}

/** Wraps frames as the server stores them, with indexes 1..n and a fixed receive time. */
export function makeStoredFrames(frames: readonly Frame[]): StoredFrame[] {
  return frames.map((frame, i) => ({
    index: i + 1,
    receivedAt: frame.timestamp * 1000 + 250,
    frame,
  }));
}

export function makeSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "sessionAAAAAAAAAAAAAAA",
    status: "active",
    host: makeHost(),
    clientVersion: "0.1.0",
    startedAt: T0_MS,
    endedAt: null,
    maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
    streamCount: 1,
    maxStreams: 10,
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<AnomalyEvent> = {}): AnomalyEvent {
  const startedAt = overrides.startedAt ?? T0_MS;
  const kind = overrides.kind ?? "cpu.high";
  const stream = overrides.stream ?? "system";
  return {
    id: `${stream}:${kind}:${startedAt}`,
    stream,
    kind,
    severity: "warning",
    message: "cpu above 90% for over 30s",
    startedAt,
    endedAt: null,
    ...overrides,
  };
}
