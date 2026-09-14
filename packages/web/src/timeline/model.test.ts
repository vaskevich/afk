import { describe, expect, it } from "vitest";
import type { FramesResponse, StoredFrame } from "@afk/shared";
import {
  T0_MS,
  makeEvent,
  makeRunFrame,
  makeSessionSummary,
  makeStoredFrames,
  makeSystemFrame,
} from "@afk/shared/testing";
import { buildModel, frameTimeMs, nearestFrame, nearestFrameIndex } from "./model.ts";

const seconds = (n: number) => T0_MS + n * 1000;

function response(overrides: Partial<FramesResponse> = {}): FramesResponse {
  return {
    session: makeSessionSummary(),
    frames: [],
    events: [],
    ...overrides,
  };
}

describe("buildModel", () => {
  it("groups frames by stream and sorts each stream's frames in time order", () => {
    const data = response({
      frames: makeStoredFrames([
        makeSystemFrame(5),
        makeRunFrame(2, { runId: "abcd1234" }),
        makeSystemFrame(1),
        makeRunFrame(8, { runId: "abcd1234" }),
      ]),
    });

    const model = buildModel(data, seconds(20));

    expect(model.streams).toHaveLength(2);
    const system = model.streams.find((s) => s.stream === "system");
    const run = model.streams.find((s) => s.stream === "run:abcd1234");
    expect(system?.collector).toBe("system");
    expect(system?.frames.map(frameTimeMs)).toEqual([seconds(1), seconds(5)]);
    expect(run?.collector).toBe("run");
    expect(run?.frames.map(frameTimeMs)).toEqual([seconds(2), seconds(8)]);
  });

  it("computes t0 from the session start, independent of frame timestamps", () => {
    const data = response({
      session: makeSessionSummary({ startedAt: seconds(50), endedAt: seconds(70) }),
      frames: makeStoredFrames([makeSystemFrame(0)]),
    });

    const model = buildModel(data, seconds(200));

    expect(model.t0).toBe(seconds(50));
  });

  it("for an active session, grows t1 and latest to follow now", () => {
    const data = response({
      session: makeSessionSummary({ status: "active", endedAt: null }),
      frames: makeStoredFrames([makeSystemFrame(40)]),
    });

    const model = buildModel(data, seconds(90));

    expect(model.t1).toBe(seconds(90));
    expect(model.latest).toBe(seconds(90));
  });

  it("for an ended session, pins t1 and latest to endedAt regardless of now", () => {
    const data = response({
      session: makeSessionSummary({ status: "ended", endedAt: seconds(120) }),
      frames: makeStoredFrames([makeSystemFrame(100)]),
    });

    const model = buildModel(data, seconds(500));

    expect(model.t1).toBe(seconds(120));
    expect(model.latest).toBe(seconds(120));
  });

  it("floors the axis at one minute wide without inflating latest", () => {
    const data = response({
      session: makeSessionSummary({ status: "ended", endedAt: seconds(5) }),
      frames: makeStoredFrames([makeSystemFrame(1)]),
    });

    const model = buildModel(data, seconds(5));

    expect(model.t1).toBe(seconds(60));
    expect(model.latest).toBe(seconds(5));
  });

  it("reports the highest stored frame index seen, not just the frame count", () => {
    const stored = makeStoredFrames([makeSystemFrame(0), makeSystemFrame(1)]).map(
      (frame, i): StoredFrame => ({ ...frame, index: i === 0 ? 5 : 12 }),
    );
    const data = response({ frames: stored });

    const model = buildModel(data, seconds(10));

    expect(model.lastIndex).toBe(12);
  });

  it("sorts events by start time", () => {
    const data = response({
      events: [
        makeEvent({ startedAt: seconds(10) }),
        makeEvent({ startedAt: seconds(2) }),
        makeEvent({ startedAt: seconds(5) }),
      ],
    });

    const model = buildModel(data, seconds(20));

    expect(model.events.map((e) => e.startedAt)).toEqual([seconds(2), seconds(5), seconds(10)]);
  });
});

describe("nearestFrameIndex", () => {
  const frames = [makeSystemFrame(0), makeSystemFrame(10), makeSystemFrame(20)];

  it("returns -1 for empty input", () => {
    expect(nearestFrameIndex([], seconds(0))).toBe(-1);
  });

  it("picks the first frame when the time is before it", () => {
    expect(nearestFrameIndex(frames, seconds(-5))).toBe(0);
  });

  it("picks the last frame when the time is after it", () => {
    expect(nearestFrameIndex(frames, seconds(50))).toBe(2);
  });

  it("picks the closer of two neighbours", () => {
    expect(nearestFrameIndex(frames, seconds(8))).toBe(1);
  });

  it("breaks an exact tie in favour of the earlier frame", () => {
    expect(nearestFrameIndex(frames, seconds(5))).toBe(0);
  });
});

describe("nearestFrame", () => {
  it("returns the frame at the nearest index", () => {
    const frames = [makeSystemFrame(0), makeSystemFrame(10)];

    expect(nearestFrame(frames, seconds(9))).toBe(frames[1]);
  });

  it("returns undefined for empty input", () => {
    expect(nearestFrame([], seconds(0))).toBeUndefined();
  });
});
