import { describe, expect, it } from "vitest";
import { T0_MS, makeAgentsFrame, makeStoredFrames } from "@afk/shared/testing";
import type { AgentsDataOverrides } from "@afk/shared/testing";
import { agentsAllIdle, agentsWaiting } from "./agents.ts";
import { RuleEngine } from "./engine.ts";
import { register } from "./types.ts";

const seconds = (n: number) => T0_MS + n * 1000;

/** The client samples agents every 5 s. */
const INTERVAL_SECONDS = 5;

/**
 * Agents frames every 5 s from `fromSeconds` to `toSeconds` inclusive, every one with
 * the same counts. Sequences follow the offsets so the series stays in order.
 */
function series(fromSeconds: number, toSeconds: number, counts: AgentsDataOverrides) {
  const frames = [];
  for (let at = fromSeconds; at <= toSeconds; at += INTERVAL_SECONDS) {
    frames.push(makeAgentsFrame(at, { ...counts, sequence: at / INTERVAL_SECONDS + 1 }));
  }
  return frames;
}

const oneWaiting: AgentsDataOverrides = {
  claude: { sessions: 2, working: 1, waitingOnInput: 1, idle: 0 },
};
const nobodyWaiting: AgentsDataOverrides = {
  claude: { sessions: 2, working: 1, waitingOnInput: 0, idle: 1 },
};
const allIdle: AgentsDataOverrides = {
  claude: { sessions: 2, working: 0, waitingOnInput: 0, idle: 2 },
};
const idleCodex = { sessions: 1, working: 0, waitingOnInput: 0, idle: 1 };

describe("agents.waiting", () => {
  it("stays quiet while an agent has been waiting for less than 2 minutes", () => {
    const engine = new RuleEngine([register(agentsWaiting)]);

    engine.onFrames(makeStoredFrames(series(0, 115, oneWaiting)));

    expect(engine.events).toEqual([]);
  });

  it("opens a warning once an agent has waited 2 minutes, backdated to the first waiting sample, naming its tool", () => {
    const engine = new RuleEngine([register(agentsWaiting)]);

    engine.onFrames(
      makeStoredFrames([...series(0, 25, nobodyWaiting), ...series(30, 150, oneWaiting)]),
    );

    expect(engine.events).toEqual([
      {
        id: `agents:agents.waiting:${seconds(30)}`,
        stream: "agents",
        kind: "agents.waiting",
        severity: "warning",
        message: "1 Claude Code agent has been waiting on you for over 2m",
        startedAt: seconds(30),
        endedAt: null,
      },
    ]);
  });

  it("names Codex when the waiting agent is a Codex thread", () => {
    const engine = new RuleEngine([register(agentsWaiting)]);

    engine.onFrames(
      makeStoredFrames(
        series(0, 120, {
          claude: { sessions: 1, working: 1, waitingOnInput: 0, idle: 0 },
          codex: { sessions: 1, working: 0, waitingOnInput: 1, idle: 0 },
        }),
      ),
    );

    expect(engine.events[0]?.message).toBe("1 Codex agent has been waiting on you for over 2m");
  });

  it("gives the total without a tool name when agents of both tools are waiting", () => {
    const engine = new RuleEngine([register(agentsWaiting)]);

    engine.onFrames(
      makeStoredFrames(
        series(0, 120, {
          claude: { sessions: 2, working: 0, waitingOnInput: 2, idle: 0 },
          codex: { sessions: 1, working: 0, waitingOnInput: 1, idle: 0 },
        }),
      ),
    );

    expect(engine.events[0]?.message).toBe("3 agents have been waiting on you for over 2m");
  });

  it("pluralises when more than one agent of the same tool is waiting", () => {
    const engine = new RuleEngine([register(agentsWaiting)]);

    engine.onFrames(
      makeStoredFrames(
        series(0, 120, { claude: { sessions: 3, working: 1, waitingOnInput: 2, idle: 0 } }),
      ),
    );

    expect(engine.events[0]?.message).toBe(
      "2 Claude Code agents have been waiting on you for over 2m",
    );
  });

  it("updates the message when the number waiting changes while the event is open", () => {
    const engine = new RuleEngine([register(agentsWaiting)]);
    engine.onFrames(makeStoredFrames(series(0, 120, oneWaiting)));

    const changed = engine.onFrames(
      makeStoredFrames(
        series(125, 125, {
          claude: { sessions: 3, working: 0, waitingOnInput: 2, idle: 1 },
        }).map((f) => ({ ...f, sequence: 26 })),
      ),
    );

    expect(changed).toHaveLength(1);
    expect(engine.events).toHaveLength(1);
    expect(engine.events[0]?.message).toBe(
      "2 Claude Code agents have been waiting on you for over 2m",
    );
  });

  it("closes the event at the first sample with nobody waiting", () => {
    const engine = new RuleEngine([register(agentsWaiting)]);
    engine.onFrames(makeStoredFrames(series(0, 120, oneWaiting)));

    engine.onFrames(makeStoredFrames(series(125, 125, nobodyWaiting)));

    expect(engine.events).toEqual([
      expect.objectContaining({ startedAt: seconds(0), endedAt: seconds(125) }),
    ]);
  });

  it("starts the 2 minutes over when the wait is interrupted before they are up", () => {
    const engine = new RuleEngine([register(agentsWaiting)]);

    engine.onFrames(
      makeStoredFrames([
        ...series(0, 60, oneWaiting),
        ...series(65, 65, nobodyWaiting),
        ...series(70, 190, oneWaiting),
      ]),
    );

    expect(engine.events).toEqual([expect.objectContaining({ startedAt: seconds(70) })]);
  });

  it("ignores frames from a machine with neither tool, whatever a stale block says", () => {
    const engine = new RuleEngine([register(agentsWaiting)]);

    engine.onFrames(makeStoredFrames(series(0, 300, { ...oneWaiting, available: false })));

    expect(engine.events).toEqual([]);
  });
});

describe("agents.all-idle", () => {
  it("opens an info event once every agent has been idle for 60 s, backdated, naming the one tool", () => {
    const engine = new RuleEngine([register(agentsAllIdle)]);

    engine.onFrames(
      makeStoredFrames([...series(0, 15, nobodyWaiting), ...series(20, 80, allIdle)]),
    );

    expect(engine.events).toEqual([
      {
        id: `agents:agents.all-idle:${seconds(20)}`,
        stream: "agents",
        kind: "agents.all-idle",
        severity: "info",
        message: "all 2 Claude Code agents idle for over 60s",
        startedAt: seconds(20),
        endedAt: null,
      },
    ]);
  });

  it("counts the sessions of both tools without a tool name when both are idle", () => {
    const engine = new RuleEngine([register(agentsAllIdle)]);

    engine.onFrames(makeStoredFrames(series(0, 60, { ...allIdle, codex: idleCodex })));

    expect(engine.events[0]?.message).toBe("all 3 agents idle for over 60s");
  });

  it("stays quiet at 55 s of idleness", () => {
    const engine = new RuleEngine([register(agentsAllIdle)]);

    engine.onFrames(makeStoredFrames(series(0, 55, allIdle)));

    expect(engine.events).toEqual([]);
  });

  it("phrases a single session without the word all", () => {
    const engine = new RuleEngine([register(agentsAllIdle)]);

    engine.onFrames(makeStoredFrames(series(0, 60, { claude: null, codex: idleCodex })));

    expect(engine.events[0]?.message).toBe("1 Codex agent idle for over 60s");
  });

  it("does not count a machine with no sessions as all idle", () => {
    const engine = new RuleEngine([register(agentsAllIdle)]);

    engine.onFrames(
      makeStoredFrames(
        series(0, 300, { claude: { sessions: 0, working: 0, waitingOnInput: 0, idle: 0 } }),
      ),
    );

    expect(engine.events).toEqual([]);
  });

  it("does not open while a subagent is still working", () => {
    const engine = new RuleEngine([register(agentsAllIdle)]);

    engine.onFrames(
      makeStoredFrames(series(0, 300, { claude: { ...allIdle.claude, subagentsWorking: 1 } })),
    );

    expect(engine.events).toEqual([]);
  });

  it("does not open while the other tool's agent is still working", () => {
    const engine = new RuleEngine([register(agentsAllIdle)]);

    engine.onFrames(
      makeStoredFrames(series(0, 300, { ...allIdle, codex: { sessions: 1, working: 1, idle: 0 } })),
    );

    expect(engine.events).toEqual([]);
  });

  it("closes as soon as a session starts working again", () => {
    const engine = new RuleEngine([register(agentsAllIdle)]);
    engine.onFrames(makeStoredFrames(series(0, 60, allIdle)));

    engine.onFrames(makeStoredFrames(series(65, 65, nobodyWaiting)));

    expect(engine.events).toEqual([
      expect.objectContaining({ startedAt: seconds(0), endedAt: seconds(65) }),
    ]);
  });
});
