import { describe, expect, it } from "vitest";
import {
  makeEvent,
  makeHost,
  makeRunFrame,
  makeSessionSummary,
  makeStoredFrames,
  makeSystemFrame,
} from "./testing.ts";
import {
  AnomalyEvent,
  CreateSessionRequest,
  Frame,
  FramesResponse,
  MemoryPressureLevel,
  PROTOCOL_VERSION,
  StoredFrame,
  StreamEventName,
} from "./protocol.ts";

/**
 * Shared tests for the wire schemas (see docs/TESTING.md, "shared" section): valid
 * input parses, invalid input is rejected with the offending field named, and enums
 * match what docs/PROTOCOL.md promises.
 */

describe("Frame", () => {
  it("accepts a valid system frame", () => {
    const result = Frame.safeParse(makeSystemFrame(0));

    expect(result.success).toBe(true);
  });

  it("accepts a valid run frame", () => {
    const result = Frame.safeParse(makeRunFrame(0));

    expect(result.success).toBe(true);
  });

  it("rejects an unknown collector", () => {
    const frame = { ...makeSystemFrame(0), collector: "process" };

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["collector"]);
    }
  });

  it("rejects a frame missing stream", () => {
    const frame: Record<string, unknown> = { ...makeSystemFrame(0) };
    delete frame.stream;

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["stream"]);
    }
  });

  it("rejects a non-positive sequence", () => {
    const frame = makeSystemFrame(0, { sequence: 0 });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["sequence"]);
    }
  });

  it("rejects a negative byte count", () => {
    const frame = makeRunFrame(0, {
      output: { flavor: "volume", stdoutBytes: -1, stderrBytes: 0 },
    });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "output", "stdoutBytes"]);
    }
  });

  it("rejects an unknown output flavor", () => {
    const frame = makeRunFrame(0, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately invalid flavor for the rejection test
      output: { flavor: "progress", stdoutBytes: 0, stderrBytes: 0 } as any,
    });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "output", "flavor"]);
    }
  });

  it("rejects a run state outside the enum", () => {
    const frame = { ...makeRunFrame(0), data: { ...makeRunFrame(0).data, state: "paused" } };

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "state"]);
    }
  });
});

describe("CreateSessionRequest", () => {
  const valid = () => ({
    protocolVersion: PROTOCOL_VERSION,
    clientVersion: "0.1.0",
    host: makeHost(),
  });

  it("rejects a wrong protocolVersion", () => {
    const result = CreateSessionRequest.safeParse({ ...valid(), protocolVersion: 999 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["protocolVersion"]);
    }
  });

  it("rejects a hostname that is too long", () => {
    const request = { ...valid(), host: makeHost({ hostname: "h".repeat(257) }) };

    const result = CreateSessionRequest.safeParse(request);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["host", "hostname"]);
    }
  });
});

describe("StoredFrame", () => {
  it("round-trips a value built from the builders", () => {
    const [stored] = makeStoredFrames([makeSystemFrame(0)]);

    const result = StoredFrame.safeParse(stored);

    expect(result).toMatchObject({ success: true, data: stored });
  });
});

describe("FramesResponse", () => {
  it("round-trips a value built from the builders", () => {
    const response = {
      session: makeSessionSummary({ startedAt: 0 }),
      frames: makeStoredFrames([makeSystemFrame(0), makeRunFrame(0)]),
      events: [makeEvent()],
    };

    const result = FramesResponse.safeParse(response);

    expect(result).toMatchObject({ success: true, data: response });
  });
});

describe("AnomalyEvent", () => {
  it("requires endedAt to be present", () => {
    const event: Record<string, unknown> = { ...makeEvent() };
    delete event.endedAt;

    const result = AnomalyEvent.safeParse(event);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["endedAt"]);
    }
  });

  it("accepts endedAt as null", () => {
    const result = AnomalyEvent.safeParse(makeEvent({ endedAt: null }));

    expect(result.success).toBe(true);
  });
});

describe("MemoryPressureLevel", () => {
  it("has the raw sysctl values 1, 2, and 4", () => {
    expect(MemoryPressureLevel.Normal).toBe(1);
    expect(MemoryPressureLevel.Warn).toBe(2);
    expect(MemoryPressureLevel.Critical).toBe(4);
  });
});

describe("StreamEventName", () => {
  it("has exactly the four names documented in docs/PROTOCOL.md", () => {
    expect(Object.values(StreamEventName).sort()).toEqual(
      ["session", "event", "frame", "end"].sort(),
    );
  });
});
