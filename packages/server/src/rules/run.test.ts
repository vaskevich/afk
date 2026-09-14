import { describe, expect, it } from "vitest";
import type { RunOutputTail } from "@afk/shared";
import { T0_MS, makeRunFrame, makeRunTail, makeStoredFrames } from "@afk/shared/testing";
import { RuleEngine } from "./engine.ts";
import { runExited } from "./run.ts";
import { register } from "./types.ts";

const seconds = (n: number) => T0_MS + n * 1000;

/** An engine running only the rule under test, fed a run that ends at second 12. */
function exitedWith(exitCode: number, tail?: RunOutputTail) {
  const engine = new RuleEngine([register(runExited)]);
  engine.onFrames(
    makeStoredFrames([
      makeRunFrame(0),
      makeRunFrame(12, { state: "exited", exitCode, elapsedSeconds: 12, ...(tail && { tail }) }),
    ]),
  );
  return engine.events;
}

describe("run.exited", () => {
  it("ends a failure message with the last stderr line and keeps the whole tail in details", () => {
    const tail = makeRunTail({
      stdout: ["processing 299/10000 items", "processing 300/10000 items"],
      stderr: ["migration-hang: fatal: lost connection to database after item 300"],
    });

    const events = exitedWith(3, tail);

    expect(events).toEqual([
      {
        id: `run:abcd1234:run.exited:${seconds(12)}`,
        stream: "run:abcd1234",
        kind: "run.exited",
        severity: "critical",
        message:
          "command failed with exit code 3 after 12s: migration-hang: fatal: lost connection to database after item 300",
        startedAt: seconds(12),
        endedAt: seconds(12),
        details: { outputTail: tail },
      },
    ]);
  });

  it("falls back to the last stdout line when stderr is empty", () => {
    const tail = makeRunTail({ stdout: ["step 1 ok", "step 2 failed: timeout"], stderr: [] });

    const events = exitedWith(1, tail);

    expect(events[0]?.message).toBe(
      "command failed with exit code 1 after 12s: step 2 failed: timeout",
    );
  });

  it("skips blank trailing lines when picking the reason", () => {
    const tail = makeRunTail({ stderr: ["Error: boom", "", "   "] });

    const events = exitedWith(1, tail);

    expect(events[0]?.message).toBe("command failed with exit code 1 after 12s: Error: boom");
  });

  it("keeps the plain failure message and no details when the frame carries no tail", () => {
    const events = exitedWith(3);

    expect(events).toEqual([
      expect.objectContaining({
        severity: "critical",
        message: "command failed with exit code 3 after 12s",
      }),
    ]);
    expect(events[0]).not.toHaveProperty("details");
  });

  it("keeps the plain failure message when the tail has only blank lines", () => {
    const events = exitedWith(2, makeRunTail({ stdout: [""], stderr: [] }));

    expect(events[0]?.message).toBe("command failed with exit code 2 after 12s");
  });

  it("reports success as info with no details", () => {
    const events = exitedWith(0);

    expect(events).toEqual([
      expect.objectContaining({
        severity: "info",
        message: "command finished successfully after 12s",
      }),
    ]);
    expect(events[0]).not.toHaveProperty("details");
  });
});
