import { describe, expect, it } from "vitest";
import { T0_MS, makeRunFrame, makeStoredFrames, makeSystemFrame } from "@afk/shared/testing";
import { RuleEngine } from "./engine.ts";

/**
 * The reference test for this repo (see docs/TESTING.md). Notes on the style:
 * - Time is explicit: frames are built at fixed offsets from T0, never from Date.now().
 * - Inputs come from the shared builders; each test overrides only what it is about.
 * - Assertions are on the public output (the events), not on internal rule state.
 * - One behaviour per test, named as the sentence it proves.
 */

/** A run of system frames, one per second, with the given cpu percent at each offset. */
function systemSeries(cpuByOffset: readonly number[]) {
  return makeStoredFrames(cpuByOffset.map((cpuPercent, i) => makeSystemFrame(i, { cpuPercent })));
}

const seconds = (n: number) => T0_MS + n * 1000;

describe("RuleEngine", () => {
  describe("cpu.high", () => {
    it("stays quiet while cpu is high for less than 30 s", () => {
      const engine = new RuleEngine();
      const highFor20s = systemSeries(Array.from({ length: 21 }, () => 95));

      const changed = engine.onFrames(highFor20s);

      expect(changed).toEqual([]);
      expect(engine.events).toEqual([]);
    });

    it("opens an event once cpu has been above 90% for 30 s, backdated to the first high sample", () => {
      const engine = new RuleEngine();
      const idleThenHigh = systemSeries([
        ...Array.from({ length: 5 }, () => 10),
        ...Array.from({ length: 31 }, () => 95),
      ]);

      engine.onFrames(idleThenHigh);

      expect(engine.events).toHaveLength(1);
      expect(engine.events[0]).toMatchObject({
        kind: "cpu.high",
        stream: "system",
        severity: "warning",
        startedAt: seconds(5),
        endedAt: null,
      });
    });

    it("closes the event when cpu drops, keeping the same id", () => {
      const engine = new RuleEngine();
      engine.onFrames(systemSeries(Array.from({ length: 31 }, () => 95)));
      const opened = engine.events[0]!;

      const changed = engine.onFrames(makeStoredFrames([makeSystemFrame(31, { cpuPercent: 12 })]));

      expect(changed).toEqual([opened]);
      expect(opened.endedAt).toBe(seconds(31));
      expect(opened.id).toBe(`system:cpu.high:${T0_MS}`);
    });
  });

  describe("client.stale", () => {
    it("turns a gap in replayed frames into a closed event covering the silence", () => {
      const engine = new RuleEngine();
      const beforeGap = makeSystemFrame(0);
      const afterGap = makeSystemFrame(200, { sequence: 2 });

      engine.onFrames(makeStoredFrames([beforeGap, afterGap]));

      expect(engine.events).toEqual([
        expect.objectContaining({
          kind: "client.stale",
          startedAt: seconds(60),
          endedAt: seconds(200),
        }),
      ]);
    });

    it("opens on a live tick and closes on the next frame", () => {
      const engine = new RuleEngine();
      engine.onFrames(makeStoredFrames([makeSystemFrame(0)]));

      const onTick = engine.onTick(seconds(90));
      // The engine hands out its live event objects, so check before the next step mutates them.
      expect(onTick).toEqual([
        expect.objectContaining({ kind: "client.stale", startedAt: seconds(60), endedAt: null }),
      ]);

      const onFrame = engine.onFrames(makeStoredFrames([makeSystemFrame(91, { sequence: 2 })]));
      expect(onFrame).toEqual([expect.objectContaining({ endedAt: seconds(91) })]);
    });
  });

  describe("run rules", () => {
    it("records a non-zero exit as an instant critical event", () => {
      const engine = new RuleEngine();
      const frames = makeStoredFrames([
        makeRunFrame(0),
        makeRunFrame(1, { state: "exited", exitCode: 3, elapsedSeconds: 1 }),
      ]);

      engine.onFrames(frames);

      expect(engine.events).toEqual([
        expect.objectContaining({
          kind: "run.exited",
          severity: "critical",
          startedAt: seconds(1),
          endedAt: seconds(1),
        }),
      ]);
    });

    it("flags a running command whose output has not grown for 60 s", () => {
      const engine = new RuleEngine();
      const stalled = makeStoredFrames(
        Array.from({ length: 62 }, (_, i) =>
          makeRunFrame(i, { output: { flavor: "volume", stdoutBytes: 1000, stderrBytes: 0 } }),
        ),
      );

      engine.onFrames(stalled);

      expect(engine.events).toEqual([
        expect.objectContaining({ kind: "run.stalled", startedAt: seconds(1), endedAt: null }),
      ]);
    });
  });

  it("closeAll ends every open event at the given time", () => {
    const engine = new RuleEngine();
    engine.onFrames(systemSeries(Array.from({ length: 31 }, () => 95)));

    const closed = engine.closeAll(seconds(40));

    expect(closed).toHaveLength(1);
    expect(engine.events.every((e) => e.endedAt === seconds(40))).toBe(true);
  });
});
