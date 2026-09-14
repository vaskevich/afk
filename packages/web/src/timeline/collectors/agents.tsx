import { AGENT_TOOLS, AGENT_TOOL_LABELS, agentToolsPresent } from "@afk/shared";
import type { AgentCounts, AgentTool, AgentsCollectorData } from "@afk/shared";
import { Fragment } from "react";
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

/** What the panel says when the client found neither tool's state directory. */
export const AGENTS_NOT_FOUND = "no Claude Code or Codex found";

/**
 * The stylesheet tokens each tool's bars are painted with (see `--agent-*` in
 * styles.css): working in the tool's own colour, waiting on input in its shade of
 * the warning colour, so a bar that turns amber or orange is an agent that needs the
 * person and its hue says which tool.
 */
const TOOL_COLOR_TOKENS: Record<AgentTool, { working: string; waiting: string }> = {
  claude: { working: "--agent-claude", waiting: "--agent-claude-waiting" },
  codex: { working: "--agent-codex", waiting: "--agent-codex-waiting" },
};

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One tool's counts as a clause: "3 sessions, 1 working, 1 waiting on input, 1 idle,
 * 2 subagents working". A state nobody is in is left out, and a tool with no session
 * reads "no sessions".
 */
export function describeAgentCounts(counts: AgentCounts): string {
  if (counts.sessions === 0) {
    return "no sessions";
  }
  const parts = [plural(counts.sessions, "session")];
  if (counts.working > 0) {
    parts.push(`${counts.working} working`);
  }
  if (counts.waitingOnInput > 0) {
    parts.push(`${counts.waitingOnInput} waiting on input`);
  }
  if (counts.idle > 0) {
    parts.push(`${counts.idle} idle`);
  }
  if (counts.subagentsWorking > 0) {
    parts.push(`${plural(counts.subagentsWorking, "subagent")} working`);
  }
  return parts.join(", ");
}

/**
 * The whole frame in one line, a sentence per tool found: "Claude Code: 3 sessions,
 * 1 working, 1 waiting on input, 1 idle, 2 subagents working. Codex: 1 session, 1
 * working." A machine with neither tool reads as AGENTS_NOT_FOUND.
 */
export function describeAgents(data: AgentsCollectorData): string {
  const tools = agentToolsPresent(data);
  if (tools.length === 0) {
    return AGENTS_NOT_FOUND;
  }
  return tools
    .map(([tool, counts]) => `${AGENT_TOOL_LABELS[tool]}: ${describeAgentCounts(counts)}.`)
    .join(" ");
}

/** Working and waiting of every tool stacked: the bar's total height is the busy sessions. */
function busy(frame: AgentsFrame): number {
  return agentToolsPresent(frame.data).reduce(
    (sum, [, counts]) => sum + counts.working + counts.waitingOnInput,
    0,
  );
}

/**
 * One stacked bar per sample: every tool's working sessions at the bottom, each in
 * its own colour, and the ones waiting on input on top in each tool's shade of the
 * warning colour, so the amber part of a bar is what needs the person. Scaled to the
 * row's own peak (at least two agents). The details panel is the legend: its swatches
 * are painted with the same tokens.
 */
function drawRow(ctx: CanvasRenderingContext2D, frames: readonly AgentsFrame[], view: RowView) {
  const colors = {
    grid: css("--border"),
    working: Object.fromEntries(
      AGENT_TOOLS.map((tool) => [tool, css(TOOL_COLOR_TOKENS[tool].working)]),
    ) as Record<AgentTool, string>,
    waiting: Object.fromEntries(
      AGENT_TOOLS.map((tool) => [tool, css(TOOL_COLOR_TOKENS[tool].waiting)]),
    ) as Record<AgentTool, string>,
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
    if (busy(frame) === 0) {
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
    const tools = agentToolsPresent(frame.data);
    // Working segments first, bottom up, then the waiting ones on top of all of them.
    const segments = [
      ...tools.map(([tool, counts]) => ({ color: colors.working[tool], agents: counts.working })),
      ...tools.map(([tool, counts]) => ({
        color: colors.waiting[tool],
        agents: counts.waitingOnInput,
      })),
    ];
    let top = plotBottom;
    for (const segment of segments) {
      if (segment.agents === 0) {
        continue;
      }
      const segmentTop = top - heightFor(segment.agents);
      ctx.fillStyle = segment.color;
      ctx.fillRect(x0, segmentTop, width, top - segmentTop);
      top = segmentTop;
    }
  }
}

/**
 * One row per tool found, its label carrying a swatch in the colour its bars are
 * drawn in (the legend for the row above), amber while one of its sessions is waiting
 * on input. The whole frame in one sentence is the tooltip.
 */
function AgentsDetails({ frame }: { frame: AgentsFrame }) {
  const tools = agentToolsPresent(frame.data);
  if (tools.length === 0) {
    return (
      <dl className="kv">
        <dt>agents</dt>
        <dd>{AGENTS_NOT_FOUND}</dd>
      </dl>
    );
  }
  return (
    <dl className="kv" title={describeAgents(frame.data)}>
      {tools.map(([tool, counts]) => (
        <Fragment key={tool}>
          <dt>
            <span className={`swatch swatch-${tool}`} aria-hidden="true" />
            {AGENT_TOOL_LABELS[tool]}
          </dt>
          <dd className={counts.waitingOnInput > 0 ? "level-warn" : ""}>
            {describeAgentCounts(counts)}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export const agentsCollector: CollectorUi<"agents"> = {
  label: "agents",
  rowHeight: 40,
  drawRow,
  Details: AgentsDetails,
};
