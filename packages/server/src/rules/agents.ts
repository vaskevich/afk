import { AGENT_TOOL_LABELS, agentToolsPresent, agentTotals } from "@afk/shared";
import type { AgentCounts, AgentsCollectorData } from "@afk/shared";
import { INACTIVE, Sustain, type Rule } from "./types.ts";

/**
 * An agent waiting on input this long (a permission prompt, a question) is not going
 * to get it from the machine: the person has to come back. Longer than the client's
 * own 120 s activity window so a slow tool call never reads as a wait.
 */
export const AGENT_WAITING_AFTER_MS = 120_000;
/** Every agent idle, nothing working, for this long: the work is done. */
export const AGENTS_ALL_IDLE_AFTER_MS = 60_000;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * "1 Codex agent" when every agent the count is about belongs to one tool, "2 agents"
 * when they are spread over several: `pick` says which count of a tool's block is
 * being talked about, and the tool is named only when it alone contributes to it.
 */
function agentsOf(data: AgentsCollectorData, pick: (counts: AgentCounts) => number): string {
  const contributing = agentToolsPresent(data).filter(([, counts]) => pick(counts) > 0);
  const total = contributing.reduce((sum, [, counts]) => sum + pick(counts), 0);
  const noun =
    contributing.length === 1 ? `${AGENT_TOOL_LABELS[contributing[0]![0]]} agent` : "agent";
  return plural(total, noun);
}

/**
 * One or more agents, of any tool, have been waiting on input for a while. The
 * message follows the count while the event is open ("1 Claude Code agent has been
 * waiting on you for over 2m", "2 agents have been…" once both tools are); it is
 * backdated to the first sample that had someone waiting.
 */
export const agentsWaiting: Rule<"agents"> = {
  kind: "agents.waiting",
  collector: "agents",
  create() {
    const sustain = new Sustain(AGENT_WAITING_AFTER_MS);
    return {
      onFrame(frame, atMs) {
        const waiting = agentTotals(frame.data).waitingOnInput;
        const since = sustain.update(waiting > 0, atMs);
        if (since === null) {
          return INACTIVE;
        }
        const verb = waiting === 1 ? "has" : "have";
        const who = agentsOf(frame.data, (counts) => counts.waitingOnInput);
        return {
          active: true,
          severity: "warning",
          message: `${who} ${verb} been waiting on you for over ${AGENT_WAITING_AFTER_MS / 60_000}m`,
          since,
        };
      },
    };
  },
};

/**
 * Every session of every tool is idle and no subagent is working: whatever was
 * running has finished. Info, since it is the good kind of news; closes as soon as
 * anything starts working or waiting again.
 */
export const agentsAllIdle: Rule<"agents"> = {
  kind: "agents.all-idle",
  collector: "agents",
  create() {
    const sustain = new Sustain(AGENTS_ALL_IDLE_AFTER_MS);
    return {
      onFrame(frame, atMs) {
        const totals = agentTotals(frame.data);
        const allIdle =
          totals.sessions > 0 &&
          totals.working === 0 &&
          totals.waitingOnInput === 0 &&
          totals.subagentsWorking === 0;
        const since = sustain.update(allIdle, atMs);
        if (since === null) {
          return INACTIVE;
        }
        const who = agentsOf(frame.data, (counts) => counts.sessions);
        const all = totals.sessions === 1 ? "" : "all ";
        return {
          active: true,
          severity: "info",
          message: `${all}${who} idle for over ${AGENTS_ALL_IDLE_AFTER_MS / 1000}s`,
          since,
        };
      },
    };
  },
};
