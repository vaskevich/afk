import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { randomId } from "../utils/ids.ts";
import {
  CLIENT_VERSION_HEADER,
  createTestSession,
  endTestSession,
  makeAppConfig,
  postFrameBody,
} from "../routes/test-helpers.ts";

type App = ReturnType<typeof createApp>;

/** A fresh app whose storage reads can be counted. */
function buildApp() {
  const storage = new MemorySessionStorage();
  const getSessionSpy = vi.spyOn(storage, "getSession");
  const app = createApp(makeAppConfig(), new SessionStore(storage));
  return { app, getSessionSpy };
}

/** Every route that takes a `:sessionId`, with the headers a real caller sends. */
const ROUTES: {
  name: string;
  request: (app: App, sessionId: string) => Response | Promise<Response>;
}[] = [
  { name: "GET /api/sessions/:id", request: (app, id) => app.request(`/api/sessions/${id}`) },
  {
    name: "GET /api/sessions/:id/frames",
    request: (app, id) => app.request(`/api/sessions/${id}/frames`),
  },
  {
    name: "GET /api/sessions/:id/stream",
    request: (app, id) => app.request(`/api/sessions/${id}/stream`),
  },
  {
    name: "GET /api/sessions/:id/qr",
    request: (app, id) =>
      app.request(`/api/sessions/${id}/qr`, {
        headers: { authorization: "Bearer whatever", ...CLIENT_VERSION_HEADER },
      }),
  },
  {
    name: "POST /api/sessions/:id/end",
    request: (app, id) => endTestSession(app, id, "whatever"),
  },
  {
    name: "POST /api/sessions/:id/frames",
    request: (app, id) => postFrameBody(app, id, "whatever", ""),
  },
];

/** Ids that are not 22 base62 characters, including path-traversal and near misses. */
const MALFORMED_IDS = [
  "does-not-exist",
  "%2e%2e%2fescape",
  "D3FzMqK8qOLVva9LoHF9u", // 21 characters
  "D3FzMqK8qOLVva9LoHF9ucX", // 23 characters
  "D3FzMqK8qOLVva9LoHF9u_", // 22 characters, one outside base62
];

describe("session id validation", () => {
  describe.each(ROUTES)("$name", ({ request }) => {
    it.each(MALFORMED_IDS)("answers 404 for %j without consulting storage", async (id) => {
      const { app, getSessionSpy } = buildApp();

      const res = await request(app, id);

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "unknown session" });
      expect(getSessionSpy).not.toHaveBeenCalled();
    });
  });

  it("rejects a malformed id before the client version check, so no header is needed to get the 404", async () => {
    const { app } = buildApp();

    const res = await endTestSession(app, "does-not-exist", "whatever", {});

    expect(res.status).toBe(404);
  });

  it("lets a well-formed id through to the route", async () => {
    const { app } = buildApp();
    const { sessionId } = await createTestSession(app);

    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
  });

  it("reads storage once for a well-formed unknown id, then answers repeated probes from memory", async () => {
    const { app, getSessionSpy } = buildApp();
    const unknownId = randomId();

    const first = await app.request(`/api/sessions/${unknownId}`);
    const second = await app.request(`/api/sessions/${unknownId}/frames`);

    expect([first.status, second.status]).toEqual([404, 404]);
    expect(getSessionSpy).toHaveBeenCalledTimes(1);
  });
});
