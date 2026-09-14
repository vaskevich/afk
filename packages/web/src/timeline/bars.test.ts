import { describe, expect, it } from "vitest";
import { T0_MS } from "@afk/shared/testing";
import { barSpansMs, typicalIntervalMs, FALLBACK_INTERVAL_MS } from "./bars.ts";

const seconds = (...offsets: number[]) => offsets.map((n) => T0_MS + n * 1000);

describe("barSpansMs", () => {
  it("runs each bar to the next sample when the samples keep their cadence", () => {
    const spans = barSpansMs(seconds(0, 5, 10, 15));

    expect(spans.slice(0, 3)).toEqual([5000, 5000, 5000]);
  });

  it("joins a sample to a neighbour that arrived a little late, 6 s after it on a 5 s cadence", () => {
    const spans = barSpansMs(seconds(0, 5, 10, 16, 21, 26));

    expect(spans[2]).toBe(6000);
  });

  it("still leaves a gap before a sample that is 20 s away on a 5 s cadence", () => {
    const spans = barSpansMs(seconds(0, 5, 10, 30, 35, 40));

    expect(spans[2]).toBe(7500);
    expect(spans[2]).toBeLessThan(20_000);
  });

  it("runs the last bar one typical interval past the last sample", () => {
    const spans = barSpansMs(seconds(0, 5, 10));

    expect(spans[2]).toBe(5000);
  });

  it("assumes the fallback interval for a single sample", () => {
    expect(barSpansMs(seconds(0))).toEqual([FALLBACK_INTERVAL_MS]);
  });

  it("returns nothing for no samples", () => {
    expect(barSpansMs([])).toEqual([]);
  });
});

describe("typicalIntervalMs", () => {
  it("is the median gap, so one outage in the middle does not stretch it", () => {
    expect(typicalIntervalMs(seconds(0, 5, 10, 70, 75, 80))).toBe(5000);
  });

  it("falls back when every gap is zero, as with samples stamped in the same second", () => {
    expect(typicalIntervalMs(seconds(0, 0, 0))).toBe(FALLBACK_INTERVAL_MS);
  });
});
