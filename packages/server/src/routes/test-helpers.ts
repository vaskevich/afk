/**
 * Shared helpers for route tests. Every test builds its own app with `createApp` and a
 * fresh in-memory store (see docs/TESTING.md), then uses these to avoid repeating the
 * session-creation and frame-posting boilerplate.
 */
import { makeHost } from "@afk/shared/testing";
import type { Frame, HostInfo, ServerBuildInfo } from "@afk/shared";
import type { createApp } from "../app.ts";
import type { AppConfig } from "../env.ts";
import { DEFAULT_LIMITS, DEFAULT_MINIMUM_VERSIONS, DEFAULT_SSE_KEEPALIVE_MS } from "../env.ts";

type App = ReturnType<typeof createApp>;

/** No dashboard build exists at this path; API route tests never serve the dashboard. */
export const NO_DIST_DIR = "/nonexistent/afk-test-dist";
/** No client script exists at this path; only the install route tests serve one. */
export const NO_CLIENT_SCRIPT = "/nonexistent/afk-test-cli/afk";

/** What every request from a real client carries; the server answers 426 without it. */
export const CLIENT_VERSION_HEADER = { "x-afk-client": "bash/0.1.0" };

/** A fixed server build identity, so version assertions never depend on the real package.json. */
export const TEST_BUILD: ServerBuildInfo = {
  version: "0.0.0-test",
  commit: "abc1234",
  builtAt: "2026-09-15T00:00:00.000Z",
};

/** An AppConfig with boring defaults; override only what the test is about. */
export function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    publicBaseUrl: "https://afk.test",
    webDistDir: NO_DIST_DIR,
    clientScriptPath: NO_CLIENT_SCRIPT,
    limits: DEFAULT_LIMITS,
    minimumVersions: DEFAULT_MINIMUM_VERSIONS,
    sseKeepaliveMs: DEFAULT_SSE_KEEPALIVE_MS,
    build: TEST_BUILD,
    webBuild: null,
    latestClientVersion: null,
    ...overrides,
  };
}

/** Creates a session through the API with boring defaults; returns its id, token, and the raw response. */
export async function createTestSession(
  app: App,
  overrides: Partial<{
    protocolVersion: number;
    clientVersion: string;
    host: HostInfo;
    previousSessionId: string;
  }> = {},
  headers: Record<string, string> = CLIENT_VERSION_HEADER,
): Promise<{ res: Response; sessionId: string; ingestToken: string }> {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      protocolVersion: 1,
      clientVersion: "0.1.0",
      host: makeHost(),
      ...overrides,
    }),
  });
  const body = (await res.clone().json()) as { sessionId?: string; ingestToken?: string };
  return { res, sessionId: body.sessionId ?? "", ingestToken: body.ingestToken ?? "" };
}

/**
 * Creates a session that continues `previousSessionId`, the way the client chains past
 * the cap: `previousSessionId` in the body and the previous session's ingest token as
 * the bearer.
 */
export async function chainTestSession(
  app: App,
  previousSessionId: string,
  previousIngestToken: string,
): Promise<{ res: Response; sessionId: string; ingestToken: string }> {
  return createTestSession(
    app,
    { previousSessionId },
    { ...CLIENT_VERSION_HEADER, authorization: `Bearer ${previousIngestToken}` },
  );
}

/** Posts a raw NDJSON body with the session's bearer token. */
export async function postFrameBody(
  app: App,
  sessionId: string,
  ingestToken: string,
  body: string,
  headers: Record<string, string> = CLIENT_VERSION_HEADER,
): Promise<Response> {
  return app.request(`/api/sessions/${sessionId}/frames`, {
    method: "POST",
    headers: {
      "content-type": "application/x-ndjson",
      authorization: `Bearer ${ingestToken}`,
      ...headers,
    },
    body,
  });
}

/** Posts a batch of frames as an NDJSON body with the session's bearer token. */
export async function postFrames(
  app: App,
  sessionId: string,
  ingestToken: string,
  frames: readonly Frame[],
): Promise<Response> {
  return postFrameBody(
    app,
    sessionId,
    ingestToken,
    frames.map((f) => JSON.stringify(f)).join("\n"),
  );
}

/**
 * Deletes a session through the API. With a token it is the client's call (bearer and
 * `X-Afk-Client`, like end); without one it is the dashboard's, which sends neither.
 */
export async function deleteTestSession(
  app: App,
  sessionId: string,
  ingestToken?: string,
): Promise<Response> {
  const headers: Record<string, string> =
    ingestToken === undefined
      ? {}
      : { authorization: `Bearer ${ingestToken}`, ...CLIENT_VERSION_HEADER };
  return app.request(`/api/sessions/${sessionId}`, { method: "DELETE", headers });
}

/** Ends a session through the API with the session's bearer token. */
export async function endTestSession(
  app: App,
  sessionId: string,
  ingestToken: string,
  headers: Record<string, string> = CLIENT_VERSION_HEADER,
): Promise<Response> {
  return app.request(`/api/sessions/${sessionId}/end`, {
    method: "POST",
    headers: { authorization: `Bearer ${ingestToken}`, ...headers },
  });
}
