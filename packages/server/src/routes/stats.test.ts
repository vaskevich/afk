import { describe, expect, it } from "vitest";
import { ServiceStats } from "@afk/shared";
import type { AdmissionLimits } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { createTestSession, makeAppConfig } from "./test-helpers.ts";

function buildApp(limits: AdmissionLimits) {
  return createApp(
    makeAppConfig({ limits }),
    new SessionStore(new MemorySessionStorage(), { limits }),
  );
}

describe("GET /api/stats", () => {
  it("reports active sessions, the configured limits, in-memory counts, and an integer uptime", async () => {
    const limits: AdmissionLimits = { maxActiveSessions: 20, maxStreamsPerSession: 10 };
    const app = buildApp(limits);
    await createTestSession(app);

    const res = await app.request("/api/stats");

    expect(res.status).toBe(200);
    const body = ServiceStats.parse(await res.json());
    expect(body).toMatchObject({
      activeSessions: 1,
      maxActiveSessions: 20,
      maxStreamsPerSession: 10,
      sessionsInMemory: 1,
      framesInMemory: 0,
    });
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
  });
});
