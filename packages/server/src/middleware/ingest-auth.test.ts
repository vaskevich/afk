import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeHost, makeSystemFrame } from "@afk/shared/testing";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { createApp } from "../app.ts";
import { DiskSessionStorage } from "../store/disk-storage.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { hashIngestToken } from "../utils/ingest-token.ts";
import {
  CLIENT_VERSION_HEADER,
  createTestSession,
  makeAppConfig,
  postFrameBody,
  postFrames,
} from "../routes/test-helpers.ts";

/** A well-formed session id (22 base62 characters), as the route layer requires. */
const LEGACY_SESSION_ID = "LegacySession0000000AB";
const LEGACY_TOKEN = "clear-token-from-before-hashing";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "afk-ingest-auth-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function buildApp() {
  return createApp(makeAppConfig(), new SessionStore(new MemorySessionStorage()));
}

/**
 * An app over disk storage holding one active session written by a server from before
 * tokens were hashed: `session.json` carries the clear `ingestToken`.
 */
async function appWithLegacySession() {
  const dir = await makeTempDir();
  await mkdir(join(dir, "sessions", LEGACY_SESSION_ID), { recursive: true });
  await writeFile(
    join(dir, "sessions", LEGACY_SESSION_ID, "session.json"),
    JSON.stringify({
      sessionId: LEGACY_SESSION_ID,
      ingestToken: LEGACY_TOKEN,
      host: makeHost(),
      clientVersion: "0.1.0",
      startedAt: Date.now(),
      endedAt: null,
      maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
      previousSessionId: null,
      nextSessionId: null,
    }),
  );
  return createApp(makeAppConfig(), new SessionStore(new DiskSessionStorage(dir)));
}

describe("ingestAuth", () => {
  it("accepts the token the create response handed out, though only its hash is stored", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);

    const res = await postFrames(app, sessionId, ingestToken, [makeSystemFrame(0)]);

    expect(res.status).toBe(200);
  });

  it("accepts the clear token of a session stored before tokens were hashed", async () => {
    const app = await appWithLegacySession();

    const res = await postFrames(app, LEGACY_SESSION_ID, LEGACY_TOKEN, [makeSystemFrame(0)]);

    expect(res.status).toBe(200);
  });

  it("answers 401 for a token that differs in one character, and for one of another length", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);
    const body = JSON.stringify(makeSystemFrame(0));
    const lastChar = ingestToken.at(-1) === "a" ? "b" : "a";
    const oneOff = ingestToken.slice(0, -1) + lastChar;

    const wrong = await postFrameBody(app, sessionId, oneOff, body);
    const short = await postFrameBody(app, sessionId, "x", body);
    const long = await postFrameBody(app, sessionId, ingestToken + ingestToken, body);

    expect([wrong.status, short.status, long.status]).toEqual([401, 401, 401]);
    expect(await wrong.json()).toEqual({ error: "bad ingest token" });
  });

  it("answers 401 for the stored hash presented as the token: knowing the record is not knowing the token", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);

    const res = await postFrames(app, sessionId, hashIngestToken(ingestToken), [
      makeSystemFrame(0),
    ]);

    expect(res.status).toBe(401);
  });

  it("answers 401 for a header without the Bearer scheme, and for none at all", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);
    const body = JSON.stringify(makeSystemFrame(0));

    const basic = await app.request(`/api/sessions/${sessionId}/frames`, {
      method: "POST",
      headers: { authorization: `Basic ${ingestToken}`, ...CLIENT_VERSION_HEADER },
      body,
    });
    const none = await app.request(`/api/sessions/${sessionId}/frames`, {
      method: "POST",
      headers: CLIENT_VERSION_HEADER,
      body,
    });

    expect([basic.status, none.status]).toEqual([401, 401]);
  });

  it("checks the token before the session's state, so a wrong token on an ended session is 401 not 410", async () => {
    const app = buildApp();
    const { sessionId, ingestToken } = await createTestSession(app);
    await app.request(`/api/sessions/${sessionId}/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${ingestToken}`, ...CLIENT_VERSION_HEADER },
    });

    const res = await postFrames(app, sessionId, "not-the-token", [makeSystemFrame(0)]);

    expect(res.status).toBe(401);
  });
});
