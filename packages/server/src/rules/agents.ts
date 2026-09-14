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
 * One or more Claude Code sessions have been waiting on input for a while. The
 * message follows the count while the event is open ("1 agent has been waiting on
 * you for over 2m", "2 agents have been…"); it is backdated to the first sample that
 * had someone waiting.
 */
export const agentsWaiting: Rule<"agents"> = {
  kind: "agents.waiting",
  collector: "agents",
  create() {
    const sustain = new Sustain(AGENT_WAITING_AFTER_MS);
    return {
      onFrame(frame, atMs) {
        const { available, claude } = frame.data;
        const waiting = claude.waitingOnInput;
        const since = sustain.update(available && waiting > 0, atMs);
        if (since === null) {
          return INACTIVE;
        }
        const verb = waiting === 1 ? "has" : "have";
        return {
          active: true,
          severity: "warning",
          message: `${plural(waiting, "agent")} ${verb} been waiting on you for over ${AGENT_WAITING_AFTER_MS / 60_000}m`,
          since,
        };
      },
    };
  },
};

/**
 * Every Claude Code session is idle and no subagent is working: whatever was running
 * has finished. Info, since it is the good kind of news; closes as soon as anything
 * starts working or waiting again.
 */
export const agentsAllIdle: Rule<"agents"> = {
  kind: "agents.all-idle",
  collector: "agents",
  create() {
    const sustain = new Sustain(AGENTS_ALL_IDLE_AFTER_MS);
    return {
      onFrame(frame, atMs) {
        const { available, claude } = frame.data;
        const allIdle =
          available &&
          claude.sessions > 0 &&
          claude.working === 0 &&
          claude.waitingOnInput === 0 &&
          claude.subagentsWorking === 0;
        const since = sustain.update(allIdle, atMs);
        if (since === null) {
          return INACTIVE;
        }
        const who = claude.sessions === 1 ? "1 agent" : `all ${claude.sessions} agents`;
        return {
          active: true,
          severity: "info",
          message: `${who} idle for over ${AGENTS_ALL_IDLE_AFTER_MS / 1000}s`,
          since,
        };
      },
    };
  },
};
