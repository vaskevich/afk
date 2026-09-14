import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import type { AdmissionLimits } from "../env.ts";
import { DEFAULT_LIMITS } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { createTestSession, postFrames } from "./test-helpers.ts";
import { makeSystemFrame } from "@afk/shared/testing";

/** No dashboard build exists at this path; these tests only exercise the API routes. */
const NO_DIST_DIR = "/nonexistent/afk-test-dist";

function buildApp(limits: AdmissionLimits = DEFAULT_LIMITS) {
  return createApp(
    { publicBaseUrl: "https://afk.test", webDistDir: NO_DIST_DIR, limits },
    new SessionStore(new MemorySessionStorage(), limits),
  );
}

describe("POST /api/sessions", () => {
  it("creates a session with an id, a distinct ingest token, a dashboard URL, and the max duration", async () => {
    const app = buildApp();

    const { res, sessionId, ingestToken } = await createTestSession(app);

    expect(res.status).toBe(201);
    expect(ingestToken).not.toBe(sessionId);
    expect(ingestToken).not.toBe("");
    expect(await res.json()).toEqual({
      sessionId,
      ingestToken,
      dashboardUrl: `https://afk.test/s/${sessionId}`,
      maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
    });
  });

  it("rejects a request with a wrong protocolVersion, naming the field in the error", async () => {
    const app = buildApp();

    const { res } = await createTestSession(app, { protocolVersion: 99 });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid session request");
    expect(body.details.fieldErrors.protocolVersion).toBeDefined();
  });

  it("returns 503 with Retry-After once maxActiveSessions sessions are active, then 201 again after one ends", async () => {
    const app = buildApp({ maxActiveSessions: 1, maxStreamsPerSession: 10 });
    const first = await createTestSession(app);
    expect(first.res.status).toBe(201);

    const overCapacity = await createTestSession(app);

    expect(overCapacity.res.status).toBe(503);
    expect(overCapacity.res.headers.get("Retry-After")).toBe("60");

    await app.request(`/api/sessions/${first.sessionId}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${first.ingestToken}` },
    });
    const afterEnding = await createTestSession(app);

    expect(afterEnding.res.status).toBe(201);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns the session summary with zero streams and the configured max", async () => {
    const app = buildApp({ maxActiveSessions: 20, maxStreamsPerSession: 5 });
    const { sessionId } = await createTestSession(app);

    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sessionId,
      status: "active",
      streamCount: 0,
      maxStreams: 5,
    });
  });

  it("returns 404 for an unknown session id", async () => {
    const app = buildApp();

    const res = await app.request("/api/sessions/does-not-exist");

    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/end", () => {
  it("returns 401 with a wrong bearer token", async () => {
    const app = buildApp();
    const { sessionId } = await createTestSession(app);

    const res = await app.request(`/api/sessions/${sessionId}/end`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown session id", async () => {
    const app = buildApp();

    const res = await app.request("/api/sessions/does-not-exist/end", {
      method: "POST",
      headers: { authorization: "Bearer whatever" },
    });

    expect(res.status).toBe(404);
  });

  it("ends the session and returns its summary with status ended", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);

    const res = await app.request(`/api/sessions/${sessionId}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestToken}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sessionId, status: "ended" });
  });

  it("returns 410 on a second end", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);
    await app.request(`/api/sessions/${sessionId}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestToken}` },
    });

    const res = await app.request(`/api/sessions/${sessionId}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestToken}` },
    });

    expect(res.status).toBe(410);
  });

  it("returns 410 for a frame post after the session has ended", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);
    await app.request(`/api/sessions/${sessionId}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestToken}` },
    });

    const res = await postFrames(app, sessionId, ingestToken, [makeSystemFrame(0)]);

    expect(res.status).toBe(410);
  });
});
