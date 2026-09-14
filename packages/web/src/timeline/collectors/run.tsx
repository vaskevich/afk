import type { RowView, CollectorUi, FrameOf } from "../registry.ts";
import { frameTimeMs } from "../model.ts";
import { formatDuration, formatPercent } from "../../format.ts";

type RunFrame = FrameOf<"run">;

const PAD_TOP = 4;
const EXIT_MARK_WIDTH = 2;

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

/** Output rate between consecutive frames, bytes per second, split by stream. */
function rates(frames: readonly RunFrame[]): { stdout: number; stderr: number }[] {
  const out: { stdout: number; stderr: number }[] = [{ stdout: 0, stderr: 0 }];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!;
    const cur = frames[i]!;
    const seconds = Math.max(1, cur.timestamp - prev.timestamp);
    out.push({
      stdout: Math.max(0, cur.data.output.stdoutBytes - prev.data.output.stdoutBytes) / seconds,
      stderr: Math.max(0, cur.data.output.stderrBytes - prev.data.output.stderrBytes) / seconds,
    });
  }
  return out;
}

/**
 * Bars of output volume per second (stdout in the accent color, stderr in amber on top)
 * scaled to the row's busiest second, plus a vertical mark where the command exited:
 * green for exit 0, red otherwise. Quiet stretches are simply empty, which is the point.
 */
function drawRow(ctx: CanvasRenderingContext2D, frames: readonly RunFrame[], view: RowView) {
  const colors = {
    accent: css("--accent"),
    warn: css("--warn"),
    ok: css("--ok"),
    critical: css("--critical"),
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

  const perSecond = rates(frames);
  const peak = Math.max(1, ...perSecond.map((r) => r.stdout + r.stderr));
  const yFor = (bytesPerSecond: number) => plotBottom - (bytesPerSecond / peak) * plotHeight;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const r = perSecond[i]!;
    if (r.stdout === 0 && r.stderr === 0) {
      continue;
    }
    // Each frame covers the second before its timestamp.
    const x0 = view.x(frameTimeMs(f) - 1000);
    const x1 = view.x(frameTimeMs(f));
    const width = Math.max(1, x1 - x0);
    const stdoutTop = yFor(r.stdout);
    ctx.fillStyle = colors.accent;
    ctx.fillRect(x0, stdoutTop, width, plotBottom - stdoutTop);
    if (r.stderr > 0) {
      const stderrTop = yFor(r.stdout + r.stderr);
      ctx.fillStyle = colors.warn;
      ctx.fillRect(x0, stderrTop, width, stdoutTop - stderrTop);
    }
  }

  const last = frames[frames.length - 1]!;
  if (last.data.state === "exited") {
    const x = Math.round(view.x(frameTimeMs(last)));
    ctx.fillStyle = last.data.exitCode === 0 ? colors.ok : colors.critical;
    ctx.fillRect(x - EXIT_MARK_WIDTH / 2, plotTop, EXIT_MARK_WIDTH, plotHeight);
  }
}

function RunDetails({ frame }: { frame: RunFrame }) {
  const { command, pid, state, exitCode, elapsedSeconds, process, output } = frame.data;
  const exitLabel =
    state === "exited" ? (exitCode === 0 ? "exited 0" : `exited ${exitCode ?? "?"}`) : "running";
  return (
    <dl className="kv">
      <dt>command</dt>
      <dd className="mono" title={command}>
        {command}
      </dd>
      <dt>state</dt>
      <dd
        className={state === "exited" ? (exitCode === 0 ? "level-normal" : "level-critical") : ""}
      >
        {exitLabel}
      </dd>
      <dt>elapsed</dt>
      <dd>{formatDuration(elapsedSeconds * 1000)}</dd>
      <dt>stdout / stderr</dt>
      <dd>
        {formatBytes(output.stdoutBytes)} / {formatBytes(output.stderrBytes)}
      </dd>
      <dt>process</dt>
      <dd>
        pid {pid}, cpu {formatPercent(process.cpuPercent)}, rss {formatBytes(process.rssBytes)}
      </dd>
    </dl>
  );
}

export const runCollector: CollectorUi<"run"> = {
  label: "run",
  rowHeight: 48,
  drawRow,
  Details: RunDetails,
};
