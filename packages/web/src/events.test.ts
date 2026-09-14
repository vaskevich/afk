import { describe, expect, it } from "vitest";
import { T0_MS, makeEvent } from "@afk/shared/testing";
import { eventEndMs, isOpenEvent, pluralize, worstSeverity } from "./events.ts";

const seconds = (n: number) => T0_MS + n * 1000;

describe("isOpenEvent", () => {
  it("is true when endedAt is null", () => {
    expect(isOpenEvent(makeEvent({ endedAt: null }))).toBe(true);
  });

  it("is false once endedAt is set", () => {
    expect(isOpenEvent(makeEvent({ endedAt: seconds(5) }))).toBe(false);
  });
});

describe("eventEndMs", () => {
  it("returns endedAt when the event has closed", () => {
    expect(eventEndMs(makeEvent({ endedAt: seconds(5) }), seconds(100))).toBe(seconds(5));
  });

  it("returns latest while the event is still open", () => {
    expect(eventEndMs(makeEvent({ endedAt: null }), seconds(100))).toBe(seconds(100));
  });
});

describe("worstSeverity", () => {
  it("returns null for an empty list", () => {
    expect(worstSeverity([])).toBeNull();
  });

  it("returns the only severity present", () => {
    expect(worstSeverity([makeEvent({ severity: "warning" })])).toBe("warning");
  });

  it("ranks critical above warning above info", () => {
    const events = [
      makeEvent({ severity: "info" }),
      makeEvent({ severity: "critical" }),
      makeEvent({ severity: "warning" }),
    ];

    expect(worstSeverity(events)).toBe("critical");
  });

  it("is not affected by list order", () => {
    const events = [makeEvent({ severity: "critical" }), makeEvent({ severity: "info" })];

    expect(worstSeverity(events)).toBe("critical");
    expect(worstSeverity([...events].reverse())).toBe("critical");
  });
});

describe("pluralize", () => {
  it("uses the singular form for a count of one", () => {
    expect(pluralize(1, "event")).toBe("1 event");
  });

  it("uses the default plural form (singular + s) otherwise", () => {
    expect(pluralize(0, "event")).toBe("0 events");
    expect(pluralize(3, "event")).toBe("3 events");
  });

  it("uses an explicit irregular plural when given one", () => {
    expect(pluralize(2, "anomaly", "anomalies")).toBe("2 anomalies");
  });
});
