// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { makeAgentsData, makeAgentsFrame } from "@afk/shared/testing";
import { CLAUDE_NOT_FOUND, agentsCollector, describeAgents } from "./agents.tsx";

afterEach(cleanup);

describe("describeAgents", () => {
  it("counts the sessions by state and the working subagents in one line", () => {
    const data = makeAgentsData({
      sessions: 3,
      working: 1,
      waitingOnInput: 1,
      idle: 1,
      subagentsWorking: 2,
    });

    expect(describeAgents(data)).toBe(
      "3 sessions: 1 working, 1 waiting on input, 1 idle; 2 subagents working",
    );
  });

  it("uses the singular for one session and one subagent", () => {
    const data = makeAgentsData({
      sessions: 1,
      working: 1,
      waitingOnInput: 0,
      idle: 0,
      subagentsWorking: 1,
    });

    expect(describeAgents(data)).toBe(
      "1 session: 1 working, 0 waiting on input, 0 idle; 1 subagent working",
    );
  });

  it("leaves out the subagent clause when none are working", () => {
    const data = makeAgentsData({ sessions: 2, working: 1, idle: 1, subagentsWorking: 0 });

    expect(describeAgents(data)).toBe("2 sessions: 1 working, 0 waiting on input, 1 idle");
  });

  it("says there are no sessions when Claude Code is installed but not running", () => {
    const data = makeAgentsData({ sessions: 0, working: 0, idle: 0 });

    expect(describeAgents(data)).toBe("no sessions");
  });

  it("says Claude Code was not found when the collector reports it unavailable, whatever the counts", () => {
    const data = makeAgentsData({ available: false, sessions: 0, working: 0, idle: 0 });

    expect(describeAgents(data)).toBe(CLAUDE_NOT_FOUND);
  });
});

describe("AgentsDetails", () => {
  const { Details } = agentsCollector;

  it("renders the summary line under a claude code label", () => {
    const frame = makeAgentsFrame(0, { sessions: 2, working: 2, idle: 0 });

    render(<Details frame={frame} />);

    expect(screen.getByText("claude code").tagName).toBe("DT");
    expect(screen.getByText("2 sessions: 2 working, 0 waiting on input, 0 idle").tagName).toBe(
      "DD",
    );
  });

  it("marks the line as a warning while a session is waiting on input", () => {
    const frame = makeAgentsFrame(0, { sessions: 1, working: 0, idle: 0, waitingOnInput: 1 });

    render(<Details frame={frame} />);

    expect(screen.getByText(/waiting on input/).className).toBe("level-warn");
  });

  it("does not mark the line when nobody is waiting", () => {
    const frame = makeAgentsFrame(0);

    render(<Details frame={frame} />);

    expect(screen.getByText(/waiting on input/).className).toBe("");
  });

  it("renders the not-found line for a machine without Claude Code", () => {
    const frame = makeAgentsFrame(0, { available: false, sessions: 0, working: 0, idle: 0 });

    render(<Details frame={frame} />);

    expect(screen.getByText(CLAUDE_NOT_FOUND).className).toBe("");
  });
});
