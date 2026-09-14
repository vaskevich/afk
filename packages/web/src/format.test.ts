import { describe, expect, it } from "vitest";
import { MemoryPressureLevel } from "@afk/shared";
import { formatDuration, formatGiB, formatOffset, formatPercent, pressureLabel } from "./format.ts";

const GIB = 1024 ** 3;

describe("formatGiB", () => {
  it("renders bytes as GiB with exactly one decimal", () => {
    expect(formatGiB(2 * GIB)).toBe("2.0 GiB");
  });

  it("rounds to the nearest tenth", () => {
    expect(formatGiB(2.34 * GIB)).toBe("2.3 GiB");
    expect(formatGiB(2.36 * GIB)).toBe("2.4 GiB");
  });
});

describe("formatPercent", () => {
  it("renders one decimal place with a percent sign", () => {
    expect(formatPercent(42.567)).toBe("42.6%");
  });

  it("rounds a whole number to .0", () => {
    expect(formatPercent(90)).toBe("90.0%");
  });
});

describe("formatOffset", () => {
  it("formats an offset under an hour as mm:ss", () => {
    expect(formatOffset(65)).toBe("01:05");
  });

  it("formats zero as 00:00", () => {
    expect(formatOffset(0)).toBe("00:00");
  });

  it("formats an offset of an hour or more as h:mm:ss", () => {
    expect(formatOffset(3661)).toBe("1:01:01");
  });

  it("clamps a negative offset to zero", () => {
    expect(formatOffset(-30)).toBe("00:00");
  });
});

describe("formatDuration", () => {
  it("renders a sub-minute duration as seconds", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("renders a sub-hour duration as minutes and seconds", () => {
    expect(formatDuration(61_234)).toBe("1m 01s");
  });

  it("renders an hour-plus duration as hours and minutes", () => {
    expect(formatDuration(3_661_000)).toBe("1h 01m");
  });

  it("clamps a negative duration to zero seconds", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("pressureLabel", () => {
  it("labels Normal as normal", () => {
    expect(pressureLabel(MemoryPressureLevel.Normal)).toBe("normal");
  });

  it("labels Warn as warn", () => {
    expect(pressureLabel(MemoryPressureLevel.Warn)).toBe("warn");
  });

  it("labels Critical as critical", () => {
    expect(pressureLabel(MemoryPressureLevel.Critical)).toBe("critical");
  });

  it("labels an unrecognized level as unknown", () => {
    expect(pressureLabel(99)).toBe("unknown");
  });
});
