import { describe, expect, it } from "vitest";
import {
  makeAgentCounts,
  makeAgentsData,
  makeAgentsFrame,
  makeEvent,
  makeHost,
  makeProcessesData,
  makeProcessesFrame,
  makeRunFrame,
  makeRunTail,
  makeSessionSummary,
  makeStoredFrames,
  makeSystemFrame,
} from "./testing.ts";
import {
  AGENT_TOOLS,
  AGENT_TOOL_LABELS,
  AnomalyEvent,
  CreateSessionRequest,
  CreateSessionResponse,
  EVENT_TOP_PROCESSES_MAX,
  Frame,
  FramesResponse,
  MemoryPressureLevel,
  PROCESSES_TOP_MAX,
  MIN_CLIENT_VERSION,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RUN_TAIL_MAX_LINE_CHARS,
  RUN_TAIL_MAX_LINES,
  SessionSummary,
  DEMO_SESSION_ID,
  DeleteSessionResponse,
  DeletedSessionDetails,
  StoredFrame,
  StreamEndEvent,
  StreamEventName,
  UpgradeRequiredDetails,
  VersionResponse,
  agentToolsPresent,
  agentTotals,
} from "./protocol.ts";

/**
 * Shared tests for the wire schemas (see docs/TESTING.md, "shared" section): valid
 * input parses, invalid input is rejected with the offending field named, and enums
 * match what docs/PROTOCOL.md promises.
 */

describe("Frame", () => {
  it("accepts a valid system frame", () => {
    const result = Frame.safeParse(makeSystemFrame(0));

    expect(result.success).toBe(true);
  });

  it("accepts a valid run frame", () => {
    const result = Frame.safeParse(makeRunFrame(0));

    expect(result.success).toBe(true);
  });

  it("accepts a valid processes frame", () => {
    const result = Frame.safeParse(makeProcessesFrame(0));

    expect(result.success).toBe(true);
  });

  it("accepts a valid agents frame", () => {
    const result = Frame.safeParse(makeAgentsFrame(0));

    expect(result.success).toBe(true);
  });

  it("accepts an agents frame with a block per tool found, Claude Code and Codex", () => {
    const frame = makeAgentsFrame(0, {
      claude: { sessions: 2, working: 1, idle: 1 },
      codex: { sessions: 1, working: 1, idle: 0 },
    });

    const result = Frame.safeParse(frame);

    expect(result).toMatchObject({
      success: true,
      data: { data: { available: true, codex: { sessions: 1 } } },
    });
  });

  it("accepts an agents frame from a machine with neither tool: available false and no blocks", () => {
    const frame = makeAgentsFrame(0, { claude: null });

    const result = Frame.safeParse(frame);

    expect(result).toMatchObject({ success: true, data: { data: { available: false } } });
    expect(frame.data).toEqual({ available: false });
  });

  it("accepts an agents frame from a client before Codex support: available false with a zero claude block", () => {
    const frame = makeAgentsFrame(0, {
      available: false,
      claude: { sessions: 0, working: 0, idle: 0, waitingOnInput: 0, subagentsWorking: 0 },
    });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(true);
  });

  it("rejects a negative agent count, naming the tool and the field", () => {
    const frame = makeAgentsFrame(0, { codex: { waitingOnInput: -1 } });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "codex", "waitingOnInput"]);
    }
  });

  it("rejects a fractional agent count, naming the field", () => {
    const frame = makeAgentsFrame(0, { claude: { subagentsWorking: 1.5 } });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "claude", "subagentsWorking"]);
    }
  });

  it("rejects a processes frame with more than the maximum top entries", () => {
    const [entry] = makeProcessesData().top;
    const frame = makeProcessesFrame(0, {
      top: Array.from({ length: PROCESSES_TOP_MAX + 1 }, () => ({ ...entry! })),
    });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "top"]);
    }
  });

  it("rejects a process command longer than 512 characters", () => {
    const [entry] = makeProcessesData().top;
    const frame = makeProcessesFrame(0, { top: [{ ...entry!, command: "/x".repeat(257) }] });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "top", 0, "command"]);
    }
  });

  it("rejects an unknown collector", () => {
    const frame = { ...makeSystemFrame(0), collector: "process" };

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["collector"]);
    }
  });

  it("rejects a frame missing stream", () => {
    const frame: Record<string, unknown> = { ...makeSystemFrame(0) };
    delete frame.stream;

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["stream"]);
    }
  });

  it("rejects a non-positive sequence", () => {
    const frame = makeSystemFrame(0, { sequence: 0 });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["sequence"]);
    }
  });

  it("rejects a negative byte count", () => {
    const frame = makeRunFrame(0, {
      output: { flavor: "volume", stdoutBytes: -1, stderrBytes: 0 },
    });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "output", "stdoutBytes"]);
    }
  });

  it("rejects an unknown output flavor", () => {
    const frame = makeRunFrame(0, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately invalid flavor for the rejection test
      output: { flavor: "progress", stdoutBytes: 0, stderrBytes: 0 } as any,
    });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "output", "flavor"]);
    }
  });

  it("rejects a run state outside the enum", () => {
    const frame = { ...makeRunFrame(0), data: { ...makeRunFrame(0).data, state: "paused" } };

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "state"]);
    }
  });

  it("accepts an exited run frame carrying an output tail", () => {
    const tail = makeRunTail({ truncated: true });
    const frame = makeRunFrame(5, { state: "exited", exitCode: 3, tail });

    const result = Frame.safeParse(frame);

    expect(result).toMatchObject({ success: true, data: { data: { output: { tail } } } });
  });

  it("rejects a tail with more than the maximum lines, naming the stream", () => {
    const stderr = Array.from({ length: RUN_TAIL_MAX_LINES + 1 }, (_, i) => `line ${i}`);
    const frame = makeRunFrame(5, { state: "exited", exitCode: 1, tail: makeRunTail({ stderr }) });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "output", "tail", "stderr"]);
    }
  });

  it("rejects a tail line longer than the maximum characters, naming the line", () => {
    const stdout = ["x".repeat(RUN_TAIL_MAX_LINE_CHARS + 1)];
    const frame = makeRunFrame(5, { state: "exited", exitCode: 1, tail: makeRunTail({ stdout }) });

    const result = Frame.safeParse(frame);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["data", "output", "tail", "stdout", 0]);
    }
  });
});

describe("CreateSessionRequest", () => {
  const valid = () => ({
    protocolVersion: PROTOCOL_VERSION,
    clientVersion: "0.1.0",
    host: makeHost(),
  });

  it("accepts every protocolVersion in [MIN_PROTOCOL_VERSION, PROTOCOL_VERSION]", () => {
    for (let version = MIN_PROTOCOL_VERSION; version <= PROTOCOL_VERSION; version += 1) {
      const result = CreateSessionRequest.safeParse({ ...valid(), protocolVersion: version });

      expect(result.success, `version ${version}`).toBe(true);
    }
  });

  it("rejects a protocolVersion above PROTOCOL_VERSION, naming the field and the accepted range", () => {
    const result = CreateSessionRequest.safeParse({
      ...valid(),
      protocolVersion: PROTOCOL_VERSION + 1,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["protocolVersion"]);
      expect(result.error.issues[0]!.message).toContain(
        `accepts ${MIN_PROTOCOL_VERSION} to ${PROTOCOL_VERSION}`,
      );
    }
  });

  it("rejects a protocolVersion below MIN_PROTOCOL_VERSION", () => {
    const result = CreateSessionRequest.safeParse({
      ...valid(),
      protocolVersion: MIN_PROTOCOL_VERSION - 1,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["protocolVersion"]);
    }
  });

  it("rejects a non-integer protocolVersion", () => {
    const result = CreateSessionRequest.safeParse({ ...valid(), protocolVersion: 1.5 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["protocolVersion"]);
    }
  });

  it("rejects a hostname that is too long", () => {
    const request = { ...valid(), host: makeHost({ hostname: "h".repeat(257) }) };

    const result = CreateSessionRequest.safeParse(request);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["host", "hostname"]);
    }
  });
});

describe("CreateSessionResponse", () => {
  const valid = () => ({
    sessionId: "D3FzMqK8qOLVva9LoHF9uc",
    ingestToken: "tok-abc",
    dashboardUrl: "https://afk.test/s/D3FzMqK8qOLVva9LoHF9uc",
    maxDurationSeconds: 3600,
  });

  it("carries the latest client version the server ships", () => {
    const result = CreateSessionResponse.safeParse({ ...valid(), latestClientVersion: "0.3.0" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.latestClientVersion).toBe("0.3.0");
    }
  });

  it("parses without latestClientVersion, as an older server or one without a client script answers", () => {
    const result = CreateSessionResponse.safeParse(valid());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.latestClientVersion).toBeUndefined();
    }
  });
});

describe("VersionResponse", () => {
  const valid = () => ({
    server: { version: "0.1.0", commit: "abc1234", builtAt: "2026-09-15T10:00:00Z" },
    web: { version: "0.1.0", commit: "abc1234" },
    client: { version: "0.3.0" },
    protocolVersion: PROTOCOL_VERSION,
  });

  it("carries the served client's version next to the server and dashboard builds", () => {
    const result = VersionResponse.safeParse(valid());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.client).toEqual({ version: "0.3.0" });
    }
  });

  it("accepts null for client when the server has no client script to serve", () => {
    const result = VersionResponse.safeParse({ ...valid(), client: null });

    expect(result.success).toBe(true);
  });

  it("requires client to be present, naming the field", () => {
    const withoutClient: Partial<ReturnType<typeof valid>> = valid();
    delete withoutClient.client;

    const result = VersionResponse.safeParse(withoutClient);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["client"]);
    }
  });
});

describe("StoredFrame", () => {
  it("round-trips a value built from the builders", () => {
    const [stored] = makeStoredFrames([makeSystemFrame(0)]);

    const result = StoredFrame.safeParse(stored);

    expect(result).toMatchObject({ success: true, data: stored });
  });
});

describe("FramesResponse", () => {
  it("round-trips a value built from the builders", () => {
    const response = {
      session: makeSessionSummary({ startedAt: 0 }),
      frames: makeStoredFrames([makeSystemFrame(0), makeRunFrame(0)]),
      events: [makeEvent()],
    };

    const result = FramesResponse.safeParse(response);

    expect(result).toMatchObject({ success: true, data: response });
  });
});

describe("AnomalyEvent", () => {
  it("requires endedAt to be present", () => {
    const event: Record<string, unknown> = { ...makeEvent() };
    delete event.endedAt;

    const result = AnomalyEvent.safeParse(event);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["endedAt"]);
    }
  });

  it("accepts endedAt as null", () => {
    const result = AnomalyEvent.safeParse(makeEvent({ endedAt: null }));

    expect(result.success).toBe(true);
  });

  it("accepts an event without details", () => {
    const event: Record<string, unknown> = { ...makeEvent() };
    delete event.details;

    const result = AnomalyEvent.safeParse(event);

    expect(result.success).toBe(true);
  });

  it("accepts details naming up to three top processes", () => {
    const topProcesses = makeProcessesData().top.map(({ pid, cpuPercent, command }) => ({
      pid,
      cpuPercent,
      command,
    }));

    const result = AnomalyEvent.safeParse(makeEvent({ details: { topProcesses } }));

    expect(result).toMatchObject({ success: true, data: { details: { topProcesses } } });
  });

  it("rejects details naming more than three top processes", () => {
    const one = { pid: 1, cpuPercent: 1, command: "/bin/sh" };
    const topProcesses = Array.from({ length: EVENT_TOP_PROCESSES_MAX + 1 }, () => one);

    const result = AnomalyEvent.safeParse(makeEvent({ details: { topProcesses } }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["details", "topProcesses"]);
    }
  });

  it("accepts details carrying a failed command's output tail", () => {
    const outputTail = makeRunTail();

    const result = AnomalyEvent.safeParse(makeEvent({ details: { outputTail } }));

    expect(result).toMatchObject({ success: true, data: { details: { outputTail } } });
  });

  it("rejects an output tail with more than the maximum lines", () => {
    const stdout = Array.from({ length: RUN_TAIL_MAX_LINES + 1 }, () => "line");

    const result = AnomalyEvent.safeParse(
      makeEvent({ details: { outputTail: makeRunTail({ stdout }) } }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["details", "outputTail", "stdout"]);
    }
  });
});

describe("agentToolsPresent", () => {
  it("lists the tools with a block, Claude Code before Codex", () => {
    const data = makeAgentsData({ codex: { sessions: 1, working: 1, idle: 0 }, claude: {} });

    expect(agentToolsPresent(data).map(([tool]) => tool)).toEqual(["claude", "codex"]);
  });

  it("leaves out a tool without a block", () => {
    const data = makeAgentsData({ claude: null, codex: {} });

    expect(agentToolsPresent(data).map(([tool]) => tool)).toEqual(["codex"]);
  });

  it("lists nothing when available is false, even with an old client's zero claude block", () => {
    const data = makeAgentsData({ available: false, claude: makeAgentCounts({ sessions: 0 }) });

    expect(agentToolsPresent(data)).toEqual([]);
  });
});

describe("agentTotals", () => {
  it("adds every count across the tools found", () => {
    const data = makeAgentsData({
      claude: { sessions: 3, working: 1, waitingOnInput: 1, idle: 1, subagentsWorking: 2 },
      codex: { sessions: 1, working: 1, waitingOnInput: 0, idle: 0, subagentsWorking: 0 },
    });

    expect(agentTotals(data)).toEqual({
      sessions: 4,
      working: 2,
      waitingOnInput: 1,
      idle: 1,
      subagentsWorking: 2,
    });
  });

  it("is all zeros for a machine with neither tool", () => {
    expect(agentTotals(makeAgentsData({ claude: null }))).toEqual({
      sessions: 0,
      working: 0,
      waitingOnInput: 0,
      idle: 0,
      subagentsWorking: 0,
    });
  });
});

describe("AGENT_TOOL_LABELS", () => {
  it("names every tool in AGENT_TOOLS", () => {
    for (const tool of AGENT_TOOLS) {
      expect(AGENT_TOOL_LABELS[tool]).toMatch(/^[A-Z]/);
    }
  });
});

describe("MemoryPressureLevel", () => {
  it("has the raw sysctl values 1, 2, and 4", () => {
    expect(MemoryPressureLevel.Normal).toBe(1);
    expect(MemoryPressureLevel.Warn).toBe(2);
    expect(MemoryPressureLevel.Critical).toBe(4);
  });
});

describe("version constants", () => {
  it("accept a range whose floor is at most the current protocol version", () => {
    expect(Number.isInteger(MIN_PROTOCOL_VERSION)).toBe(true);
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(MIN_PROTOCOL_VERSION).toBeLessThanOrEqual(PROTOCOL_VERSION);
  });

  it("express the minimum client version as plain major.minor.patch semver", () => {
    expect(MIN_CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("UpgradeRequiredDetails", () => {
  it("accepts a null yourVersion for a client that sent no header", () => {
    const result = UpgradeRequiredDetails.safeParse({
      minimumClientVersion: MIN_CLIENT_VERSION,
      minimumProtocolVersion: MIN_PROTOCOL_VERSION,
      yourVersion: null,
    });

    expect(result.success).toBe(true);
  });

  it("requires yourVersion to be present", () => {
    const result = UpgradeRequiredDetails.safeParse({
      minimumClientVersion: MIN_CLIENT_VERSION,
      minimumProtocolVersion: MIN_PROTOCOL_VERSION,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["yourVersion"]);
    }
  });
});

describe("StreamEventName", () => {
  it("has exactly the four names documented in docs/PROTOCOL.md", () => {
    expect(Object.values(StreamEventName).sort()).toEqual(
      ["session", "event", "frame", "end"].sort(),
    );
  });
});

describe("StreamEndEvent", () => {
  it("is the session summary plus the reason the stream closed", () => {
    const result = StreamEndEvent.safeParse({ ...makeSessionSummary(), reason: "deleted" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe("deleted");
    }
  });

  it("rejects a reason outside ended and deleted, naming the field", () => {
    const result = StreamEndEvent.safeParse({ ...makeSessionSummary(), reason: "swept" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["reason"]);
    }
  });

  it("still parses as a plain SessionSummary, so an older dashboard ignores the reason", () => {
    const result = SessionSummary.safeParse({ ...makeSessionSummary(), reason: "deleted" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("reason");
    }
  });
});

describe("DeleteSessionResponse", () => {
  it("names the deleted session and how many frames went with it", () => {
    const result = DeleteSessionResponse.safeParse({
      sessionId: "D3FzMqK8qOLVva9LoHF9uc",
      frames: 12,
    });

    expect(result).toMatchObject({
      success: true,
      data: { sessionId: "D3FzMqK8qOLVva9LoHF9uc", frames: 12 },
    });
  });

  it("rejects a negative frame count, naming the field", () => {
    const result = DeleteSessionResponse.safeParse({ sessionId: "x", frames: -1 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.path).toEqual(["frames"]);
    }
  });
});

describe("DeletedSessionDetails", () => {
  it("accepts only the deleted reason", () => {
    expect(DeletedSessionDetails.safeParse({ reason: "deleted" }).success).toBe(true);
    expect(DeletedSessionDetails.safeParse({ reason: "unknown" }).success).toBe(false);
  });
});

describe("DEMO_SESSION_ID", () => {
  it("is the id the dashboard serves from its fixture, never one the server would issue", () => {
    expect(DEMO_SESSION_ID).toBe("demo");
    expect(DEMO_SESSION_ID).not.toMatch(/^[A-Za-z0-9]{22}$/);
  });
});
