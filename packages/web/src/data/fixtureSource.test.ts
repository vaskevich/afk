import { describe, expect, it } from "vitest";
import { FramesResponse } from "@afk/shared";
import { generateDemoSession } from "./fixtureSource.ts";

describe("generateDemoSession", () => {
  it("produces a session that validates against the FramesResponse schema", () => {
    const result = FramesResponse.safeParse(generateDemoSession("demo"));

    expect(result.success).toBe(true);
  });

  it("is deterministic: two calls produce identical output", () => {
    const first = generateDemoSession("demo");
    const second = generateDemoSession("demo");

    expect(second).toEqual(first);
  });

  it("only references streams that exist among its frames in every event", () => {
    const data = generateDemoSession("demo");
    const streams = new Set(data.frames.map((f) => f.frame.stream));

    for (const event of data.events) {
      expect(streams.has(event.stream)).toBe(true);
    }
  });

  it("has a gap in frame timestamps for the documented stale stretch", () => {
    const data = generateDemoSession("demo");
    const timestamps = data.frames.map((f) => f.frame.timestamp).sort((a, b) => a - b);

    let maxGapSeconds = 0;
    for (let i = 1; i < timestamps.length; i++) {
      maxGapSeconds = Math.max(maxGapSeconds, timestamps[i]! - timestamps[i - 1]!);
    }

    // The doc comment promises a 90 s stretch with no frames at all; the measured gap
    // between the last frame before it and the first frame after it is one second
    // wider, since STALE_END itself is excluded from the stretch but still marks the
    // far edge of the gap between samples.
    expect(maxGapSeconds).toBe(91);
  });

  it("samples the processes stream every 5 s, skipping the stale stretch", () => {
    const data = generateDemoSession("demo");
    const startSeconds = data.session.startedAt / 1000;

    const processes = data.frames.filter((f) => f.frame.stream === "processes");

    // 15 minutes at one sample per 5 s is 180 samples, minus the 18 that fall in the
    // 90 s stale stretch.
    expect(processes).toHaveLength(180 - 18);
    expect(processes.every((f) => (f.frame.timestamp - startSeconds) % 5 === 0)).toBe(true);
    expect(processes.map((f) => f.frame.sequence)).toEqual(processes.map((_, i) => i + 1));
  });

  it("gives the cpu.high event details matching the processes sample at its start", () => {
    const data = generateDemoSession("demo");
    const cpuHigh = data.events.find((event) => event.kind === "cpu.high")!;

    const atOpen = data.frames.find(
      (f) => f.frame.stream === "processes" && f.frame.timestamp * 1000 === cpuHigh.startedAt,
    )!;

    expect(atOpen.frame.collector).toBe("processes");
    if (atOpen.frame.collector === "processes") {
      const expected = atOpen.frame.data.top
        .slice(0, 3)
        .map(({ pid, cpuPercent, command }) => ({ pid, cpuPercent, command }));
      expect(cpuHigh.details).toEqual({ topProcesses: expected });
      expect(expected[0]!.command).toBe("/opt/homebrew/bin/node");
      expect(cpuHigh.message).toContain("(top: node ");
    }
  });
});
