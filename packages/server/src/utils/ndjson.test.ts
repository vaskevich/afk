import { describe, expect, it } from "vitest";
import { makeRunFrame, makeSystemFrame } from "@afk/shared/testing";
import { parseFrames } from "./ndjson.ts";

const ndjson = (...values: unknown[]) => values.map((value) => JSON.stringify(value)).join("\n");

describe("parseFrames", () => {
  it("parses several frames", () => {
    const system = makeSystemFrame(0);
    const run = makeRunFrame(0);

    const result = parseFrames(ndjson(system, run));

    expect(result).toEqual({ ok: true, frames: [system, run] });
  });

  it("skips blank lines and a trailing newline", () => {
    const system = makeSystemFrame(0);
    const run = makeRunFrame(0);
    const text = `\n${JSON.stringify(system)}\n\n${JSON.stringify(run)}\n`;

    const result = parseFrames(text);

    expect(result).toEqual({ ok: true, frames: [system, run] });
  });

  it("reports the 1-based line number for invalid JSON", () => {
    const text = `${JSON.stringify(makeSystemFrame(0))}\n{not valid json`;

    const result = parseFrames(text);

    if (result.ok) {
      throw new Error("expected parseFrames to fail");
    }
    expect(result.line).toBe(2);
    expect(result.message).toBe("line 2 is not valid JSON");
    expect(result.details).toBeUndefined();
  });

  it("reports the 1-based line number and details for a frame that fails validation", () => {
    const invalid = { collector: "system", stream: "system", sequence: 1, timestamp: 1 };
    const text = `${JSON.stringify(makeSystemFrame(0))}\n${JSON.stringify(invalid)}`;

    const result = parseFrames(text);

    if (result.ok) {
      throw new Error("expected parseFrames to fail");
    }
    expect(result.line).toBe(2);
    expect(result.message).toBe("line 2 failed validation");
    expect(result.details).toBeDefined();
  });

  it("yields zero frames for an empty body", () => {
    const result = parseFrames("");

    expect(result).toEqual({ ok: true, frames: [] });
  });
});
