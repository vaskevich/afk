import { describe, expect, it } from "vitest";
import { FramesResponse, agentToolsPresent, agentTotals } from "@afk/shared";
import type { AgentsFrame, RunFrame } from "@afk/shared";
import { generateDemoSession } from "./fixtureSource.ts";

/** The agents stream's frames in order. */
function agentsFrames(data: FramesResponse): AgentsFrame[] {
  return data.frames
    .map((f) => f.frame)
    .filter((frame): frame is AgentsFrame => frame.collector === "agents");
}

describe("generateDemoSession", () => {
  it("produces a session that validates against the FramesResponse schema", () => {
    const result = FramesResponse.safeParse(generateDemoSession("demo"));

    expect(result.success).toBe(true);
  });

  it("is deterministic: two calls produce identical output", () => {
    const first = generateDemoSession("demo");
    const second = generateDemoSession("demo");

    expect(second).toEqual(first);
  });

  it("only references streams that exist among its frames in every event", () => {
    const data = generateDemoSession("demo");
    const streams = new Set(data.frames.map((f) => f.frame.stream));

    for (const event of data.events) {
      expect(streams.has(event.stream)).toBe(true);
    }
  });

  it("has a gap in frame timestamps for the documented stale stretch", () => {
    const data = generateDemoSession("demo");
    const timestamps = data.frames.map((f) => f.frame.timestamp).sort((a, b) => a - b);

    let maxGapSeconds = 0;
    for (let i = 1; i < timestamps.length; i++) {
      maxGapSeconds = Math.max(maxGapSeconds, timestamps[i]! - timestamps[i - 1]!);
    }

    // The doc comment promises a 90 s stretch with no frames at all; the measured gap
    // between the last frame before it and the first frame after it is one second
    // wider, since STALE_END itself is excluded from the stretch but still marks the
    // far edge of the gap between samples.
    expect(maxGapSeconds).toBe(91);
  });

  it("samples the processes stream every 5 s, skipping the stale stretch", () => {
    const data = generateDemoSession("demo");
    const startSeconds = data.session.startedAt / 1000;

    const processes = data.frames.filter((f) => f.frame.stream === "processes");

    // 15 minutes at one sample per 5 s is 180 samples, minus the 18 that fall in the
    // 90 s stale stretch.
    expect(processes).toHaveLength(180 - 18);
    expect(processes.every((f) => (f.frame.timestamp - startSeconds) % 5 === 0)).toBe(true);
    expect(processes.map((f) => f.frame.sequence)).toEqual(processes.map((_, i) => i + 1));
  });

  it("samples the agents stream every 5 s with a block per tool whose states partition its sessions", () => {
    const data = generateDemoSession("demo");

    const agents = agentsFrames(data);

    expect(agents).toHaveLength(180 - 18);
    expect(agents.map((frame) => frame.sequence)).toEqual(agents.map((_, i) => i + 1));
    expect(agents.every((frame) => frame.data.available)).toBe(true);
    for (const frame of agents) {
      for (const [, counts] of agentToolsPresent(frame.data)) {
        expect(counts.working + counts.waitingOnInput + counts.idle).toBe(counts.sessions);
      }
      expect(agentToolsPresent(frame.data).map(([tool]) => tool)).toEqual(["claude", "codex"]);
    }
    expect(agents.some((frame) => frame.data.claude!.waitingOnInput > 0)).toBe(true);
    expect(agents.some((frame) => frame.data.claude!.subagentsWorking > 0)).toBe(true);
  });

  it("has the Codex thread working while a Claude Code session is waiting, and idle with everything else at the end", () => {
    const data = generateDemoSession("demo");
    const agents = agentsFrames(data);

    const overlap = agents.filter(
      (frame) => frame.data.claude!.waitingOnInput > 0 && frame.data.codex!.working > 0,
    );
    const last = agents.at(-1)!.data;

    expect(overlap.length).toBeGreaterThan(0);
    expect(agentTotals(last)).toMatchObject({ sessions: 3, working: 0, waitingOnInput: 0 });
  });

  it("opens agents.waiting at the first sample that has a session waiting on input, naming Claude Code", () => {
    const data = generateDemoSession("demo");
    const waiting = data.events.find((event) => event.kind === "agents.waiting")!;

    const firstWaiting = agentsFrames(data).find((frame) => frame.data.claude!.waitingOnInput > 0)!;

    expect(waiting).toMatchObject({
      stream: "agents",
      severity: "warning",
      startedAt: firstWaiting.timestamp * 1000,
      message: "1 Claude Code agent has been waiting on you for over 2m",
    });
  });

  it("opens agents.all-idle at the first sample where every agent of both tools is idle, counting them all", () => {
    const data = generateDemoSession("demo");
    const allIdle = data.events.find((event) => event.kind === "agents.all-idle")!;

    const firstIdle = agentsFrames(data).find((frame) => {
      const totals = agentTotals(frame.data);
      return totals.sessions > 0 && totals.working + totals.waitingOnInput === 0;
    })!;

    expect(allIdle).toMatchObject({
      stream: "agents",
      severity: "info",
      startedAt: firstIdle.timestamp * 1000,
      endedAt: data.session.endedAt,
      message: "all 3 agents idle for over 60s",
    });
    expect(agentTotals(firstIdle.data).sessions).toBe(3);
  });

  it("wraps a failing migration in a run stream whose final frame alone carries the output tail", () => {
    const data = generateDemoSession("demo");

    const run = data.frames
      .map((f) => f.frame)
      .filter((frame): frame is RunFrame => frame.collector === "run");

    expect(run.length).toBeGreaterThan(1);
    expect(new Set(run.map((frame) => frame.stream)).size).toBe(1);
    expect(run.map((frame) => frame.sequence)).toEqual(run.map((_, i) => i + 1));
    const final = run[run.length - 1]!;
    expect(run.slice(0, -1).every((frame) => frame.data.state === "running")).toBe(true);
    expect(run.slice(0, -1).every((frame) => frame.data.output.tail === undefined)).toBe(true);
    expect(final.data).toMatchObject({
      state: "exited",
      exitCode: 3,
      output: {
        tail: {
          stdout: expect.arrayContaining(["processing 300/10000 items"]),
          stderr: [expect.stringContaining("fatal")],
          truncated: true,
        },
      },
    });
  });

  it("gives the run.exited event the final frame's tail and ends its message with the last stderr line", () => {
    const data = generateDemoSession("demo");
    const exited = data.events.find((event) => event.kind === "run.exited")!;

    const final = data.frames.filter((f) => f.frame.stream === exited.stream).at(-1)!.frame;

    expect(final.collector).toBe("run");
    if (final.collector === "run") {
      const tail = final.data.output.tail!;
      expect(exited).toMatchObject({
        severity: "critical",
        startedAt: final.timestamp * 1000,
        endedAt: final.timestamp * 1000,
        details: { outputTail: tail },
      });
      expect(exited.message.endsWith(`: ${tail.stderr.at(-1)!}`)).toBe(true);
    }
  });

  it("gives the cpu.high event details matching the processes sample at its start", () => {
    const data = generateDemoSession("demo");
    const cpuHigh = data.events.find((event) => event.kind === "cpu.high")!;

    const atOpen = data.frames.find(
      (f) => f.frame.stream === "processes" && f.frame.timestamp * 1000 === cpuHigh.startedAt,
    )!;

    expect(atOpen.frame.collector).toBe("processes");
    if (atOpen.frame.collector === "processes") {
      const expected = atOpen.frame.data.top
        .slice(0, 3)
        .map(({ pid, cpuPercent, command }) => ({ pid, cpuPercent, command }));
      expect(cpuHigh.details).toEqual({ topProcesses: expected });
      expect(expected[0]!.command).toBe("/opt/homebrew/bin/node");
      expect(cpuHigh.message).toContain("(top: node ");
    }
  });
});
