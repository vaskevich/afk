import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { formatClock, formatOffset } from "../format.ts";
import type { TimelineModel } from "./model.ts";
import { TimeAxis } from "./TimeAxis.tsx";
import { TimelineRow } from "./TimelineRow.tsx";

interface Props {
  model: TimelineModel;
  /** Cursor position, unix ms. */
  cursor: number;
  /** Called with a new cursor position, or null to follow the latest frame. */
  onCursorChange(cursorMs: number | null): void;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function Timeline({ model, cursor, onCursorChange }: Props) {
  const { t0, t1, latest } = model;
  const axisRef = useRef<HTMLDivElement>(null);
  const [plot, setPlot] = useState({ left: 0, width: 0 });
  const dragging = useRef(false);

  // The axis cell defines the plot column; every row shares its width and offset.
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const measure = () => setPlot({ left: el.offsetLeft, width: el.clientWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const x = useCallback(
    (timeMs: number) => ((timeMs - t0) / (t1 - t0)) * plot.width,
    [t0, t1, plot.width],
  );

  const snapToSecond = useCallback(
    (ms: number) => t0 + Math.round(clamp(ms - t0, 0, t1 - t0) / 1000) * 1000,
    [t0, t1],
  );

  const timeAtPointer = useCallback(
    (e: PointerEvent) => {
      const el = axisRef.current;
      if (!el || plot.width === 0) return null;
      const rect = el.getBoundingClientRect();
      const fraction = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      return snapToSecond(t0 + fraction * (t1 - t0));
    },
    [plot.width, snapToSecond, t0, t1],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = timeAtPointer(e);
    if (t !== null) onCursorChange(t);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const t = timeAtPointer(e);
    if (t !== null) onCursorChange(t);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

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
      default:
        return;
    }
    e.preventDefault();
  };

  const cursorLeft = useMemo(() => plot.left + x(cursor), [plot.left, x, cursor]);

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
        <button type="button" onClick={() => onCursorChange(null)} disabled={cursor >= latest}>
          Latest
        </button>
      </div>
      <div
        className="timeline-body"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="timeline-row timeline-axis-row">
          <div className="timeline-row-label" />
          <div ref={axisRef}>
            <TimeAxis width={plot.width} t0={t0} t1={t1} cursor={cursor} x={x} />
          </div>
        </div>
        {model.streams.map((series) => (
          <TimelineRow
            key={series.stream}
            series={series}
            width={plot.width}
            t0={t0}
            t1={t1}
            x={x}
          />
        ))}
        {model.streams.length === 0 && <div className="centered">No frames yet.</div>}
        <div className="timeline-cursor" style={{ left: cursorLeft }} />
      </div>
    </div>
  );
}
