/**
 * Runs async tasks one at a time, in the order `run` was called, no matter how long
 * each one takes to settle. A task that throws does not block or poison the ones
 * queued after it: each caller only sees its own task's outcome through the promise
 * `run` returns.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const started = (async () => {
      try {
        await previous;
      } catch {
        // A previous task's failure is that caller's problem, not ours to propagate.
      }
      return await task();
    })();

    this.tail = (async () => {
      try {
        await started;
      } catch {
        // Swallow so the next task's `await previous` doesn't inherit this failure.
      }
    })();

    return started;
  }

  /** Resolves once every task queued so far has settled (successfully or not). */
  async drain(): Promise<void> {
    await this.run(async () => {});
  }
}
