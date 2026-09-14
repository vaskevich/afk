import { MemoryPressureLevel } from "@afk/shared";
import type { FramesResponse, StoredFrame, SessionSummary } from "@afk/shared";
import type { SessionSource } from "./source.ts";

/**
 * A deterministic ~15 minute ended session so the dashboard can be developed and
 * demoed without a server. The shape is deliberately "interesting": a quiet machine,
 * then a three minute cpu burn during which memory pressure goes to Warn and swap
 * starts creeping up.
 */

const DURATION_SECONDS = 15 * 60;
const BURN_START = 6 * 60;
const BURN_END = 9 * 60;
const GIB = 1024 ** 3;

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
  };

  const frames: StoredFrame[] = [];
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

    // Memory pressure lags the burn slightly and lingers after it.
    const pressureLevel =
      i >= BURN_START + 25 && i < BURN_END + 40
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

    const timestamp = startSeconds + i;
    frames.push({
      index: i + 1,
      receivedAt: timestamp * 1000 + 40 + Math.round(rand() * 120),
      frame: {
        stream: "system",
        collector: "system",
        sequence: i + 1,
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
  }

  return { session, frames };
}

export const fixtureSource: SessionSource = {
  load(sessionId) {
    return Promise.resolve(generateDemoSession(sessionId));
  },
};
