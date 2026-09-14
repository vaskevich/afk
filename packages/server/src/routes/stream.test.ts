import { describe, expect, it } from "vitest";
import { makeRunFrame, makeSystemFrame } from "@afk/shared/testing";
import type { AdmissionLimits } from "../env.ts";
import { DEFAULT_LIMITS } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import {
  createTestSession,
  endTestSession as endSession,
  makeAppConfig,
  postFrames,
} from "./test-helpers.ts";

/** Builds a fresh app and creates one active session in it. */
async function startSession(limits: AdmissionLimits = DEFAULT_LIMITS) {
  const app = createApp(
    makeAppConfig({ limits }),
    new SessionStore(new MemorySessionStorage(), limits),
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

/** Parses an SSE body into its messages, dropping bare keepalive comments. */
function parseSSE(text: string): ParsedSSE[] {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("event: "))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))!.slice("event: ".length);
      const id = lines.find((l) => l.startsWith("id: "))?.slice("id: ".length);
      const dataLine = lines.find((l) => l.startsWith("data: "))!.slice("data: ".length);
      return { event, id, data: JSON.parse(dataLine) };
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
  // The live-follow path (subscribing to an active session and reading frames as they
  // arrive) is not exercised here since it needs an open connection; it is covered by
  // the manual smoke test described in CLAUDE.md.

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
    expect(messages[4]!.data).toMatchObject({ sessionId, status: "ended" });
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

  it("returns 404 for an unknown session id", async () => {
    const { app } = await startSession();

    const res = await app.request("/api/sessions/does-not-exist/stream");

    expect(res.status).toBe(404);
  });
});
