import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@afk/shared";
import { DEFAULT_LIMITS } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";

/** No dashboard build exists at this path; this test only exercises the API route. */
const NO_DIST_DIR = "/nonexistent/afk-test-dist";

describe("GET /api/health", () => {
  it("reports ok and the protocol version", async () => {
    const app = createApp(
      { publicBaseUrl: "https://afk.test", webDistDir: NO_DIST_DIR, limits: DEFAULT_LIMITS },
      new SessionStore(new MemorySessionStorage(), DEFAULT_LIMITS),
    );

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION });
  });
});
