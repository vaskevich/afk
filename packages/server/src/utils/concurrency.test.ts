import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.ts";

/** Lets every task started so far run before continuing, without a real wait. */
const yieldToOthers = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("mapWithConcurrency", () => {
  it("returns results in input order even when later items settle first", async () => {
    // The first item yields twice, so every other item finishes before it does.
    const result = await mapWithConcurrency([3, 1, 2], 3, async (n, index) => {
      if (index === 0) {
        await yieldToOthers();
        await yieldToOthers();
      }
      return n * 10;
    });

    expect(result).toEqual([30, 10, 20]);
  });

  it("never has more than the limit in flight and does keep that many in flight", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      4,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await yieldToOthers();
        inFlight--;
        return n;
      },
    );

    expect(peak).toBe(4);
  });

  it("rejects with the first failure and starts nothing after it", async () => {
    const started: number[] = [];

    const call = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      await yieldToOthers();
      if (n === 1) {
        throw new Error("item 1 failed");
      }
      return n;
    });

    await expect(call).rejects.toThrow("item 1 failed");
    // Items 0 and 1 were in flight when 1 failed; item 2 may have started from
    // worker 0's next loop turn, but nothing beyond that.
    expect(started.length).toBeLessThanOrEqual(3);
  });

  it("returns an empty array for no items without calling the function", async () => {
    const result = await mapWithConcurrency([], 4, async () => {
      throw new Error("must not be called");
    });

    expect(result).toEqual([]);
  });

  it("rejects a limit below one", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(RangeError);
  });
});
