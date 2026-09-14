/**
 * The visible slice of the timeline. Pure functions so the zoom, pan, and follow-live
 * rules can be reasoned about (and tested) without React.
 */

/** Visible window, unix ms. Always inside the session range and at least MIN_WINDOW_MS wide. */
export interface TimeWindow {
  v0: number;
  v1: number;
}

/** Never zoom in past this; a few frames per pixel-column is already plenty. */
export const MIN_WINDOW_MS = 30_000;
/** One zoom button press or keyboard step halves or doubles the window. */
export const ZOOM_STEP = 2;

interface Range {
  t0: number;
  t1: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Keeps the width within [MIN_WINDOW_MS, whole range] and slides the window inside the range. */
export function clampWindow(window: TimeWindow, range: Range): TimeWindow {
  const full = range.t1 - range.t0;
  const width = clamp(window.v1 - window.v0, Math.min(MIN_WINDOW_MS, full), full);
  const v0 = clamp(window.v0, range.t0, range.t1 - width);
  return { v0, v1: v0 + width };
}

export function isFullWindow(window: TimeWindow, range: Range): boolean {
  return window.v0 <= range.t0 && window.v1 >= range.t1;
}

/**
 * What to show given the viewer's zoom choice. `null` means the whole session. While
 * following live (no explicit cursor) a zoomed window keeps its width but pins its
 * right edge to `latest`, so the newest data stays in view as the session grows.
 */
export function resolveWindow(
  model: Range & { latest: number },
  zoom: TimeWindow | null,
  following: boolean,
): TimeWindow {
  if (zoom === null) {
    return { v0: model.t0, v1: model.t1 };
  }
  const clamped = clampWindow(zoom, model);
  if (!following) {
    return clamped;
  }
  const width = clamped.v1 - clamped.v0;
  return clampWindow({ v0: model.latest - width, v1: model.latest }, model);
}

/** Scales the window by `factor` (> 1 zooms in) keeping `anchorMs` at the same x position. */
export function zoomWindow(
  window: TimeWindow,
  anchorMs: number,
  factor: number,
  range: Range,
): TimeWindow {
  const anchor = clamp(anchorMs, window.v0, window.v1);
  return clampWindow(
    {
      v0: anchor - (anchor - window.v0) / factor,
      v1: anchor + (window.v1 - anchor) / factor,
    },
    range,
  );
}

export function panWindow(window: TimeWindow, deltaMs: number, range: Range): TimeWindow {
  return clampWindow({ v0: window.v0 + deltaMs, v1: window.v1 + deltaMs }, range);
}

/** A window around `[startMs, endMs]` with breathing room on both sides. */
export function windowAround(startMs: number, endMs: number, range: Range): TimeWindow {
  const padding = Math.max((endMs - startMs) * 0.25, MIN_WINDOW_MS / 4);
  return clampWindow({ v0: startMs - padding, v1: endMs + padding }, range);
}
