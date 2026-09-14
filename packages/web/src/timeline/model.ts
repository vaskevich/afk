import type { CollectorName, Frame, FramesResponse, StoredFrame } from "@afk/shared";

/** One row on the timeline: every frame of a single stream, in time order. */
export interface StreamSeries {
  stream: string;
  collector: CollectorName;
  frames: Frame[];
}

export interface TimelineModel {
  /** Start of the time axis, unix ms. */
  t0: number;
  /** End of the time axis, unix ms. Always > t0. */
  t1: number;
  streams: StreamSeries[];
  /** Highest `StoredFrame.index` seen; the resume cursor for streaming. */
  lastIndex: number;
}

export const frameTimeMs = (frame: Frame) => frame.timestamp * 1000;

/**
 * Groups frames by stream and works out the visible time range. The range starts at
 * the session start and runs to its end (or the last frame while it is still active),
 * so a new session with only a handful of frames still gets a sensible axis.
 */
export function buildModel(data: FramesResponse): TimelineModel {
  const byStream = new Map<string, StreamSeries>();
  let lastIndex = 0;
  let lastFrameMs = 0;

  for (const stored of data.frames) {
    const { frame } = stored;
    let series = byStream.get(frame.stream);
    if (!series) {
      series = { stream: frame.stream, collector: frame.collector, frames: [] };
      byStream.set(frame.stream, series);
    }
    series.frames.push(frame);
    lastIndex = Math.max(lastIndex, stored.index);
    lastFrameMs = Math.max(lastFrameMs, frameTimeMs(frame));
  }

  for (const series of byStream.values()) {
    series.frames.sort((a, b) => a.timestamp - b.timestamp);
  }

  const t0 = data.session.startedAt;
  const end = data.session.endedAt ?? lastFrameMs;
  // Never let the axis collapse to zero width; a minute is enough to draw something.
  const t1 = Math.max(end, lastFrameMs, t0 + 60_000);

  return { t0, t1, streams: [...byStream.values()], lastIndex };
}

/** Index of the frame whose timestamp is closest to `timeMs`, or -1 when empty. */
export function nearestFrameIndex(frames: readonly Frame[], timeMs: number): number {
  if (frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frameTimeMs(frames[mid]!) < timeMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const prev = frames[lo - 1]!;
    const cur = frames[lo]!;
    if (timeMs - frameTimeMs(prev) <= frameTimeMs(cur) - timeMs) return lo - 1;
  }
  return lo;
}

export function nearestFrame(frames: readonly Frame[], timeMs: number): Frame | undefined {
  const i = nearestFrameIndex(frames, timeMs);
  return i < 0 ? undefined : frames[i];
}

/** A single stored frame's worth of bookkeeping for `subscribe` later on. */
export type { StoredFrame };
