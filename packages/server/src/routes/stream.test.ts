import { describe, expect, it, vi } from "vitest";
import { ServiceStats } from "@afk/shared";
import { makeRunFrame, makeSystemFrame } from "@afk/shared/testing";
import type { AdmissionLimits, AppConfig } from "../env.ts";
import { DEFAULT_LIMITS } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import {
  chainTestSession,
  createTestSession,
  deleteTestSession,
  endTestSession as endSession,
  makeAppConfig,
  postFrames,
} from "./test-helpers.ts";

/** How long a live stream test waits for the next message before giving up. */
const STREAM_READ_TIMEOUT_MS = 2_000;

type App = ReturnType<typeof createApp>;

/**
 * Reads an open SSE response message by message. `next` resolves with the next parsed
 * message, or undefined once the server has closed the stream.
 */
function openStream(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const queued: ParsedSSE[] = [];
  let closed = false;

  async function next(): Promise<ParsedSSE | undefined> {
    while (queued.length === 0 && !closed) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("no SSE message arrived in time")),
          STREAM_READ_TIMEOUT_MS,
        ),
      );
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) {
        closed = true;
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const messages = buffered.split("\n\n");
      buffered = messages.pop() ?? "";
      queued.push(...parseSSE(messages.join("\n\n") + "\n\n"));
    }
    return queued.shift();
  }

  return { next };
}

/** Builds a fresh app and creates one active session in it. */
async function startSession(
  limits: AdmissionLimits = DEFAULT_LIMITS,
  config: Partial<AppConfig> = {},
) {
  const app = createApp(
    makeAppConfig({ limits, ...config }),
    new SessionStore(new MemorySessionStorage(), { limits }),
  );
  const { sessionId, ingestToken } = await createTestSession(app);
  return { app, sessionId, ingestToken };
}

/** One parsed `event: ... \n data: ... \n id: ...` SSE message. */
interface ParsedSSE {
  event: string;
  id?: string;
  data: unknown;
}

/** Parses an SSE body into its messages; a message with an empty data line (a ping) has null data. */
function parseSSE(text: string): ParsedSSE[] {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("event: "))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))!.slice("event: ".length);
      const id = lines.find((l) => l.startsWith("id: "))?.slice("id: ".length);
      // A ping's data line is `data: ` and the chunk is trimmed, so the space is optional.
      const dataLine = lines.find((l) => l.startsWith("data:"))!.replace(/^data: ?/, "");
      return { event, id, data: dataLine === "" ? null : JSON.parse(dataLine) };
    });
}

describe("GET /api/sessions/:id/frames", () => {
  it("returns the session summary, stored frames, and events", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    await postFrames(app, sessionId, ingestToken, [makeSystemFrame(0)]);

    const res = await app.request(`/api/sessions/${sessionId}/frames`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toMatchObject({ sessionId, streamCount: 1 });
    expect(body.frames).toHaveLength(1);
    expect(body.events).toEqual([]);
  });

  it("honours ?after= to return only frames with a later index", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    await postFrames(app, sessionId, ingestToken, [
      makeSystemFrame(0),
      makeSystemFrame(1),
      makeSystemFrame(2),
    ]);

    const res = await app.request(`/api/sessions/${sessionId}/frames?after=1`);

    const body = await res.json();
    expect(body.frames.map((f: { index: number }) => f.index)).toEqual([2, 3]);
  });

  it("returns 404 for an unknown session id", async () => {
    const { app } = await startSession();

    const res = await app.request("/api/sessions/does-not-exist/frames");

    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions/:id/stream", () => {
  // The live-follow path (frames arriving on an open connection) is covered by the
  // contract test and the manual smoke test in CLAUDE.md; `openStream` below reads an
  // open connection only far enough to see the session deleted under it.

  it("replays session, event, frame, and end messages in order for an ended session", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    await postFrames(app, sessionId, ingestToken, [
      makeRunFrame(0),
      makeRunFrame(1, { state: "exited", exitCode: 3, elapsedSeconds: 1 }),
    ]);
    await endSession(app, sessionId, ingestToken);

    const res = await app.request(`/api/sessions/${sessionId}/stream`);

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const messages = parseSSE(await res.text());
    expect(messages.map((m) => m.event)).toEqual(["session", "event", "frame", "frame", "end"]);
    expect(messages[0]!.data).toMatchObject({ sessionId, status: "ended" });
    expect(messages[1]!.data).toMatchObject({ kind: "run.exited", severity: "critical" });
    expect(messages[2]!.id).toBe("1");
    expect(messages[3]!.id).toBe("2");
    expect(messages[4]!.data).toMatchObject({ sessionId, status: "ended", reason: "ended" });
  });

  it("replays only frames with index greater than Last-Event-ID, which overrides ?after=", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    await postFrames(app, sessionId, ingestToken, [
      makeSystemFrame(0),
      makeSystemFrame(1),
      makeSystemFrame(2),
    ]);
    await endSession(app, sessionId, ingestToken);

    const res = await app.request(`/api/sessions/${sessionId}/stream?after=0`, {
      headers: { "last-event-id": "2" },
    });

    const messages = parseSSE(await res.text());
    const frameIds = messages.filter((m) => m.event === "frame").map((m) => m.id);
    expect(frameIds).toEqual(["3"]);
  });

  it("ends the stream of a chained session with a summary naming its successor", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    await postFrames(app, sessionId, ingestToken, [makeSystemFrame(0)]);
    const next = await chainTestSession(app, sessionId, ingestToken);

    const res = await app.request(`/api/sessions/${sessionId}/stream`);

    const messages = parseSSE(await res.text());
    expect(messages.at(-1)).toMatchObject({
      event: "end",
      data: { sessionId, status: "ended", nextSessionId: next.sessionId, reason: "ended" },
    });
  });

  it("sends end with reason deleted to an open stream when the session is deleted, then closes it", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    await postFrames(app, sessionId, ingestToken, [makeSystemFrame(0)]);
    const res = await app.request(`/api/sessions/${sessionId}/stream`);
    const stream = openStream(res);
    expect(await stream.next()).toMatchObject({ event: "session", data: { status: "active" } });
    expect(await stream.next()).toMatchObject({ event: "frame", id: "1" });

    const deleted = await deleteTestSession(app, sessionId);

    expect(deleted.status).toBe(200);
    expect(await stream.next()).toMatchObject({
      event: "end",
      data: { sessionId, status: "ended", reason: "deleted" },
    });
    expect(await stream.next()).toBeUndefined();
  });

  // Not a comment line: EventSource never delivers those to JavaScript, and the
  // dashboard's freshness watchdog needs to hear something on a quiet stream.
  it("sends a ping event every keepalive interval on an open stream with nothing else to say", async () => {
    const { app, sessionId } = await startSession(DEFAULT_LIMITS, { sseKeepaliveMs: 20 });
    const res = await app.request(`/api/sessions/${sessionId}/stream`);
    const stream = openStream(res);
    expect(await stream.next()).toMatchObject({ event: "session" });

    const first = await stream.next();
    const second = await stream.next();

    expect(first).toEqual({ event: "ping", id: undefined, data: null });
    expect(second).toEqual({ event: "ping", id: undefined, data: null });
    await deleteTestSession(app, sessionId);
  });

  it("returns 404 for an unknown session id", async () => {
    const { app } = await startSession();

    const res = await app.request("/api/sessions/does-not-exist/stream");

    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions/:id/stream connection caps", () => {
  /** The `sseConnections` count the stats endpoint reports right now. */
  async function openConnections(app: App): Promise<number> {
    return ServiceStats.parse(await (await app.request("/api/stats")).json()).sseConnections;
  }

  it("answers 503 with Retry-After for the connection past maxSseConnectionsPerSession, and admits again once one closes", async () => {
    const { app, sessionId } = await startSession({
      ...DEFAULT_LIMITS,
      maxSseConnectionsPerSession: 2,
    });
    const first = await app.request(`/api/sessions/${sessionId}/stream`);
    const second = await app.request(`/api/sessions/${sessionId}/stream`);
    expect([first.status, second.status]).toEqual([200, 200]);

    const third = await app.request(`/api/sessions/${sessionId}/stream`);

    expect(third.status).toBe(503);
    expect(third.headers.get("Retry-After")).toBe("10");
    expect(await third.json()).toEqual({
      error: "this session already has 2 open streams; try again later",
    });
    expect(await openConnections(app)).toBe(2);

    await first.body!.cancel();
    await vi.waitFor(async () => expect(await openConnections(app)).toBe(1));
    const afterClosing = await app.request(`/api/sessions/${sessionId}/stream`);

    expect(afterClosing.status).toBe(200);
    await Promise.all([second.body!.cancel(), afterClosing.body!.cancel()]);
  });

  it("answers 503 across sessions once maxSseConnections is reached for the whole server", async () => {
    const { app, sessionId: first } = await startSession({
      ...DEFAULT_LIMITS,
      maxSseConnections: 1,
    });
    const { sessionId: second } = await createTestSession(app);
    const open = await app.request(`/api/sessions/${first}/stream`);
    expect(open.status).toBe(200);

    const refused = await app.request(`/api/sessions/${second}/stream`);

    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: "the server already has 1 open streams; try again later",
    });
    await open.body!.cancel();
  });

  it("releases the connection when the stream ends on its own after replaying an ended session", async () => {
    const { app, sessionId, ingestToken } = await startSession({
      ...DEFAULT_LIMITS,
      maxSseConnectionsPerSession: 1,
    });
    await endSession(app, sessionId, ingestToken);

    const replayed = await app.request(`/api/sessions/${sessionId}/stream`);
    await replayed.text();

    await vi.waitFor(async () => expect(await openConnections(app)).toBe(0));
    expect((await app.request(`/api/sessions/${sessionId}/stream`)).status).toBe(200);
  });
});

describe("compression", () => {
  it("gzips the frames document when the client accepts it, and never the event stream", async () => {
    const { app, sessionId, ingestToken } = await startSession(DEFAULT_LIMITS);
    await postFrames(app, sessionId, ingestToken, [makeSystemFrame(0), makeSystemFrame(1)]);

    const frames = await app.request(`/api/sessions/${sessionId}/frames`, {
      headers: { "accept-encoding": "gzip" },
    });
    const stream = await app.request(`/api/sessions/${sessionId}/stream`, {
      headers: { "accept-encoding": "gzip" },
    });

    expect(frames.headers.get("content-encoding")).toBe("gzip");
    const decompressed = frames.body!.pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(decompressed).text();
    expect(JSON.parse(text).frames).toHaveLength(2);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("content-encoding")).toBeNull();
  });
});
