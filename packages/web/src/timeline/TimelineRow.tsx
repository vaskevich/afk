import { useCallback, useRef } from "react";
import type { StreamSeries } from "./model.ts";
import { collectorUi, type RowView } from "./registry.ts";
import { useCanvas } from "./useCanvas.ts";

interface Props {
  series: StreamSeries;
  width: number;
  t0: number;
  t1: number;
  x(timeMs: number): number;
}

export function TimelineRow({ series, width, t0, t1, x }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ui = collectorUi(series.collector);
  const height = ui.rowHeight;

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      const view: RowView = { width, height, t0, t1, x };
      ui.drawRow(ctx, series.frames, view);
    },
    [ui, series, width, height, t0, t1, x],
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
