import type { AgentsCollectorData } from "@afk/shared";
import type { RowView, CollectorUi, FrameOf } from "../registry.ts";
import { frameTimeMs } from "../model.ts";

type AgentsFrame = FrameOf<"agents">;

const PAD_TOP = 4;
const BAR_GAP_PX = 1;
/**
 * The collector samples every few seconds; a bar covers the time until the next sample
 * but never more than this, so a silent stretch reads as a gap rather than one wide bar.
 */
const MAX_BAR_SPAN_MS = 5_000;
/** The scale never drops below this many agents, so one agent is not a full-height bar. */
const MIN_SCALE_AGENTS = 2;

/** What the panel says when the client found no Claude Code state directory. */
export const CLAUDE_NOT_FOUND = "Claude Code not found";

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One line for the panel: "3 sessions: 1 working, 1 waiting on input, 1 idle; 2
 * subagents working". The subagent clause is left out when none are working, and a
 * machine without Claude Code reads as CLAUDE_NOT_FOUND.
 */
export function describeAgents(data: AgentsCollectorData): string {
  if (!data.available) {
    return CLAUDE_NOT_FOUND;
  }
  const { sessions, working, waitingOnInput, idle, subagentsWorking } = data.claude;
  if (sessions === 0) {
    return "no sessions";
  }
  const states = `${working} working, ${waitingOnInput} waiting on input, ${idle} idle`;
  const subagents =
    subagentsWorking === 0 ? "" : `; ${plural(subagentsWorking, "subagent")} working`;
  return `${plural(sessions, "session")}: ${states}${subagents}`;
}

/** Working and waiting stacked: the bar's total height is the busy sessions. */
function busy(frame: AgentsFrame): number {
  return frame.data.claude.working + frame.data.claude.waitingOnInput;
}

/**
 * One stacked bar per sample: working sessions in the accent colour with the ones
 * waiting on input in the warning colour on top, so a bar that turns amber is an agent
 * that needs the person. Scaled to the row's own peak (at least two agents).
 */
function drawRow(ctx: CanvasRenderingContext2D, frames: readonly AgentsFrame[], view: RowView) {
  const colors = {
    working: css("--accent"),
    waiting: css("--warn"),
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

  const peak = Math.max(MIN_SCALE_AGENTS, ...frames.map(busy));
  const heightFor = (agents: number) => (agents / peak) * plotHeight;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    if (!frame.data.available || busy(frame) === 0) {
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
    const { working, waitingOnInput } = frame.data.claude;
    const workingTop = plotBottom - heightFor(working);
    ctx.fillStyle = colors.working;
    ctx.fillRect(x0, workingTop, width, plotBottom - workingTop);
    const waitingTop = workingTop - heightFor(waitingOnInput);
    ctx.fillStyle = colors.waiting;
    ctx.fillRect(x0, waitingTop, width, workingTop - waitingTop);
  }
}

function AgentsDetails({ frame }: { frame: AgentsFrame }) {
  const { available, claude } = frame.data;
  const waiting = available && claude.waitingOnInput > 0;
  return (
    <dl className="kv">
      <dt>claude code</dt>
      <dd className={waiting ? "level-warn" : ""}>{describeAgents(frame.data)}</dd>
    </dl>
  );
}

export const agentsCollector: CollectorUi<"agents"> = {
  label: "agents",
  rowHeight: 40,
  drawRow,
  Details: AgentsDetails,
};
