import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, VersionResponse } from "@afk/shared";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { TEST_BUILD, makeAppConfig } from "./test-helpers.ts";

const WEB_BUILD = { version: "0.2.0", commit: "def5678" };
const CLIENT_VERSION = "0.3.0";

describe("GET /versionz and GET /api/version", () => {
  it("reports the server build, the dashboard build, the served client, and the protocol version", async () => {
    const app = createApp(
      makeAppConfig({ webBuild: WEB_BUILD, latestClientVersion: CLIENT_VERSION }),
      new SessionStore(new MemorySessionStorage()),
    );

    const res = await app.request("/versionz");

    expect(res.status).toBe(200);
    expect(VersionResponse.parse(await res.json())).toEqual({
      server: TEST_BUILD,
      web: WEB_BUILD,
      client: { version: CLIENT_VERSION },
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it("serves the same body under /api/version", async () => {
    const app = createApp(
      makeAppConfig({ webBuild: WEB_BUILD }),
      new SessionStore(new MemorySessionStorage()),
    );

    const [operator, api] = await Promise.all([
      app.request("/versionz"),
      app.request("/api/version"),
    ]);

    expect(api.status).toBe(200);
    expect(await api.json()).toEqual(await operator.json());
  });

  it("reports null for the dashboard, the client, and an unset commit and build time", async () => {
    const app = createApp(
      makeAppConfig({
        build: { version: "0.1.0", commit: null, builtAt: null },
        webBuild: null,
        latestClientVersion: null,
      }),
      new SessionStore(new MemorySessionStorage()),
    );

    const res = await app.request("/versionz");

    expect(VersionResponse.parse(await res.json())).toEqual({
      server: { version: "0.1.0", commit: null, builtAt: null },
      web: null,
      client: null,
      protocolVersion: PROTOCOL_VERSION,
    });
  });
});
