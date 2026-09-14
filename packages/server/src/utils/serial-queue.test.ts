import { describe, expect, it } from "vitest";
import { SerialQueue } from "./serial-queue.ts";

/** A promise plus the callbacks to settle it manually, for controlling task order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SerialQueue", () => {
  it("runs tasks one at a time in call order even when a later one would settle first", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const first = deferred<void>();
    const second = deferred<void>();
    second.resolve();

    const firstDone = queue.run(async () => {
      await first.promise;
      order.push("first");
    });
    const secondDone = queue.run(async () => {
      await second.promise;
      order.push("second");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);

    first.resolve();
    await Promise.all([firstDone, secondDone]);

    expect(order).toEqual(["first", "second"]);
  });

  it("rejects only the failing task's own caller and does not block the next task", async () => {
    const queue = new SerialQueue();

    const failing = queue.run(async () => {
      throw new Error("boom");
    });
    const next = queue.run(async () => "ok");

    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("resolves drain() only after every task queued so far has settled", async () => {
    const queue = new SerialQueue();
    const task = deferred<void>();
    let taskFinished = false;

    queue.run(async () => {
      await task.promise;
      taskFinished = true;
    });
    const drained = queue.drain();

    await Promise.resolve();
    expect(taskFinished).toBe(false);

    task.resolve();
    await drained;

    expect(taskFinished).toBe(true);
  });

  it("carries the task's own value on the returned promise", async () => {
    const queue = new SerialQueue();

    const result = await queue.run(async () => 42);

    expect(result).toBe(42);
  });
});
