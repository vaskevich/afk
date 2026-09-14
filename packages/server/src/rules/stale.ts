import { INACTIVE, type Rule, type Verdict } from "./types.ts";

/** The system collector samples at 1 Hz, so silence this long means the client is gone or asleep. */
const STALE_AFTER_MS = 60_000;

/**
 * No frames from the machine for a while: the laptop went to sleep, lost its network,
 * or the client died. Opens on a tick, closes on the next frame. During replay the
 * engine ticks with each frame's timestamp, so a gap in history produces the same
 * closed event a live viewer would have seen.
 * TODO(clock): live ticks use the server clock; a skewed client clock shows up as a false gap.
 */
export const clientStale: Rule<"system"> = {
  kind: "client.stale",
  collector: "system",
  create() {
    let lastFrameAt: number | null = null;
    const verdict = (nowMs: number): Verdict => {
      if (lastFrameAt === null || nowMs - lastFrameAt < STALE_AFTER_MS) {
        return INACTIVE;
      }
      return {
        active: true,
        severity: "warning",
        message: `no data from the machine for over ${STALE_AFTER_MS / 1000}s`,
        since: lastFrameAt + STALE_AFTER_MS,
      };
    };
    return {
      onFrame(_frame, atMs) {
        lastFrameAt = atMs;
        return INACTIVE;
      },
      onTick(nowMs) {
        return verdict(nowMs);
      },
    };
  },
};
