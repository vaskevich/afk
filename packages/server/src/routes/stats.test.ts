import { describe, expect, it } from "vitest";
import { ServiceStats, type StoredFrame } from "@afk/shared";
import { makeSystemFrame } from "@afk/shared/testing";
import { DEFAULT_LIMITS, type AdmissionLimits, type AppConfig } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore, storedFrameBytes } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { TEST_BUILD, createTestSession, makeAppConfig, postFrames } from "./test-helpers.ts";

function buildApp(limits: AdmissionLimits, webBuild: AppConfig["webBuild"] = null) {
  return createApp(
    makeAppConfig({ limits, webBuild }),
    new SessionStore(new MemorySessionStorage(), { limits }),
  );
}

describe("GET /api/stats", () => {
  it("reports active sessions, the configured limits, in-memory counts, and an integer uptime", async () => {
    const limits: AdmissionLimits = {
      maxActiveSessions: 20,
      maxStreamsPerSession: 10,
      maxFramesPerSession: 15_000,
      maxBytesPerSession: 8_388_608,
    };
    const app = buildApp(limits);
    await createTestSession(app);

    const res = await app.request("/api/stats");

    expect(res.status).toBe(200);
    const body = ServiceStats.parse(await res.json());
    expect(body).toMatchObject({
      activeSessions: 1,
      maxActiveSessions: 20,
      maxStreamsPerSession: 10,
      maxFramesPerSession: 15_000,
      maxBytesPerSession: 8_388_608,
      sessionsInMemory: 1,
      framesInMemory: 0,
      bytesInMemory: 0,
    });
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
  });

  it("counts the stored bytes of every frame in memory, the same measure the byte cap uses", async () => {
    const app = buildApp(DEFAULT_LIMITS);
    const { sessionId, ingestToken } = await createTestSession(app);
    const frames = [makeSystemFrame(0), makeSystemFrame(1)];
    await postFrames(app, sessionId, ingestToken, frames);
    const stored = (await (await app.request(`/api/sessions/${sessionId}/frames`)).json()) as {
      frames: StoredFrame[];
    };
    const expectedBytes = stored.frames.reduce((sum, f) => sum + storedFrameBytes(f), 0);

    const body = ServiceStats.parse(await (await app.request("/api/stats")).json());

    expect(body).toMatchObject({ framesInMemory: 2, bytesInMemory: expectedBytes });
    expect(body.bytesInMemory).toBeGreaterThan(0);
  });

  it("reports the server package version and the served dashboard's commit", async () => {
    const app = buildApp(DEFAULT_LIMITS, { version: "0.2.0", commit: "def5678" });

    const body = ServiceStats.parse(await (await app.request("/api/stats")).json());

    expect(body).toMatchObject({ serverVersion: TEST_BUILD.version, webCommit: "def5678" });
  });

  it("reports a null dashboard commit when no dashboard build is present", async () => {
    const app = buildApp(DEFAULT_LIMITS, null);

    const body = ServiceStats.parse(await (await app.request("/api/stats")).json());

    expect(body.webCommit).toBeNull();
  });
});
