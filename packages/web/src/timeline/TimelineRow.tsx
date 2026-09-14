import { useCallback, useRef } from "react";
import type { StreamSeries } from "./model.ts";
import { collectorUi, type RowView } from "./registry.ts";
import { useCanvas } from "./useCanvas.ts";
import type { TimeWindow } from "./viewport.ts";

interface Props {
  series: StreamSeries;
  width: number;
  /** Visible window; the renderer only sees this slice. */
  view: TimeWindow;
  x(timeMs: number): number;
}

export function TimelineRow({ series, width, view, x }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ui = collectorUi(series.collector);
  const height = ui.rowHeight;

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      const rowView: RowView = { width, height, t0: view.v0, t1: view.v1, x };
      ui.drawRow(ctx, series.frames, rowView);
    },
    [ui, series, width, height, view.v0, view.v1, x],
  );

  useCanvas(ref, width, height, draw);

  return (
    <div className="timeline-row">
      <div className="timeline-row-label" title={series.stream}>
        {series.stream}
        <small>{series.frames.length} frames</small>
      </div>
      <canvas
        ref={ref}
        style={{ height }}
        role="img"
        aria-label={`${ui.label} timeline for ${series.stream}`}
      />
    </div>
  );
}
