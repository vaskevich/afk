import type { CollectorName, Frame } from "@afk/shared";
import type { ComponentType } from "react";
import { processesCollector } from "./collectors/processes.tsx";
import { runCollector } from "./collectors/run.tsx";
import { systemCollector } from "./collectors/system.tsx";

/** Geometry handed to a row renderer. Sizes are CSS pixels; the context is pre-scaled. */
export interface RowView {
  width: number;
  height: number;
  /** Visible window, unix ms; `x(t0)` is 0 and `x(t1)` is `width`. Frames may fall outside it. */
  t0: number;
  t1: number;
  /** Maps a unix-ms time to an x coordinate in CSS pixels. */
  x(timeMs: number): number;
}

export type FrameOf<C extends CollectorName> = Extract<Frame, { collector: C }>;

/** How one collector kind shows up on the dashboard. */
export interface CollectorUi<C extends CollectorName = CollectorName> {
  /** Short label for the row header. */
  label: string;
  /** Row height in CSS pixels. */
  rowHeight: number;
  /** Paints the whole row. Called on every resize and data change. */
  drawRow(ctx: CanvasRenderingContext2D, frames: readonly FrameOf<C>[], view: RowView): void;
  /** Readable values for the frame under the scrubber. */
  Details: ComponentType<{ frame: FrameOf<C> }>;
}

/**
 * Registry keyed by collector name. Adding a collector to the `Frame` union in shared
 * makes this object fail to type check until an entry is added here, which is the point.
 */
export const collectors: { [C in CollectorName]: CollectorUi<C> } = {
  system: systemCollector,
  run: runCollector,
  processes: processesCollector,
};

/** Looks up the UI for a collector without the per-member narrowing. */
export function collectorUi(name: CollectorName): CollectorUi {
  return collectors[name] as CollectorUi;
}
