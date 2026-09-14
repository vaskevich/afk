import { describe, expect, it } from "vitest";
import { makeRunFrame, makeSystemFrame } from "@afk/shared/testing";
import type { AdmissionLimits } from "../env.ts";
import { DEFAULT_LIMITS, DEFAULT_SSE_KEEPALIVE_MS } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { createTestSession, postFrames } from "./test-helpers.ts";

/** No dashboard build exists at this path; these tests only exercise the API routes. */
const NO_DIST_DIR = "/nonexistent/afk-test-dist";

/** Builds a fresh app and creates one active session in it. */
async function startSession(limits: AdmissionLimits = DEFAULT_LIMITS) {
  const app = createApp(
    {
      publicBaseUrl: "https://afk.test",
      webDistDir: NO_DIST_DIR,
      limits,
      sseKeepaliveMs: DEFAULT_SSE_KEEPALIVE_MS,
    },
    new SessionStore(new MemorySessionStorage(), { limits }),
  );
  const { sessionId, ingestToken } = await createTestSession(app);
  return { app, sessionId, ingestToken };
}

describe("POST /api/sessions/:id/frames", () => {
  it("accepts a batch of NDJSON frames and reports accepted, duplicates, and latest sequence", async () => {
    const { app, sessionId, ingestToken } = await startSession();

    const res = await postFrames(app, sessionId, ingestToken, [
      makeSystemFrame(0),
      makeSystemFrame(1),
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2, duplicates: 0, latestSequence: { system: 2 } });
  });

  it("counts a resent batch entirely as duplicates and accepts nothing", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    const frames = [makeSystemFrame(0), makeSystemFrame(1)];
    await postFrames(app, sessionId, ingestToken, frames);

    const res = await postFrames(app, sessionId, ingestToken, frames);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 0, duplicates: 2, latestSequence: { system: 2 } });
  });

  it("ignores a blank line in the NDJSON body", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    const body = [JSON.stringify(makeSystemFrame(0)), "", JSON.stringify(makeSystemFrame(1))].join(
      "\n",
    );

    const res = await app.request(`/api/sessions/${sessionId}/frames`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${ingestToken}` },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2, duplicates: 0, latestSequence: { system: 2 } });
  });

  it("returns 400 naming line 2 when it is not valid JSON", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    const body = [JSON.stringify(makeSystemFrame(0)), "not json"].join("\n");

    const res = await app.request(`/api/sessions/${sessionId}/frames`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${ingestToken}` },
      body,
    });

    expect(res.status).toBe(400);
    const responseBody = await res.json();
    expect(responseBody.error).toContain("line 2");
  });

  it("returns 400 with details for a frame that fails schema validation", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    const invalidFrame = { ...makeSystemFrame(0), sequence: -1 };

    const res = await app.request(`/api/sessions/${sessionId}/frames`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${ingestToken}` },
      body: JSON.stringify(invalidFrame),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("line 1");
    expect(body.details.fieldErrors.sequence).toBeDefined();
  });

  it("returns 422 naming the stream when a batch would add a stream beyond maxStreamsPerSession", async () => {
    const { app, sessionId, ingestToken } = await startSession({
      maxActiveSessions: 20,
      maxStreamsPerSession: 1,
    });
    await postFrames(app, sessionId, ingestToken, [makeSystemFrame(0)]);

    const res = await postFrames(app, sessionId, ingestToken, [makeRunFrame(0)]);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.details).toMatchObject({ stream: "run:abcd1234", limit: 1 });
  });

  it("returns 410 when posting to a session that has ended", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    await app.request(`/api/sessions/${sessionId}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestToken}` },
    });

    const res = await postFrames(app, sessionId, ingestToken, [makeSystemFrame(0)]);

    expect(res.status).toBe(410);
  });
});
