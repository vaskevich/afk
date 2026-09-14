/**
 * Shared helpers for route tests. Every test builds its own app with `createApp` and a
 * fresh in-memory store (see docs/TESTING.md), then uses these to avoid repeating the
 * session-creation and frame-posting boilerplate. Exports functions only.
 */
import { makeHost } from "@afk/shared/testing";
import type { Frame, HostInfo } from "@afk/shared";
import type { createApp } from "../app.ts";

type App = ReturnType<typeof createApp>;

/** Creates a session through the API with boring defaults; returns its id, token, and the raw response. */
export async function createTestSession(
  app: App,
  overrides: Partial<{ protocolVersion: number; clientVersion: string; host: HostInfo }> = {},
): Promise<{ res: Response; sessionId: string; ingestToken: string }> {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
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

/** Posts a batch of frames as an NDJSON body with the session's bearer token. */
export async function postFrames(
  app: App,
  sessionId: string,
  ingestToken: string,
  frames: readonly Frame[],
): Promise<Response> {
  return app.request(`/api/sessions/${sessionId}/frames`, {
    method: "POST",
    headers: {
      "content-type": "application/x-ndjson",
      authorization: `Bearer ${ingestToken}`,
    },
    body: frames.map((frame) => JSON.stringify(frame)).join("\n"),
  });
}
