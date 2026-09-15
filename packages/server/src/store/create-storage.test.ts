import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { T0_MS, makeHost } from "@afk/shared/testing";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { createStorage } from "./create-storage.ts";
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

function makeRecord(): SessionRecord {
  return {
    sessionId: "session1",
    ingestTokenHash: "tokenHash1",
    host: makeHost(),
    clientVersion: "0.1.0",
    startedAt: T0_MS,
    endedAt: null,
    maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
    previousSessionId: null,
    nextSessionId: null,
  };
}

describe("createStorage", () => {
  it("returns a DiskSessionStorage rooted at the configured data dir", async () => {
    const dataDir = await makeTempDir();

    const storage = createStorage({ backend: "disk", dataDir });

    expect(storage).toBeInstanceOf(DiskSessionStorage);
    await storage.putSession(makeRecord());
    await expect(
      access(join(dataDir, "sessions", "session1", "session.json")),
    ).resolves.toBeUndefined();
  });

  it("returns an S3SessionStorage for the s3 backend", async () => {
    const storage = createStorage({
      backend: "s3",
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: undefined,
      accessKeyId: "key",
      secretAccessKey: "secret",
      slabFlushSeconds: 60,
      slabMaxFrames: 100,
    });

    expect(storage).toBeInstanceOf(S3SessionStorage);
  });
});
