import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { T0_MS, makeHost, makeStoredFrames, makeSystemFrame } from "@afk/shared/testing";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { DiskSessionStorage } from "./disk-storage.ts";
import type { SessionRecord } from "./storage.ts";

const tempDirs: string[] = [];

/** A fresh data dir for one test, removed in afterEach. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "afk-disk-storage-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "session1",
    ingestToken: "token1",
    host: makeHost(),
    clientVersion: "0.1.0",
    startedAt: T0_MS,
    endedAt: null,
    maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
    ...overrides,
  };
}

describe("DiskSessionStorage", () => {
  describe("putSession and getSession", () => {
    it("round-trips a record", async () => {
      const storage = new DiskSessionStorage(await makeTempDir());
      const record = makeRecord();

      await storage.putSession(record);

      await expect(storage.getSession(record.sessionId)).resolves.toEqual(record);
    });

    it("returns null for a missing session", async () => {
      const storage = new DiskSessionStorage(await makeTempDir());

      await expect(storage.getSession("doesNotExist")).resolves.toBeNull();
    });

    it("returns null for a session id that contains a path segment", async () => {
      const storage = new DiskSessionStorage(await makeTempDir());

      await expect(storage.getSession("../escape")).resolves.toBeNull();
    });

    it("rejects writing a session id that contains a path segment", async () => {
      const storage = new DiskSessionStorage(await makeTempDir());

      await expect(storage.putSession(makeRecord({ sessionId: "../escape" }))).rejects.toThrow(
        "invalid session id",
      );
    });
  });

  describe("appendFrames and readFrames", () => {
    it("returns frames in order across two appends", async () => {
      const storage = new DiskSessionStorage(await makeTempDir());
      await storage.putSession(makeRecord());
      const frames = makeStoredFrames([
        makeSystemFrame(0),
        makeSystemFrame(1, { sequence: 2 }),
        makeSystemFrame(2, { sequence: 3 }),
      ]);

      await storage.appendFrames("session1", frames.slice(0, 2));
      await storage.appendFrames("session1", frames.slice(2));

      await expect(storage.readFrames("session1")).resolves.toEqual(frames);
    });

    it("skips an unreadable line and still returns the rest", async () => {
      const dataDir = await makeTempDir();
      const storage = new DiskSessionStorage(dataDir);
      await storage.putSession(makeRecord());
      const good = makeStoredFrames([makeSystemFrame(0)]);
      await storage.appendFrames("session1", good);
      // The documented layout is sessions/<id>/frames.ndjson; write a line that is
      // valid JSON but not a valid StoredFrame, which is what `readFrames` is built to
      // skip (see disk-storage.ts's use of StoredFrame.safeParse).
      await appendFile(
        join(dataDir, "sessions", "session1", "frames.ndjson"),
        '{"not":"a valid frame"}\n',
      );

      await expect(storage.readFrames("session1")).resolves.toEqual(good);
    });

    it("returns an empty array for a session with no frames", async () => {
      const storage = new DiskSessionStorage(await makeTempDir());
      await storage.putSession(makeRecord());

      await expect(storage.readFrames("session1")).resolves.toEqual([]);
    });
  });

  describe("listSessionIds", () => {
    it("returns an empty list when the sessions directory does not exist", async () => {
      const storage = new DiskSessionStorage(await makeTempDir());

      await expect(storage.listSessionIds()).resolves.toEqual([]);
    });

    it("lists only directories with safe ids, skipping others", async () => {
      const dataDir = await makeTempDir();
      const storage = new DiskSessionStorage(dataDir);
      await storage.putSession(makeRecord({ sessionId: "sessionA" }));
      await storage.putSession(makeRecord({ sessionId: "sessionB" }));
      // A directory that could not have come from putSession (unsafe name).
      await mkdir(join(dataDir, "sessions", "not..safe"), { recursive: true });

      const ids = await storage.listSessionIds();

      expect(ids.sort()).toEqual(["sessionA", "sessionB"]);
    });
  });

  describe("deleteSession", () => {
    it("removes the session's directory and its contents", async () => {
      const storage = new DiskSessionStorage(await makeTempDir());
      await storage.putSession(makeRecord());
      await storage.appendFrames("session1", makeStoredFrames([makeSystemFrame(0)]));

      await storage.deleteSession("session1");

      await expect(storage.getSession("session1")).resolves.toBeNull();
      await expect(storage.readFrames("session1")).resolves.toEqual([]);
      await expect(storage.listSessionIds()).resolves.toEqual([]);
    });

    it("does nothing for a session that does not exist", async () => {
      const storage = new DiskSessionStorage(await makeTempDir());

      await expect(storage.deleteSession("neverExisted")).resolves.toBeUndefined();
    });
  });
});
