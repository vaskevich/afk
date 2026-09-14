import { describe, expect, it } from "vitest";
import { T0_MS } from "@afk/shared/testing";
import { LOG_LEVELS, Logger, formatLine, isEnabled, type LogLevel } from "./logger.ts";

const T0 = new Date(T0_MS);
const T0_ISO = T0.toISOString();

/** A logger whose lines are collected instead of written, with the clock pinned to T0. */
function collectingLogger(level: LogLevel) {
  const lines: { level: LogLevel; line: string }[] = [];
  const logger = new Logger({
    level,
    sink: (level, line) => lines.push({ level, line }),
    now: () => T0,
  });
  return { logger, lines };
}

describe("formatLine", () => {
  it("writes the timestamp, the padded level, the message, and context as key=value pairs", () => {
    const line = formatLine(T0, "info", "session created", { session: "abc123", frames: 3 });

    expect(line).toBe(`${T0_ISO} info  session created session=abc123 frames=3`);
  });

  it("quotes values containing whitespace, equals signs, or quotes, and prints null and booleans bare", () => {
    const line = formatLine(T0, "warn", "odd values", {
      host: "my mac",
      expr: "a=b",
      quoted: 'say "hi"',
      empty: "",
      missing: null,
      ok: false,
    });

    expect(line).toBe(
      `${T0_ISO} warn  odd values host="my mac" expr="a=b" quoted="say \\"hi\\"" empty="" missing=null ok=false`,
    );
  });

  it("leaves out context entries whose value is undefined", () => {
    const line = formatLine(T0, "debug", "sparse", { a: 1, b: undefined, c: "x" });

    expect(line).toBe(`${T0_ISO} debug sparse a=1 c=x`);
  });

  it("emits just the timestamp, level, and message when there is no context", () => {
    expect(formatLine(T0, "error", "boom")).toBe(`${T0_ISO} error boom`);
  });
});

describe("isEnabled", () => {
  it("passes a level at or above the threshold and drops one below it", () => {
    expect(isEnabled("info", "info")).toBe(true);
    expect(isEnabled("error", "info")).toBe(true);
    expect(isEnabled("debug", "info")).toBe(false);
  });

  it("orders the levels debug < info < warn < error", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("Logger", () => {
  it("defaults to info, so debug is dropped and info is written", () => {
    const lines: string[] = [];
    const logger = new Logger({ sink: (_level, line) => lines.push(line), now: () => T0 });

    logger.debug("per frame");
    logger.info("per batch");

    expect(logger.getLevel()).toBe("info");
    expect(lines).toEqual([`${T0_ISO} info  per batch`]);
  });

  it("writes everything at debug and only errors at error", () => {
    const debug = collectingLogger("debug");
    const error = collectingLogger("error");

    for (const logger of [debug.logger, error.logger]) {
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
    }

    expect(debug.lines.map((entry) => entry.level)).toEqual(["debug", "info", "warn", "error"]);
    expect(error.lines.map((entry) => entry.level)).toEqual(["error"]);
  });

  it("applies a new threshold to calls made after setLevel", () => {
    const { logger, lines } = collectingLogger("info");

    logger.debug("before");
    logger.setLevel("debug");
    logger.debug("after");

    expect(lines.map((entry) => entry.line)).toEqual([`${T0_ISO} debug after`]);
  });

  it("reports whether a level is enabled so callers can skip building expensive context", () => {
    const { logger } = collectingLogger("warn");

    expect(logger.enabled("info")).toBe(false);
    expect(logger.enabled("warn")).toBe(true);
  });

  it("hands the level to the sink alongside the line", () => {
    const { logger, lines } = collectingLogger("debug");

    logger.error("failed", { code: 7 });

    expect(lines).toEqual([{ level: "error", line: `${T0_ISO} error failed code=7` }]);
  });
});
