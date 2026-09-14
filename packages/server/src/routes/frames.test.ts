import { describe, expect, it } from "vitest";
import { makeRunFrame, makeSystemFrame } from "@afk/shared/testing";
import type { AdmissionLimits } from "../env.ts";
import { DEFAULT_LIMITS } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { MAX_INGEST_BODY_BYTES } from "./frames.ts";
import {
  createTestSession,
  endTestSession,
  makeAppConfig,
  postFrameBody,
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

/** An NDJSON body of valid system frames whose size is `targetBytes` or just under it. */
function frameBodyOfSize(targetBytes: number): { body: string; frameCount: number } {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; ; i += 1) {
    const line = JSON.stringify(makeSystemFrame(i));
    if (size + line.length + 1 > targetBytes) {
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return { body: lines.join("\n"), frameCount: lines.length };
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

    const res = await postFrameBody(app, sessionId, ingestToken, body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2, duplicates: 0, latestSequence: { system: 2 } });
  });

  it("returns 400 naming line 2 when it is not valid JSON", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    const body = [JSON.stringify(makeSystemFrame(0)), "not json"].join("\n");

    const res = await postFrameBody(app, sessionId, ingestToken, body);

    expect(res.status).toBe(400);
    const responseBody = await res.json();
    expect(responseBody.error).toContain("line 2");
  });

  it("returns 400 with details for a frame that fails schema validation", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    const invalidFrame = { ...makeSystemFrame(0), sequence: -1 };

    const res = await postFrameBody(app, sessionId, ingestToken, JSON.stringify(invalidFrame));

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
    await endTestSession(app, sessionId, ingestToken);

    const res = await postFrames(app, sessionId, ingestToken, [makeSystemFrame(0)]);

    expect(res.status).toBe(410);
  });

  it("returns 426 with the upgrade details when X-Afk-Client is missing", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    const body = JSON.stringify(makeSystemFrame(0));

    const res = await postFrameBody(app, sessionId, ingestToken, body, {});

    expect(res.status).toBe(426);
    expect((await res.json()).details).toEqual({
      minimumClientVersion: expect.any(String),
      minimumProtocolVersion: expect.any(Number),
      yourVersion: null,
    });
  });

  it("accepts a body just under MAX_INGEST_BODY_BYTES", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    const { body, frameCount } = frameBodyOfSize(MAX_INGEST_BODY_BYTES);
    expect(body.length).toBeLessThanOrEqual(MAX_INGEST_BODY_BYTES);

    const res = await postFrameBody(app, sessionId, ingestToken, body);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: frameCount, duplicates: 0 });
  });

  it("returns 413 with an error body for a body just over MAX_INGEST_BODY_BYTES", async () => {
    const { app, sessionId, ingestToken } = await startSession();
    const { body } = frameBodyOfSize(MAX_INGEST_BODY_BYTES);
    const oversized = body + "\n".repeat(MAX_INGEST_BODY_BYTES + 1 - body.length);
    expect(oversized.length).toBe(MAX_INGEST_BODY_BYTES + 1);

    const res = await postFrameBody(app, sessionId, ingestToken, oversized);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: expect.stringContaining("exceeds"),
      details: { limit: MAX_INGEST_BODY_BYTES },
    });
  });

  it("returns 413 when Content-Length alone says the body is too large", async () => {
    const { app, sessionId, ingestToken } = await startSession();

    const res = await app.request(`/api/sessions/${sessionId}/frames`, {
      method: "POST",
      headers: {
        "content-type": "application/x-ndjson",
        authorization: `Bearer ${ingestToken}`,
        "x-afk-client": "bash/0.1.0",
        "content-length": String(MAX_INGEST_BODY_BYTES + 1),
      },
      body: JSON.stringify(makeSystemFrame(0)),
    });

    expect(res.status).toBe(413);
  });
});
