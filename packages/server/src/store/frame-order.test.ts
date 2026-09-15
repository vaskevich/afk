import { describe, expect, it } from "vitest";
import { makeStoredFrames, makeSystemFrame } from "@afk/shared/testing";
import type { StoredFrame } from "@afk/shared";
import { mergeFrames, orderFrames } from "./frame-order.ts";

/** `count` stored system frames with consecutive indexes and sequences from 1. */
function frames(count: number): StoredFrame[] {
  return makeStoredFrames(
    Array.from({ length: count }, (_, i) => makeSystemFrame(i, { sequence: i + 1 })),
  );
}

describe("orderFrames", () => {
  it("puts frames from several sources into index order", () => {
    const stored = frames(4);

    const ordered = orderFrames([stored[2]!, stored[0]!, stored[3]!, stored[1]!]);

    expect(ordered).toEqual(stored);
  });

  it("keeps the copy that was received first when the same frame was stored twice", () => {
    const [first] = frames(1);
    const later = { ...first!, index: 9, receivedAt: first!.receivedAt + 500 };

    expect(orderFrames([later, first!])).toEqual([first]);
    expect(orderFrames([first!, later])).toEqual([first]);
  });

  it("keeps frames of different streams that share an index", () => {
    // Two writers numbering from the same index is what puts one index on two frames.
    const [system] = frames(1);
    const other: StoredFrame = {
      ...system!,
      receivedAt: system!.receivedAt + 1,
      frame: { ...system!.frame, stream: "run:abc" },
    };

    expect(orderFrames([other, system!])).toEqual([system, other]);
  });

  it("returns nothing for no frames", () => {
    expect(orderFrames([])).toEqual([]);
  });

  it("does not sort its input in place", () => {
    const stored = frames(2);
    const input = [stored[1]!, stored[0]!];

    orderFrames(input);

    expect(input).toEqual([stored[1], stored[0]]);
  });
});

describe("mergeFrames", () => {
  it("merges what two writers hold into one ordered run without duplicates", () => {
    const stored = frames(5);

    const merged = mergeFrames(stored.slice(0, 3), stored.slice(2));

    expect(merged).toEqual(stored);
  });
});
