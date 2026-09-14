import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { T0_MS, makeHost } from "@afk/shared/testing";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { createStorageFromEnv } from "./create-storage.ts";
import { DiskSessionStorage } from "./disk-storage.ts";
import { S3SessionStorage } from "./s3-storage.ts";
import type { SessionRecord } from "./storage.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "afk-create-storage-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const S3_ENV = {
  AFK_STORAGE: "s3",
  AFK_S3_BUCKET: "test-bucket",
  AFK_S3_REGION: "us-east-1",
  AFK_S3_ACCESS_KEY_ID: "key",
  AFK_S3_SECRET_ACCESS_KEY: "secret",
};

/** A copy of `env` with `key` removed, for testing a missing required variable. */
function withoutVar(env: typeof S3_ENV, key: keyof typeof S3_ENV): NodeJS.ProcessEnv {
  const copy: Partial<typeof S3_ENV> = { ...env };
  delete copy[key];
  return copy;
}

function makeRecord(): SessionRecord {
  return {
    sessionId: "session1",
    ingestToken: "token1",
    host: makeHost(),
    clientVersion: "0.1.0",
    startedAt: T0_MS,
    endedAt: null,
    maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
  };
}

describe("createStorageFromEnv", () => {
  it("returns a DiskSessionStorage rooted at the given default data dir when AFK_STORAGE is unset", async () => {
    const dataDir = await makeTempDir();

    const storage = createStorageFromEnv({}, dataDir);

    expect(storage).toBeInstanceOf(DiskSessionStorage);
    await storage.putSession(makeRecord());
    await expect(
      access(join(dataDir, "sessions", "session1", "session.json")),
    ).resolves.toBeUndefined();
  });

  it("returns a DiskSessionStorage rooted at AFK_DATA_DIR when it is set", async () => {
    const defaultDataDir = await makeTempDir();
    const overrideDataDir = await makeTempDir();

    const storage = createStorageFromEnv({ AFK_DATA_DIR: overrideDataDir }, defaultDataDir);

    await storage.putSession(makeRecord());
    await expect(
      access(join(overrideDataDir, "sessions", "session1", "session.json")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(defaultDataDir, "sessions", "session1", "session.json")),
    ).rejects.toThrow();
  });

  it("returns an S3SessionStorage when AFK_STORAGE=s3 and all required variables are set", async () => {
    const storage = createStorageFromEnv(S3_ENV, await makeTempDir());

    expect(storage).toBeInstanceOf(S3SessionStorage);
  });

  it("throws naming the missing variable when AFK_STORAGE=s3 is missing AFK_S3_BUCKET", async () => {
    const env = withoutVar(S3_ENV, "AFK_S3_BUCKET");

    expect(() => createStorageFromEnv(env, "/unused")).toThrow("AFK_S3_BUCKET");
  });

  it("throws naming the missing variable when AFK_STORAGE=s3 is missing AFK_S3_SECRET_ACCESS_KEY", async () => {
    const env = withoutVar(S3_ENV, "AFK_S3_SECRET_ACCESS_KEY");

    expect(() => createStorageFromEnv(env, "/unused")).toThrow("AFK_S3_SECRET_ACCESS_KEY");
  });

  it("throws for an unrecognized backend name", async () => {
    expect(() => createStorageFromEnv({ AFK_STORAGE: "azure" }, "/unused")).toThrow("azure");
  });
});
