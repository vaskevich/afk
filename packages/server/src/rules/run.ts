import type { RunCollectorData } from "@afk/shared";
import { INACTIVE, Sustain, type Rule } from "./types.ts";

/** A wrapped command that has written nothing for this long is probably hung. */
const STALL_AFTER_MS = 60_000;

function totalBytes(data: RunCollectorData): number {
  // TODO(run): other output flavors may carry progress signals beyond byte counts.
  return data.output.stdoutBytes + data.output.stderrBytes;
}

/** The command ended. Info when it succeeded, critical when it did not. A point event. */
export const runExited: Rule<"run"> = {
  kind: "run.exited",
  collector: "run",
  create() {
    return {
      onFrame(frame) {
        const { state, exitCode, elapsedSeconds } = frame.data;
        if (state !== "exited") {
          return INACTIVE;
        }
        const failed = exitCode !== 0;
        return {
          active: true,
          instant: true,
          severity: failed ? "critical" : "info",
          message: failed
            ? `command failed with exit code ${exitCode ?? "unknown"} after ${elapsedSeconds}s`
            : `command finished successfully after ${elapsedSeconds}s`,
        };
      },
    };
  },
};

/** The command is still running but its output has stopped growing. */
export const runStalled: Rule<"run"> = {
  kind: "run.stalled",
  collector: "run",
  create() {
    const sustain = new Sustain(STALL_AFTER_MS);
    let lastTotal: number | null = null;
    return {
      onFrame(frame, atMs) {
        const total = totalBytes(frame.data);
        const unchanged = lastTotal !== null && total === lastTotal;
        lastTotal = total;
        if (frame.data.state !== "running") {
          sustain.update(false, atMs);
          return INACTIVE;
        }
        const since = sustain.update(unchanged, atMs);
        if (since === null) {
          return INACTIVE;
        }
        return {
          active: true,
          severity: "warning",
          message: `no output for over ${STALL_AFTER_MS / 1000}s while still running`,
          since,
        };
      },
    };
  },
};
