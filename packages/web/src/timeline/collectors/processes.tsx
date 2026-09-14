import type { RowView, CollectorUi, FrameOf } from "../registry.ts";
import { frameTimeMs } from "../model.ts";
import { commandBasename, formatMiB, formatPercent } from "../../format.ts";

type ProcessesFrame = FrameOf<"processes">;

const PAD_TOP = 4;
const BAR_GAP_PX = 1;
/**
 * The collector samples every few seconds; a bar covers the time until the next sample
 * but never more than this, so a silent stretch reads as a gap rather than one wide bar.
 */
const MAX_BAR_SPAN_MS = 5_000;

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** cpu of the busiest process in the frame; `top` is cpu descending by contract, but do not rely on it. */
function busiestCpu(frame: ProcessesFrame): number {
  let busiest = 0;
  for (const entry of frame.data.top) {
    busiest = Math.max(busiest, entry.cpuPercent);
  }
  return busiest;
}

/**
 * One bar per sample, its height the busiest process's cpu relative to the row's own
 * peak, so a single runaway process stands out even on a quiet machine.
 */
function drawRow(ctx: CanvasRenderingContext2D, frames: readonly ProcessesFrame[], view: RowView) {
  const colors = {
    accent: css("--accent"),
    grid: css("--border"),
  };
  const plotTop = PAD_TOP;
  const plotBottom = view.height - 2;
  const plotHeight = plotBottom - plotTop;

  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, plotBottom + 0.5);
  ctx.lineTo(view.width, plotBottom + 0.5);
  ctx.stroke();

  if (frames.length === 0) {
    return;
  }

  const peak = Math.max(1, ...frames.map(busiestCpu));
  ctx.fillStyle = colors.accent;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const cpu = busiestCpu(frame);
    if (cpu <= 0) {
      continue;
    }
    const startMs = frameTimeMs(frame);
    const next = frames[i + 1];
    const spanMs = next ? Math.min(frameTimeMs(next) - startMs, MAX_BAR_SPAN_MS) : MAX_BAR_SPAN_MS;
    const x0 = view.x(startMs);
    const x1 = view.x(startMs + spanMs);
    if (x1 < 0 || x0 > view.width) {
      continue;
    }
    const width = Math.max(1, x1 - x0 - BAR_GAP_PX);
    const top = plotBottom - (cpu / peak) * plotHeight;
    ctx.fillRect(x0, top, width, plotBottom - top);
  }
}

function ProcessesDetails({ frame }: { frame: ProcessesFrame }) {
  const { sampledCount, top } = frame.data;
  return (
    <div>
      <p className="proc-summary">
        {sampledCount} processes, busiest {top.length} by cpu
      </p>
      <table className="proc-table">
        <thead>
          <tr>
            <th>command</th>
            <th className="num">pid</th>
            <th className="num">cpu</th>
            <th className="num">mem</th>
            <th className="num">rss</th>
          </tr>
        </thead>
        <tbody>
          {top.map((entry) => (
            <tr key={entry.pid}>
              <td className="cmd" title={entry.command}>
                {commandBasename(entry.command)}
              </td>
              <td className="num">{entry.pid}</td>
              <td className="num">{formatPercent(entry.cpuPercent)}</td>
              <td className="num">{formatPercent(entry.memoryPercent)}</td>
              <td className="num">{formatMiB(entry.rssBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const processesCollector: CollectorUi<"processes"> = {
  label: "processes",
  rowHeight: 48,
  drawRow,
  Details: ProcessesDetails,
};
