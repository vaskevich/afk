import { MemoryPressureLevel } from "@afk/shared";
import type { RowView, CollectorUi, FrameOf } from "../registry.ts";
import { frameTimeMs } from "../model.ts";
import { formatGiB, formatLoad, formatPercent, pressureLabel } from "../../format.ts";

type SystemFrame = FrameOf<"system">;

const PRESSURE_BAND_HEIGHT = 4;
const PAD_TOP = 4;

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function pressureColor(level: number, colors: Record<string, string>): string {
  switch (level) {
    case MemoryPressureLevel.Normal:
      return colors.ok!;
    case MemoryPressureLevel.Warn:
      return colors.warn!;
    case MemoryPressureLevel.Critical:
      return colors.critical!;
    default:
      return colors.unknown!;
  }
}

function drawRow(ctx: CanvasRenderingContext2D, frames: readonly SystemFrame[], view: RowView) {
  const colors = {
    accent: css("--accent"),
    accentSoft: css("--accent-soft"),
    grid: css("--border"),
    ok: css("--ok"),
    warn: css("--warn"),
    critical: css("--critical"),
    unknown: css("--unknown"),
  };

  const plotTop = PAD_TOP;
  const plotBottom = view.height - PRESSURE_BAND_HEIGHT - 2;
  const plotHeight = plotBottom - plotTop;
  const yForPercent = (p: number) =>
    plotBottom - (Math.min(100, Math.max(0, p)) / 100) * plotHeight;

  // Faint guide lines at 50% and 100%.
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  for (const p of [50, 100]) {
    const y = Math.round(yForPercent(p)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(view.width, y);
    ctx.stroke();
  }

  if (frames.length === 0) return;

  // cpu percent: filled area under a line.
  ctx.beginPath();
  const first = frames[0]!;
  ctx.moveTo(view.x(frameTimeMs(first)), plotBottom);
  for (const f of frames) {
    ctx.lineTo(view.x(frameTimeMs(f)), yForPercent(f.data.cpu.percent));
  }
  const last = frames[frames.length - 1]!;
  ctx.lineTo(view.x(frameTimeMs(last)), plotBottom);
  ctx.closePath();
  ctx.fillStyle = colors.accentSoft;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const x = view.x(frameTimeMs(f));
    const y = yForPercent(f.data.cpu.percent);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Memory pressure band: one rectangle per run of equal level. Each frame covers the
  // second following its timestamp, so the last run extends one sample width.
  const bandTop = view.height - PRESSURE_BAND_HEIGHT;
  let runStart = 0;
  for (let i = 1; i <= frames.length; i++) {
    const level = frames[runStart]!.data.memory.pressureLevel;
    const atEnd = i === frames.length;
    if (atEnd || frames[i]!.data.memory.pressureLevel !== level) {
      const x0 = view.x(frameTimeMs(frames[runStart]!));
      const endMs = atEnd ? frameTimeMs(frames[i - 1]!) + 1000 : frameTimeMs(frames[i]!);
      const x1 = view.x(endMs);
      ctx.fillStyle = pressureColor(level, colors);
      ctx.fillRect(x0, bandTop, Math.max(1, x1 - x0), PRESSURE_BAND_HEIGHT);
      runStart = i;
    }
  }
}

function SystemDetails({ frame }: { frame: SystemFrame }) {
  const { cpu, loadAverage, memory } = frame.data;
  const label = pressureLabel(memory.pressureLevel);
  const used = memory.totalBytes - memory.freeBytes;
  return (
    <dl className="kv">
      <dt>cpu</dt>
      <dd>{formatPercent(cpu.percent)}</dd>
      <dt>load 1 / 5 / 15</dt>
      <dd>
        {formatLoad(loadAverage.oneMinute)} / {formatLoad(loadAverage.fiveMinutes)} /{" "}
        {formatLoad(loadAverage.fifteenMinutes)}
      </dd>
      <dt>memory pressure</dt>
      <dd className={`level-${label}`}>
        {label}
        {label === "unknown" ? ` (${memory.pressureLevel})` : ""}
      </dd>
      <dt>memory used</dt>
      <dd>
        {formatGiB(used)} / {formatGiB(memory.totalBytes)}
      </dd>
      <dt>swap used</dt>
      <dd>
        {formatGiB(memory.swapUsedBytes)} / {formatGiB(memory.swapTotalBytes)}
      </dd>
    </dl>
  );
}

export const systemCollector: CollectorUi<"system"> = {
  label: "system",
  rowHeight: 72,
  drawRow,
  Details: SystemDetails,
};
