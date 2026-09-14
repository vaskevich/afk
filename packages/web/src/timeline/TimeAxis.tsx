import { useCallback, useRef } from "react";
import { formatOffset } from "../format.ts";
import { useCanvas } from "./useCanvas.ts";

export const AXIS_HEIGHT = 22;

const TICK_STEPS_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const MIN_TICK_SPACING_PX = 64;

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function chooseTickStep(spanSeconds: number, widthPx: number): number {
  for (const step of TICK_STEPS_SECONDS) {
    if ((step / spanSeconds) * widthPx >= MIN_TICK_SPACING_PX) {
      return step;
    }
  }
  return TICK_STEPS_SECONDS[TICK_STEPS_SECONDS.length - 1]!;
}

interface Props {
  width: number;
  /** Session start, unix ms: tick labels are offsets from here. */
  t0: number;
  /** Visible window, unix ms. */
  v0: number;
  v1: number;
  cursor: number;
  x(timeMs: number): number;
}

/** Tick marks labelled with the offset from session start, plus the cursor's time. */
export function TimeAxis({ width, t0, v0, v1, cursor, x }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D) => {
      const height = AXIS_HEIGHT;
      const spanSeconds = (v1 - v0) / 1000;
      const step = chooseTickStep(spanSeconds, width);
      const font = `10px ${css("--font-mono")}`;

      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.strokeStyle = css("--border-strong");
      ctx.fillStyle = css("--fg-faint");
      ctx.lineWidth = 1;

      // Ticks sit on multiples of the step from the session start, whatever the window.
      const firstTick = Math.ceil((v0 - t0) / 1000 / step) * step;
      const lastTick = (v1 - t0) / 1000;
      for (let s = firstTick; s <= lastTick; s += step) {
        const px = Math.round(x(t0 + s * 1000)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, height - 5);
        ctx.lineTo(px, height);
        ctx.stroke();
        const label = formatOffset(s);
        const textWidth = ctx.measureText(label).width;
        // Keep the first and last labels inside the canvas.
        const tx = Math.min(Math.max(px - textWidth / 2, 2), width - textWidth - 2);
        ctx.fillText(label, tx, height / 2 - 2);
      }

      // Cursor time, in a small tag that stays inside the axis (only while in view).
      if (cursor < v0 || cursor > v1) {
        return;
      }
      const label = formatOffset((cursor - t0) / 1000);
      ctx.font = `600 ${font}`;
      const textWidth = ctx.measureText(label).width;
      const tagWidth = textWidth + 8;
      const cx = x(cursor);
      const left = Math.min(Math.max(cx - tagWidth / 2, 0), width - tagWidth);
      ctx.fillStyle = css("--cursor");
      ctx.fillRect(left, 2, tagWidth, height - 4);
      ctx.fillStyle = css("--bg");
      ctx.fillText(label, left + 4, height / 2);
    },
    [width, t0, v0, v1, cursor, x],
  );

  useCanvas(ref, width, AXIS_HEIGHT, draw);

  return <canvas ref={ref} className="timeline-axis" aria-hidden="true" />;
}
