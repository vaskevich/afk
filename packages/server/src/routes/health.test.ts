import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@afk/shared";
import { DEFAULT_LIMITS } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { makeAppConfig } from "./test-helpers.ts";

function buildApp() {
  return createApp(makeAppConfig(), new SessionStore(new MemorySessionStorage(), DEFAULT_LIMITS));
}

describe("GET /api/health", () => {
  it("reports ok and the protocol version", async () => {
    const app = buildApp();

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION });
  });

  it("carries the security headers like every other response", async () => {
    const app = buildApp();

    const res = await app.request("/api/health");

    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });
});
