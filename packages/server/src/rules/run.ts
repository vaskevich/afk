import type { RunCollectorData, RunOutputTail } from "@afk/shared";
import { INACTIVE, Sustain, type Rule } from "./types.ts";

/** A wrapped command that has written nothing for this long is probably hung. */
const STALL_AFTER_MS = 60_000;

function totalBytes(data: RunCollectorData): number {
  // TODO(run): other output flavors may carry progress signals beyond byte counts.
  return data.output.stdoutBytes + data.output.stderrBytes;
}

function lastNonBlankLine(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() !== "") {
      return line;
    }
  }
  return undefined;
}

/** The line most likely to say why a command failed: stderr's last, or stdout's if stderr is empty. */
function failureReason(tail: RunOutputTail): string | undefined {
  return lastNonBlankLine(tail.stderr) ?? lastNonBlankLine(tail.stdout);
}

/**
 * The command ended. Info when it succeeded, critical when it did not. A point event.
 * When the final frame carries the output tail of a failure, the message ends with
 * the last line printed and the whole tail goes into `details.outputTail`.
 */
export const runExited: Rule<"run"> = {
  kind: "run.exited",
  collector: "run",
  create() {
    return {
      onFrame(frame) {
        const { state, exitCode, elapsedSeconds, output } = frame.data;
        if (state !== "exited") {
          return INACTIVE;
        }
        const failed = exitCode !== 0;
        const reason = output.tail === undefined ? undefined : failureReason(output.tail);
        const failure = `command failed with exit code ${exitCode ?? "unknown"} after ${elapsedSeconds}s`;
        return {
          active: true,
          instant: true,
          severity: failed ? "critical" : "info",
          message: failed
            ? reason === undefined
              ? failure
              : `${failure}: ${reason}`
            : `command finished successfully after ${elapsedSeconds}s`,
          ...(output.tail === undefined ? {} : { details: { outputTail: output.tail } }),
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
