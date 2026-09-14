/**
 * `Promise.all(items.map(fn))` with at most `limit` calls of `fn` in flight at once.
 * Results come back in input order whatever order the calls settle in. The first
 * rejection rejects the whole call: calls already in flight run to completion, but
 * nothing new is started after it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  const worker = async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
