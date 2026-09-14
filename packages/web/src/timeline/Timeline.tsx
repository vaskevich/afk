import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { AnomalyEvent } from "@afk/shared";
import { formatClock, formatDuration, formatOffset } from "../format.ts";
import type { EventCluster } from "./clusters.ts";
import type { TimelineModel } from "./model.ts";
import { TimeAxis } from "./TimeAxis.tsx";
import { TimelineRow } from "./TimelineRow.tsx";
import {
  isFullWindow,
  panWindow,
  windowAround,
  zoomWindow,
  ZOOM_STEP,
  type TimeWindow,
} from "./viewport.ts";

interface Props {
  model: TimelineModel;
  /** Cursor position, unix ms. */
  cursor: number;
  /** True while the cursor tracks the latest frame rather than a position the viewer picked. */
  following: boolean;
  /** Called with a new cursor position, or null to follow the latest frame. */
  onCursorChange(cursorMs: number | null): void;
  /** The visible slice of the session (see viewport.ts). */
  view: TimeWindow;
  /** Called with a new zoom window, or null to show the whole session. */
  onZoomChange(zoom: TimeWindow | null): void;
  /** Reports the plot column's width in CSS pixels, so pixel radii can be turned into time. */
  onPlotWidthChange?(width: number): void;
}

/** Trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel notch is ~100. */
const WHEEL_ZOOM_SENSITIVITY = 0.01;
const WHEEL_ZOOM_MAX_FACTOR = 2;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const NO_EVENTS: readonly AnomalyEvent[] = [];

function groupByStream(events: readonly AnomalyEvent[]): Map<string, AnomalyEvent[]> {
  const byStream = new Map<string, AnomalyEvent[]>();
  for (const event of events) {
    const list = byStream.get(event.stream);
    if (list) {
      list.push(event);
    } else {
      byStream.set(event.stream, [event]);
    }
  }
  return byStream;
}

export function Timeline({
  model,
  cursor,
  following,
  onCursorChange,
  view,
  onZoomChange,
  onPlotWidthChange,
}: Props) {
  const { t0, t1, latest } = model;
  const { v0, v1 } = view;
  const axisRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [plot, setPlot] = useState({ left: 0, width: 0 });
  const dragging = useRef(false);

  // The axis cell defines the plot column; every row shares its width and offset.
  useEffect(() => {
    const el = axisRef.current;
    if (!el) {
      return;
    }
    const measure = () => setPlot({ left: el.offsetLeft, width: el.clientWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const x = useCallback(
    (timeMs: number) => ((timeMs - v0) / (v1 - v0)) * plot.width,
    [v0, v1, plot.width],
  );

  const snapToSecond = useCallback(
    (ms: number) => t0 + Math.round(clamp(ms - t0, 0, t1 - t0) / 1000) * 1000,
    [t0, t1],
  );

  /** Time under a viewport x coordinate, clamped to the visible window. */
  const timeAtClientX = useCallback(
    (clientX: number) => {
      const el = axisRef.current;
      if (!el || plot.width === 0) {
        return null;
      }
      const rect = el.getBoundingClientRect();
      const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
      return v0 + fraction * (v1 - v0);
    },
    [plot.width, v0, v1],
  );

  const zoomBy = useCallback(
    (factor: number, anchorMs: number) => onZoomChange(zoomWindow(view, anchorMs, factor, model)),
    [onZoomChange, view, model],
  );

  const panBy = useCallback(
    (deltaMs: number) => {
      // Panning away from the live edge means the viewer wants to look at something
      // specific, so stop following (which would snap the window straight back).
      if (following) {
        onCursorChange(cursor);
      }
      onZoomChange(panWindow(view, deltaMs, model));
    },
    [following, onCursorChange, cursor, onZoomChange, view, model],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = timeAtClientX(e.clientX);
    if (t !== null) {
      onCursorChange(snapToSecond(t));
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) {
      return;
    }
    const t = timeAtClientX(e.clientX);
    if (t !== null) {
      onCursorChange(snapToSecond(t));
    }
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // React registers wheel listeners as passive, so preventDefault (which stops the page
  // from zooming or scrolling sideways) needs a native listener.
  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        const anchor = timeAtClientX(e.clientX);
        if (anchor === null) {
          return;
        }
        e.preventDefault();
        const factor = clamp(
          Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY),
          1 / WHEEL_ZOOM_MAX_FACTOR,
          WHEEL_ZOOM_MAX_FACTOR,
        );
        zoomBy(factor, anchor);
        return;
      }
      const horizontal = e.shiftKey ? e.deltaY : e.deltaX;
      if (Math.abs(horizontal) <= Math.abs(e.deltaY) && !e.shiftKey) {
        // Mostly vertical: leave it to the page.
        return;
      }
      if (isFullWindow(view, model) || plot.width === 0) {
        return;
      }
      e.preventDefault();
      panBy((horizontal * (v1 - v0)) / plot.width);
    },
    [timeAtClientX, zoomBy, panBy, view, model, plot.width, v0, v1],
  );

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) {
      return;
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10_000 : 1000;
    switch (e.key) {
      case "ArrowLeft":
        onCursorChange(snapToSecond(cursor - step));
        break;
      case "ArrowRight":
        onCursorChange(snapToSecond(cursor + step));
        break;
      case "Home":
        onCursorChange(t0);
        break;
      case "End":
        onCursorChange(null);
        break;
      case "+":
      case "=":
        zoomBy(ZOOM_STEP, cursor);
        break;
      case "-":
        zoomBy(1 / ZOOM_STEP, cursor);
        break;
      case "0":
        onZoomChange(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const eventsByStream = useMemo(() => groupByStream(model.events), [model.events]);

  const onSelectEvent = useCallback(
    (event: AnomalyEvent) => onCursorChange(event.startedAt),
    [onCursorChange],
  );
  // Zoom to the cluster so its members come apart (subject to the minimum window).
  const onSelectCluster = useCallback(
    (cluster: EventCluster) => {
      const first = cluster.events[0]!;
      const last = cluster.events[cluster.events.length - 1]!;
      onCursorChange(first.startedAt);
      onZoomChange(windowAround(first.startedAt, last.startedAt, model));
    },
    [onCursorChange, onZoomChange, model],
  );

  useEffect(() => {
    onPlotWidthChange?.(plot.width);
  }, [onPlotWidthChange, plot.width]);

  const cursorLeft = useMemo(() => plot.left + x(cursor), [plot.left, x, cursor]);
  const cursorVisible = cursor >= v0 && cursor <= v1;
  const fullWindow = isFullWindow(view, model);

  return (
    <div
      className="timeline"
      tabIndex={0}
      role="slider"
      aria-label="Timeline scrubber"
      aria-valuemin={0}
      aria-valuemax={Math.round((t1 - t0) / 1000)}
      aria-valuenow={Math.round((cursor - t0) / 1000)}
      aria-valuetext={formatOffset((cursor - t0) / 1000)}
      onKeyDown={onKeyDown}
    >
      <div className="timeline-toolbar">
        <span>
          cursor <span className="cursor-time">+{formatOffset((cursor - t0) / 1000)}</span>
        </span>
        <span>{formatClock(cursor)}</span>
        <span className="spacer" />
        <span className="window-span" title="Visible window">
          {fullWindow ? "whole session" : formatDuration(v1 - v0)}
        </span>
        <span className="button-group" role="group" aria-label="Zoom">
          <button
            type="button"
            onClick={() => zoomBy(1 / ZOOM_STEP, cursor)}
            disabled={fullWindow}
            aria-label="Zoom out"
            title="Zoom out (-)"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => zoomBy(ZOOM_STEP, cursor)}
            aria-label="Zoom in"
            title="Zoom in (+)"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => onZoomChange(null)}
            disabled={fullWindow}
            title="Show the whole session (0)"
          >
            Fit
          </button>
        </span>
        <button type="button" onClick={() => onCursorChange(null)} disabled={cursor >= latest}>
          Latest
        </button>
      </div>
      <div
        ref={bodyRef}
        className="timeline-body"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="timeline-row timeline-axis-row">
          <div className="timeline-row-label" />
          <div ref={axisRef}>
            <TimeAxis width={plot.width} t0={t0} v0={v0} v1={v1} cursor={cursor} x={x} />
          </div>
        </div>
        {model.streams.map((series) => (
          <TimelineRow
            key={series.stream}
            series={series}
            events={eventsByStream.get(series.stream) ?? NO_EVENTS}
            width={plot.width}
            t0={t0}
            latest={latest}
            view={view}
            x={x}
            onSelectEvent={onSelectEvent}
            onSelectCluster={onSelectCluster}
          />
        ))}
        {model.streams.length === 0 && <div className="centered">No frames yet.</div>}
        {cursorVisible && <div className="timeline-cursor" style={{ left: cursorLeft }} />}
      </div>
    </div>
  );
}
