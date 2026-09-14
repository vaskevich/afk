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
});
