/**
 * Bar spans for a row that draws one bar per sample, each running until the next
 * sample. Samples arrive at a nominal cadence, but a sample can be a little late
 * (the client's tick ran long) or missing for a stretch (the client was cut off);
 * a late sample should still join its neighbour, a stretch with no samples should
 * show as a gap.
 */

/**
 * How far a sample's bar may run past it, as a multiple of the stream's typical
 * interval. Below this a late neighbour is joined; beyond it the rest reads as a gap.
 */
export const MAX_BAR_SPAN_INTERVALS = 1.5;
/** The interval assumed for a stream with fewer than two samples, which has no gaps to measure. */
export const FALLBACK_INTERVAL_MS = 5_000;

/**
 * The typical interval between samples: the median of the gaps between consecutive
 * times, so an outage in the middle of a stream does not stretch it. Falls back to
 * `FALLBACK_INTERVAL_MS` when there are no gaps to measure.
 */
export function typicalIntervalMs(timesMs: readonly number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < timesMs.length; i++) {
    gaps.push(timesMs[i]! - timesMs[i - 1]!);
  }
  if (gaps.length === 0) {
    return FALLBACK_INTERVAL_MS;
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor((gaps.length - 1) / 2)]!;
  return median > 0 ? median : FALLBACK_INTERVAL_MS;
}

/**
 * How long each sample's bar runs, in ms, for sample times in ascending order: until
 * the next sample, but at most `MAX_BAR_SPAN_INTERVALS` typical intervals. The last
 * bar, with nothing after it yet, runs one typical interval.
 */
export function barSpansMs(timesMs: readonly number[]): number[] {
  const interval = typicalIntervalMs(timesMs);
  const maxSpan = interval * MAX_BAR_SPAN_INTERVALS;
  return timesMs.map((time, i) => {
    const next = timesMs[i + 1];
    return next === undefined ? interval : Math.min(next - time, maxSpan);
  });
}
