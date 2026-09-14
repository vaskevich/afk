import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SESSION_DURATION_SECONDS,
  MIN_CLIENT_VERSION,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "@afk/shared";
import type { AdmissionLimits, MinimumVersions } from "../env.ts";
import { DEFAULT_LIMITS, DEFAULT_MINIMUM_VERSIONS } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { MAX_CREATE_BODY_BYTES } from "./sessions.ts";
import {
  CLIENT_VERSION_HEADER,
  chainTestSession,
  createTestSession,
  endTestSession,
  makeAppConfig,
  postFrames,
} from "./test-helpers.ts";
import { makeHost, makeSystemFrame } from "@afk/shared/testing";

function buildApp(
  limits: AdmissionLimits = DEFAULT_LIMITS,
  minimumVersions: MinimumVersions = DEFAULT_MINIMUM_VERSIONS,
) {
  return createApp(
    makeAppConfig({ limits, minimumVersions }),
    new SessionStore(new MemorySessionStorage(), { limits }),
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

  it("tells the client the version of the client script this server serves", async () => {
    const app = createApp(
      makeAppConfig({ latestClientVersion: "0.3.0" }),
      new SessionStore(new MemorySessionStorage(), { limits: DEFAULT_LIMITS }),
    );

    const { res } = await createTestSession(app);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(expect.objectContaining({ latestClientVersion: "0.3.0" }));
  });

  it("omits latestClientVersion when the server has no client script to serve", async () => {
    const app = buildApp();

    const { res } = await createTestSession(app);

    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty("latestClientVersion");
  });

  it("rejects a request with an invalid host, naming the field in the error", async () => {
    const app = buildApp();

    const { res } = await createTestSession(app, { host: makeHost({ cpuCount: 0 }) });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid session request");
    expect(body.details.fieldErrors.host).toBeDefined();
  });

  it("returns 503 with Retry-After once maxActiveSessions sessions are active, then 201 again after one ends", async () => {
    const app = buildApp({
      maxActiveSessions: 1,
      maxStreamsPerSession: 10,
      maxFramesPerSession: 15_000,
    });
    const first = await createTestSession(app);
    expect(first.res.status).toBe(201);

    const overCapacity = await createTestSession(app);

    expect(overCapacity.res.status).toBe(503);
    expect(overCapacity.res.headers.get("Retry-After")).toBe("60");

    await endTestSession(app, first.sessionId, first.ingestToken);
    const afterEnding = await createTestSession(app);

    expect(afterEnding.res.status).toBe(201);
  });

  it("returns 413 with an error body for a request larger than the create limit", async () => {
    const app = buildApp();
    const oversized = {
      protocolVersion: PROTOCOL_VERSION,
      clientVersion: "0.1.0",
      host: makeHost(),
      padding: "x".repeat(MAX_CREATE_BODY_BYTES),
    };

    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", ...CLIENT_VERSION_HEADER },
      body: JSON.stringify(oversized),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("exceeds") });
  });
});

describe("POST /api/sessions with previousSessionId (chaining)", () => {
  it("creates the successor, ends the previous session, and links the two summaries both ways", async () => {
    const app = buildApp();
    const first = await createTestSession(app);
    await postFrames(app, first.sessionId, first.ingestToken, [makeSystemFrame(0)]);

    const { res, sessionId, ingestToken } = await chainTestSession(
      app,
      first.sessionId,
      first.ingestToken,
    );

    expect(res.status).toBe(201);
    expect(sessionId).not.toBe(first.sessionId);
    expect(ingestToken).not.toBe(first.ingestToken);
    const previous = await (await app.request(`/api/sessions/${first.sessionId}`)).json();
    const next = await (await app.request(`/api/sessions/${sessionId}`)).json();
    expect(previous).toMatchObject({
      status: "ended",
      endedAt: expect.any(Number),
      previousSessionId: null,
      nextSessionId: sessionId,
    });
    expect(next).toMatchObject({
      status: "active",
      previousSessionId: first.sessionId,
      nextSessionId: null,
    });
  });

  it("rejects frames for the previous session with 410 and accepts them for the successor", async () => {
    const app = buildApp();
    const first = await createTestSession(app);
    const next = await chainTestSession(app, first.sessionId, first.ingestToken);

    const old = await postFrames(app, first.sessionId, first.ingestToken, [makeSystemFrame(0)]);
    const fresh = await postFrames(app, next.sessionId, next.ingestToken, [makeSystemFrame(0)]);

    expect(old.status).toBe(410);
    expect(fresh.status).toBe(200);
  });

  it("returns 401 when the bearer is not the previous session's ingest token", async () => {
    const app = buildApp();
    const first = await createTestSession(app);

    const { res } = await chainTestSession(app, first.sessionId, "wrong-token");

    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("previous session");
    expect(await (await app.request(`/api/sessions/${first.sessionId}`)).json()).toMatchObject({
      status: "active",
      nextSessionId: null,
    });
  });

  it("returns 401 when the bearer is missing altogether", async () => {
    const app = buildApp();
    const first = await createTestSession(app);

    const { res } = await createTestSession(app, { previousSessionId: first.sessionId });

    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown previous session", async () => {
    const app = buildApp();

    const { res } = await chainTestSession(app, "does-not-exist", "whatever");

    expect(res.status).toBe(404);
  });

  it("returns 409 naming the successor when the previous session was already continued", async () => {
    const app = buildApp();
    const first = await createTestSession(app);
    const next = await chainTestSession(app, first.sessionId, first.ingestToken);

    const { res } = await chainTestSession(app, first.sessionId, first.ingestToken);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ details: { nextSessionId: next.sessionId } });
  });

  it("is admitted at capacity because it replaces the active session it continues", async () => {
    const app = buildApp({
      maxActiveSessions: 1,
      maxStreamsPerSession: 10,
      maxFramesPerSession: 15_000,
    });
    const first = await createTestSession(app);
    expect((await createTestSession(app)).res.status).toBe(503);

    const { res, sessionId } = await chainTestSession(app, first.sessionId, first.ingestToken);

    expect(res.status).toBe(201);
    expect(await (await app.request(`/api/sessions/${sessionId}`)).json()).toMatchObject({
      status: "active",
      previousSessionId: first.sessionId,
    });
  });

  it("still returns 503 at capacity when the previous session is already over", async () => {
    const app = buildApp({
      maxActiveSessions: 1,
      maxStreamsPerSession: 10,
      maxFramesPerSession: 15_000,
    });
    const first = await createTestSession(app);
    await endTestSession(app, first.sessionId, first.ingestToken);
    const blocker = await createTestSession(app);
    expect(blocker.res.status).toBe(201);

    const { res } = await chainTestSession(app, first.sessionId, first.ingestToken);

    expect(res.status).toBe(503);
  });
});

describe("POST /api/sessions version checks", () => {
  const expectedDetails = {
    minimumClientVersion: MIN_CLIENT_VERSION,
    minimumProtocolVersion: MIN_PROTOCOL_VERSION,
  };

  it("returns 426 with both minimums and a null yourVersion when X-Afk-Client is missing", async () => {
    const app = buildApp();

    const { res } = await createTestSession(app, {}, {});

    expect(res.status).toBe(426);
    const body = await res.json();
    expect(body.error).toContain("X-Afk-Client");
    expect(body.details).toEqual({ ...expectedDetails, yourVersion: null });
  });

  it("returns 426 when X-Afk-Client is not <name>/<semver>", async () => {
    const app = buildApp();

    const { res } = await createTestSession(app, {}, { "x-afk-client": "bash 0.1.0" });

    expect(res.status).toBe(426);
    expect((await res.json()).details).toEqual({ ...expectedDetails, yourVersion: null });
  });

  it("returns 426 naming the client's version when the client version is below the minimum", async () => {
    const app = buildApp(DEFAULT_LIMITS, { clientVersion: "0.2.0", protocolVersion: 1 });

    const { res } = await createTestSession(app, {}, { "x-afk-client": "bash/0.1.9" });

    expect(res.status).toBe(426);
    const body = await res.json();
    expect(body.error).toContain("0.1.9");
    expect(body.details).toEqual({
      minimumClientVersion: "0.2.0",
      minimumProtocolVersion: 1,
      yourVersion: "0.1.9",
    });
  });

  it("compares client versions numerically, so 0.10.0 is not below 0.9.0", async () => {
    const app = buildApp(DEFAULT_LIMITS, { clientVersion: "0.9.0", protocolVersion: 1 });

    const { res } = await createTestSession(app, {}, { "x-afk-client": "bash/0.10.0" });

    expect(res.status).toBe(201);
  });

  it("accepts a client exactly at the minimum version", async () => {
    const app = buildApp(DEFAULT_LIMITS, { clientVersion: "0.1.0", protocolVersion: 1 });

    const { res } = await createTestSession(app, {}, { "x-afk-client": "bash/0.1.0" });

    expect(res.status).toBe(201);
  });

  it("returns 426 rather than 400 for a protocolVersion above what the server speaks", async () => {
    const app = buildApp();

    const { res } = await createTestSession(app, { protocolVersion: PROTOCOL_VERSION + 1 });

    expect(res.status).toBe(426);
    const body = await res.json();
    expect(body.error).toContain(`protocol version ${PROTOCOL_VERSION + 1}`);
    expect(body.details).toEqual({ ...expectedDetails, yourVersion: "0.1.0" });
  });

  it("returns 426 for a protocolVersion below the deployment's raised minimum", async () => {
    const app = buildApp(DEFAULT_LIMITS, { clientVersion: "0.1.0", protocolVersion: 2 });

    const { res } = await createTestSession(app, { protocolVersion: 1 });

    expect(res.status).toBe(426);
    expect((await res.json()).details).toEqual({
      minimumClientVersion: "0.1.0",
      minimumProtocolVersion: 2,
      yourVersion: "0.1.0",
    });
  });

  it("still returns 400 for a protocolVersion that is not a number at all", async () => {
    const app = buildApp();

    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", ...CLIENT_VERSION_HEADER },
      body: JSON.stringify({ protocolVersion: "one", clientVersion: "0.1.0", host: makeHost() }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns the session summary with zero streams and the configured max", async () => {
    const app = buildApp({
      maxActiveSessions: 20,
      maxStreamsPerSession: 5,
      maxFramesPerSession: 15_000,
    });
    const { sessionId } = await createTestSession(app);

    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      sessionId,
      status: "active",
      streamCount: 0,
      maxStreams: 5,
      previousSessionId: null,
      nextSessionId: null,
    });
  });

  it("returns 404 for an unknown session id", async () => {
    const app = buildApp();

    const res = await app.request("/api/sessions/does-not-exist");

    expect(res.status).toBe(404);
  });

  it("is not version-checked: a read without X-Afk-Client succeeds", async () => {
    const app = buildApp(DEFAULT_LIMITS, { clientVersion: "9.0.0", protocolVersion: 1 });
    const { sessionId } = await createTestSession(app, {}, { "x-afk-client": "bash/9.0.0" });

    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
  });
});

describe("GET /api/sessions/:id/qr", () => {
  /** Fetches the QR with the session's bearer token, as `afk start` and `afk qr` do. */
  async function getQr(
    app: ReturnType<typeof buildApp>,
    sessionId: string,
    ingestToken: string,
    query = "",
    headers: Record<string, string> = CLIENT_VERSION_HEADER,
  ): Promise<Response> {
    return app.request(`/api/sessions/${sessionId}/qr${query}`, {
      headers: { authorization: `Bearer ${ingestToken}`, ...headers },
    });
  }

  it("returns the dashboard URL as a half-block text QR followed by the URL line", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);

    const res = await getQr(app, sessionId, ingestToken);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const lines = (await res.text()).split("\n");
    expect(lines.at(-2)).toBe(`https://afk.test/s/${sessionId}`);
    expect(lines[0]).toMatch(/^[█▀▄ ]+$/);
  });

  it("returns an svg document with ?format=svg", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);

    const res = await getQr(app, sessionId, ingestToken, "?format=svg");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect((await res.text()).startsWith("<svg")).toBe(true);
  });

  it("returns 400 for a format it does not know", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);

    const res = await getQr(app, sessionId, ingestToken, "?format=png");

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("png");
  });

  it("returns 401 with a wrong bearer token, since the URL is the share link", async () => {
    const app = buildApp();
    const { sessionId } = await createTestSession(app);

    const res = await getQr(app, sessionId, "wrong-token");

    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown session id", async () => {
    const app = buildApp();

    const res = await getQr(app, "does-not-exist", "whatever");

    expect(res.status).toBe(404);
  });

  it("returns 426 without X-Afk-Client, like the other client endpoints", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);

    const res = await getQr(app, sessionId, ingestToken, "", {});

    expect(res.status).toBe(426);
  });

  it("returns 410 once the session has ended", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);
    await endTestSession(app, sessionId, ingestToken);

    const res = await getQr(app, sessionId, ingestToken);

    expect(res.status).toBe(410);
  });
});

describe("POST /api/sessions/:id/end", () => {
  it("returns 401 with a wrong bearer token", async () => {
    const app = buildApp();
    const { sessionId } = await createTestSession(app);

    const res = await endTestSession(app, sessionId, "wrong-token");

    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown session id", async () => {
    const app = buildApp();

    const res = await endTestSession(app, "does-not-exist", "whatever");

    expect(res.status).toBe(404);
  });

  it("returns 426 without X-Afk-Client, before looking the session up", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);

    const res = await endTestSession(app, sessionId, ingestToken, {});

    expect(res.status).toBe(426);
    expect((await res.json()).details).toMatchObject({ yourVersion: null });
  });

  it("ends the session and returns its summary with status ended", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);

    const res = await endTestSession(app, sessionId, ingestToken);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sessionId, status: "ended" });
  });

  it("returns 410 on a second end", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);
    await endTestSession(app, sessionId, ingestToken);

    const res = await endTestSession(app, sessionId, ingestToken);

    expect(res.status).toBe(410);
  });

  it("returns 410 for a frame post after the session has ended", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);
    await endTestSession(app, sessionId, ingestToken);

    const res = await postFrames(app, sessionId, ingestToken, [makeSystemFrame(0)]);

    expect(res.status).toBe(410);
  });
});
