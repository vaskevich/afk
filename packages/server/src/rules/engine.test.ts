import { describe, expect, it } from "vitest";
import {
  T0_MS,
  makeProcessesData,
  makeProcessesFrame,
  makeRunFrame,
  makeStoredFrames,
  makeSystemFrame,
} from "@afk/shared/testing";
import { RuleEngine } from "./engine.ts";
import { register, type Rule } from "./types.ts";

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

    it("carries no details and the plain message when there is no processes stream", () => {
      const engine = new RuleEngine();

      engine.onFrames(systemSeries(Array.from({ length: 31 }, () => 95)));

      expect(engine.events[0]).toEqual({
        id: `system:cpu.high:${T0_MS}`,
        stream: "system",
        kind: "cpu.high",
        severity: "warning",
        message: "cpu above 90% for over 30s",
        startedAt: T0_MS,
        endedAt: null,
      });
    });

    it("names the top three processes from the latest processes frame when it opens", () => {
      const engine = new RuleEngine();
      const highCpu = Array.from({ length: 31 }, (_, i) => makeSystemFrame(i, { cpuPercent: 95 }));
      const busy = makeProcessesFrame(25, { sequence: 1 });

      engine.onFrames(makeStoredFrames([...highCpu.slice(0, 26), busy, ...highCpu.slice(26)]));

      expect(engine.events).toHaveLength(1);
      expect(engine.events[0]).toMatchObject({
        kind: "cpu.high",
        message:
          "cpu above 90% for over 30s (top: node 180%, Google Chrome Helper 45%, WindowServer 20%)",
        details: {
          topProcesses: [
            { pid: 5821, cpuPercent: 180, command: "/opt/homebrew/bin/node" },
            {
              pid: 60300,
              cpuPercent: 45,
              command: expect.stringContaining("Google Chrome Helper"),
            },
            { pid: 442, cpuPercent: 20, command: expect.stringContaining("WindowServer") },
          ],
        },
      });
    });

    it("picks the busiest three by cpu even when the frame lists more, unsorted", () => {
      const engine = new RuleEngine();
      const [node, chrome, windowServer] = makeProcessesData().top;
      const unsorted = makeProcessesFrame(0, {
        top: [
          { ...windowServer!, cpuPercent: 5 },
          { ...chrome!, pid: 7, cpuPercent: 300, command: "/usr/bin/cpu-burn" },
          { ...node!, cpuPercent: 50 },
          { ...chrome!, cpuPercent: 120 },
        ],
      });

      engine.onFrames(
        makeStoredFrames([unsorted, ...Array.from({ length: 31 }, (_, i) => makeSystemFrame(i))]),
      );
      engine.onFrames(systemSeries(Array.from({ length: 31 }, () => 95)));

      expect(engine.events[0]).toMatchObject({
        message:
          "cpu above 90% for over 30s (top: cpu-burn 300%, Google Chrome Helper 120%, node 50%)",
        details: { topProcesses: [{ pid: 7 }, { pid: 60300 }, { pid: 5821 }] },
      });
    });

    it("keeps the snapshot taken at open even when a later processes frame changes the top", () => {
      const engine = new RuleEngine();
      engine.onFrames(
        makeStoredFrames([
          makeProcessesFrame(0),
          ...Array.from({ length: 31 }, (_, i) => makeSystemFrame(i, { cpuPercent: 95 })),
        ]),
      );
      const opened = { ...engine.events[0]! };
      const [node] = makeProcessesData().top;
      const laterTop = makeProcessesFrame(31, {
        sequence: 2,
        top: [{ ...node!, pid: 999, cpuPercent: 700, command: "/usr/bin/other" }],
      });

      const changed = engine.onFrames(
        makeStoredFrames([laterTop, makeSystemFrame(32, { cpuPercent: 95 })]),
      );

      expect(changed).toEqual([]);
      expect(engine.events[0]).toEqual(opened);
    });

    it("takes a fresh snapshot when the event closes and a new one opens", () => {
      const engine = new RuleEngine();
      engine.onFrames(
        makeStoredFrames([
          makeProcessesFrame(0),
          ...Array.from({ length: 31 }, (_, i) => makeSystemFrame(i, { cpuPercent: 95 })),
          makeSystemFrame(31, { cpuPercent: 10 }),
        ]),
      );
      const [node] = makeProcessesData().top;
      const secondBurn = makeProcessesFrame(40, {
        sequence: 2,
        top: [{ ...node!, pid: 999, cpuPercent: 700, command: "/usr/bin/other" }],
      });

      engine.onFrames(
        makeStoredFrames([
          secondBurn,
          ...Array.from({ length: 31 }, (_, i) => makeSystemFrame(40 + i, { cpuPercent: 95 })),
        ]),
      );

      expect(engine.events).toHaveLength(2);
      expect(engine.events[1]).toMatchObject({
        message: "cpu above 90% for over 30s (top: other 700%)",
        details: { topProcesses: [{ pid: 999, cpuPercent: 700, command: "/usr/bin/other" }] },
      });
    });
  });

  describe("RuleContext", () => {
    /** Reports, as an instant event per system frame, which processes frame the context exposes. */
    const probe: Rule<"system"> = {
      kind: "probe.latest",
      collector: "system",
      create() {
        return {
          onFrame(frame, _atMs, context) {
            const processes = context.latestFrame("processes");
            const own = context.latestFrame("system");
            return {
              active: true,
              instant: true,
              severity: "info",
              message: `processes=${processes?.frame.sequence ?? "none"} own=${own?.frame.sequence} self=${frame.sequence}`,
            };
          },
        };
      },
    };

    it("exposes the most recent frame of another stream as of each frame, in index order", () => {
      const engine = new RuleEngine([register(probe)]);

      engine.onFrames(
        makeStoredFrames([
          makeSystemFrame(0),
          makeProcessesFrame(1, { sequence: 1 }),
          makeSystemFrame(2, { sequence: 2 }),
          makeProcessesFrame(3, { sequence: 2 }),
          makeProcessesFrame(4, { sequence: 3 }),
          makeSystemFrame(5, { sequence: 3 }),
        ]),
      );

      expect(engine.events.map((event) => event.message)).toEqual([
        "processes=none own=1 self=1",
        "processes=1 own=2 self=2",
        "processes=3 own=3 self=3",
      ]);
    });

    it("hands ticks the same context as frames", () => {
      const ticker: Rule<"system"> = {
        kind: "probe.tick",
        collector: "system",
        create() {
          return {
            onFrame: () => ({ active: false, severity: "info", message: "" }),
            onTick(_nowMs, context) {
              return {
                active: true,
                instant: true,
                severity: "info",
                message: `processes=${context.latestFrame("processes")?.frame.sequence ?? "none"}`,
              };
            },
          };
        },
      };
      const engine = new RuleEngine([register(ticker)]);
      engine.onFrames(
        makeStoredFrames([makeSystemFrame(0), makeProcessesFrame(1, { sequence: 4 })]),
      );

      const changed = engine.onTick(seconds(10));

      expect(changed).toEqual([expect.objectContaining({ message: "processes=4" })]);
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
