// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { makeAgentCounts, makeAgentsData, makeAgentsFrame } from "@afk/shared/testing";
import {
  AGENTS_NOT_FOUND,
  agentsCollector,
  describeAgentCounts,
  describeAgents,
} from "./agents.tsx";

afterEach(cleanup);

describe("describeAgentCounts", () => {
  it("counts the sessions by state and the working subagents in one clause", () => {
    const counts = makeAgentCounts({
      sessions: 3,
      working: 1,
      waitingOnInput: 1,
      idle: 1,
      subagentsWorking: 2,
    });

    expect(describeAgentCounts(counts)).toBe(
      "3 sessions, 1 working, 1 waiting on input, 1 idle, 2 subagents working",
    );
  });

  it("uses the singular for one session and one subagent", () => {
    const counts = makeAgentCounts({
      sessions: 1,
      working: 1,
      waitingOnInput: 0,
      idle: 0,
      subagentsWorking: 1,
    });

    expect(describeAgentCounts(counts)).toBe("1 session, 1 working, 1 subagent working");
  });

  it("leaves out the states nobody is in", () => {
    const counts = makeAgentCounts({ sessions: 2, working: 0, idle: 2, subagentsWorking: 0 });

    expect(describeAgentCounts(counts)).toBe("2 sessions, 2 idle");
  });

  it("says there are no sessions when the tool is installed but not running", () => {
    const counts = makeAgentCounts({ sessions: 0, working: 0, idle: 0 });

    expect(describeAgentCounts(counts)).toBe("no sessions");
  });
});

describe("describeAgents", () => {
  it("writes a sentence per tool found, Claude Code first", () => {
    const data = makeAgentsData({
      claude: { sessions: 3, working: 1, waitingOnInput: 1, idle: 1, subagentsWorking: 2 },
      codex: { sessions: 1, working: 1, idle: 0 },
    });

    expect(describeAgents(data)).toBe(
      "Claude Code: 3 sessions, 1 working, 1 waiting on input, 1 idle, 2 subagents working. " +
        "Codex: 1 session, 1 working.",
    );
  });

  it("mentions only the tool that is on the machine", () => {
    const data = makeAgentsData({ claude: null, codex: { sessions: 1, working: 1, idle: 0 } });

    expect(describeAgents(data)).toBe("Codex: 1 session, 1 working.");
  });

  it("says neither tool was found when the collector reports nothing available, whatever the counts", () => {
    const data = makeAgentsData({ available: false, claude: { sessions: 0, working: 0, idle: 0 } });

    expect(describeAgents(data)).toBe(AGENTS_NOT_FOUND);
  });
});

describe("AgentsDetails", () => {
  const { Details } = agentsCollector;

  it("renders one line per tool under its label, with a swatch in the tool's colour as the legend", () => {
    const frame = makeAgentsFrame(0, {
      claude: { sessions: 2, working: 2, idle: 0 },
      codex: { sessions: 1, working: 1, idle: 0 },
    });

    render(<Details frame={frame} />);

    const claude = screen.getByText("Claude Code");
    const codex = screen.getByText("Codex");
    expect(claude.tagName).toBe("DT");
    expect(claude.querySelector(".swatch")?.className).toBe("swatch swatch-claude");
    expect(codex.querySelector(".swatch")?.className).toBe("swatch swatch-codex");
    expect(screen.getByText("2 sessions, 2 working").tagName).toBe("DD");
    expect(screen.getByText("1 session, 1 working").tagName).toBe("DD");
  });

  it("puts the whole frame in one sentence as the tooltip", () => {
    const frame = makeAgentsFrame(0, { claude: { sessions: 1, working: 1, idle: 0 } });

    render(<Details frame={frame} />);

    expect(screen.getByTitle("Claude Code: 1 session, 1 working.").tagName).toBe("DL");
  });

  it("marks a tool's line as a warning while one of its sessions is waiting on input", () => {
    const frame = makeAgentsFrame(0, {
      claude: { sessions: 1, working: 0, idle: 0, waitingOnInput: 1 },
      codex: { sessions: 1, working: 1, idle: 0 },
    });

    render(<Details frame={frame} />);

    expect(screen.getByText(/waiting on input/).className).toBe("level-warn");
    expect(screen.getByText("1 session, 1 working").className).toBe("");
  });

  it("does not mark the line when nobody is waiting", () => {
    const frame = makeAgentsFrame(0);

    render(<Details frame={frame} />);

    expect(screen.getByText("2 sessions, 1 working, 1 idle").className).toBe("");
  });

  it("leaves out a tool that is not on the machine", () => {
    const frame = makeAgentsFrame(0, { claude: null, codex: { sessions: 1 } });

    render(<Details frame={frame} />);

    expect(screen.queryByText("Claude Code")).toBeNull();
    expect(screen.getByText("Codex").tagName).toBe("DT");
  });

  it("renders the not-found line for a machine with neither tool", () => {
    const frame = makeAgentsFrame(0, { claude: null });

    render(<Details frame={frame} />);

    expect(screen.getByText(AGENTS_NOT_FOUND).className).toBe("");
  });
});
