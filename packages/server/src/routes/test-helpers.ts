/**
 * Shared helpers for route tests. Every test builds its own app with `createApp` and a
 * fresh in-memory store (see docs/TESTING.md), then uses these to avoid repeating the
 * session-creation and frame-posting boilerplate.
 */
import { makeHost } from "@afk/shared/testing";
import type { Frame, HostInfo } from "@afk/shared";
import type { createApp } from "../app.ts";
import type { AppConfig } from "../env.ts";
import { DEFAULT_LIMITS, DEFAULT_MINIMUM_VERSIONS, DEFAULT_SSE_KEEPALIVE_MS } from "../env.ts";

type App = ReturnType<typeof createApp>;

/** No dashboard build exists at this path; API route tests never serve the dashboard. */
export const NO_DIST_DIR = "/nonexistent/afk-test-dist";

/** What every request from a real client carries; the server answers 426 without it. */
export const CLIENT_VERSION_HEADER = { "x-afk-client": "bash/0.1.0" };

/** An AppConfig with boring defaults; override only what the test is about. */
export function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    publicBaseUrl: "https://afk.test",
    webDistDir: NO_DIST_DIR,
    limits: DEFAULT_LIMITS,
    minimumVersions: DEFAULT_MINIMUM_VERSIONS,
    sseKeepaliveMs: DEFAULT_SSE_KEEPALIVE_MS,
    ...overrides,
  };
}

/** Creates a session through the API with boring defaults; returns its id, token, and the raw response. */
export async function createTestSession(
  app: App,
  overrides: Partial<{ protocolVersion: number; clientVersion: string; host: HostInfo }> = {},
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
