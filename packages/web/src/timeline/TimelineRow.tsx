import type { AnomalyEvent } from "@afk/shared";
import { useCallback, useRef } from "react";
import type { EventCluster } from "./clusters.ts";
import { EventMarkers } from "./EventMarkers.tsx";
import type { StreamSeries } from "./model.ts";
import { collectorUi, type RowView } from "./registry.ts";
import { useCanvas } from "./useCanvas.ts";
import type { TimeWindow } from "./viewport.ts";

interface Props {
  series: StreamSeries;
  /** This stream's anomaly events, in start order. */
  events: readonly AnomalyEvent[];
  width: number;
  /** Session start and the live edge, for marker titles and open events' bands. */
  t0: number;
  latest: number;
  /** Visible window; the renderer only sees this slice. */
  view: TimeWindow;
  x(timeMs: number): number;
  onSelectEvent(event: AnomalyEvent): void;
  onSelectCluster(cluster: EventCluster): void;
}

export function TimelineRow({
  series,
  events,
  width,
  t0,
  latest,
  view,
  x,
  onSelectEvent,
  onSelectCluster,
}: Props) {
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
      <div className="timeline-row-plot">
        <canvas
          ref={ref}
          style={{ height }}
          role="img"
          aria-label={`${ui.label} timeline for ${series.stream}`}
        />
        <EventMarkers
          events={events}
          t0={t0}
          latest={latest}
          width={width}
          x={x}
          onSelectEvent={onSelectEvent}
          onSelectCluster={onSelectCluster}
        />
      </div>
    </div>
  );
}
