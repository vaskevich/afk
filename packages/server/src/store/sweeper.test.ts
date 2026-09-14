import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { T0_MS, makeHost, makeStoredFrames, makeSystemFrame } from "@afk/shared/testing";
import { DiskSessionStorage } from "./disk-storage.ts";
import { SessionStore } from "./sessions.ts";
import { MemorySessionStorage, type SessionRecord, type SessionStorage } from "./storage.ts";
import { MS_PER_DAY, startSweeper, sweepExpiredSessions } from "./sweeper.ts";

const RETENTION_MS = 7 * MS_PER_DAY;
const MAX_DURATION_SECONDS = 3600;
const MAX_DURATION_MS = MAX_DURATION_SECONDS * 1000;

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "afk-sweeper-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "session1",
    ingestToken: "token1",
    host: makeHost(),
    clientVersion: "0.1.0",
    startedAt: T0_MS,
    endedAt: T0_MS + 60_000,
    maxDurationSeconds: MAX_DURATION_SECONDS,
    ...overrides,
  };
}

/** Wraps a storage so reading one particular session fails. */
class BrokenReadStorage implements SessionStorage {
  constructor(
    private readonly inner: SessionStorage,
    private readonly brokenSessionId: string,
  ) {}

  putSession(record: SessionRecord): Promise<void> {
    return this.inner.putSession(record);
  }
  async getSession(sessionId: string): Promise<SessionRecord | null> {
    if (sessionId === this.brokenSessionId) {
      throw new Error("simulated read failure");
    }
    return this.inner.getSession(sessionId);
  }
  appendFrames(sessionId: string, frames: Parameters<SessionStorage["appendFrames"]>[1]) {
    return this.inner.appendFrames(sessionId, frames);
  }
  readFrames(sessionId: string) {
    return this.inner.readFrames(sessionId);
  }
  listSessionIds(): Promise<string[]> {
    return this.inner.listSessionIds();
  }
  deleteSession(sessionId: string): Promise<void> {
    return this.inner.deleteSession(sessionId);
  }
}

/** Wraps a storage so each `listSessionIds` call blocks until the test releases it. */
class GatedListStorage implements SessionStorage {
  listCalls = 0;
  private release: (() => void) | undefined;

  constructor(private readonly inner: SessionStorage) {}

  /** Lets the pending `listSessionIds` call finish. */
  releaseList(): void {
    this.release?.();
    this.release = undefined;
  }

  putSession(record: SessionRecord): Promise<void> {
    return this.inner.putSession(record);
  }
  getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.inner.getSession(sessionId);
  }
  appendFrames(sessionId: string, frames: Parameters<SessionStorage["appendFrames"]>[1]) {
    return this.inner.appendFrames(sessionId, frames);
  }
  readFrames(sessionId: string) {
    return this.inner.readFrames(sessionId);
  }
  async listSessionIds(): Promise<string[]> {
    this.listCalls++;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return this.inner.listSessionIds();
  }
  deleteSession(sessionId: string): Promise<void> {
    return this.inner.deleteSession(sessionId);
  }
}

describe("sweepExpiredSessions", () => {
  it("deletes an ended session once the retention window has passed and evicts it from memory", async () => {
    const storage = new MemorySessionStorage();
    const record = makeRecord({ endedAt: T0_MS });
    await storage.putSession(record);
    const store = new SessionStore(storage);
    await store.get(record.sessionId);

    const result = await sweepExpiredSessions(storage, store, T0_MS + RETENTION_MS, RETENTION_MS);

    expect(result).toEqual({ scanned: 1, deleted: 1 });
    await expect(storage.getSession(record.sessionId)).resolves.toBeNull();
    expect(store.stats().sessionsInMemory).toBe(0);
  });

  it("keeps an ended session that is younger than the retention window", async () => {
    const storage = new MemorySessionStorage();
    const record = makeRecord({ endedAt: T0_MS });
    await storage.putSession(record);
    const store = new SessionStore(storage);

    const result = await sweepExpiredSessions(
      storage,
      store,
      T0_MS + RETENTION_MS - 1,
      RETENTION_MS,
    );

    expect(result).toEqual({ scanned: 1, deleted: 0 });
    await expect(storage.getSession(record.sessionId)).resolves.toEqual(record);
  });

  it("never touches an active session, even with no retention at all", async () => {
    const storage = new MemorySessionStorage();
    const record = makeRecord({ endedAt: null });
    await storage.putSession(record);
    const store = new SessionStore(storage);

    const result = await sweepExpiredSessions(storage, store, T0_MS + 1_000, 0);

    expect(result).toEqual({ scanned: 1, deleted: 0 });
    await expect(storage.getSession(record.sessionId)).resolves.toEqual(record);
  });

  it("treats a session that never received an end as ended when it hit its cap", async () => {
    const storage = new MemorySessionStorage();
    const record = makeRecord({ endedAt: null });
    await storage.putSession(record);
    const store = new SessionStore(storage);
    const cappedAt = T0_MS + MAX_DURATION_MS;

    const kept = await sweepExpiredSessions(
      storage,
      store,
      cappedAt + RETENTION_MS - 1,
      RETENTION_MS,
    );
    const swept = await sweepExpiredSessions(storage, store, cappedAt + RETENTION_MS, RETENTION_MS);

    expect(kept).toEqual({ scanned: 1, deleted: 0 });
    expect(swept).toEqual({ scanned: 1, deleted: 1 });
    await expect(storage.getSession(record.sessionId)).resolves.toBeNull();
  });

  it("carries on with the other sessions when reading one of them fails", async () => {
    const inner = new MemorySessionStorage();
    await inner.putSession(makeRecord({ sessionId: "expiredA", endedAt: T0_MS }));
    await inner.putSession(makeRecord({ sessionId: "broken", endedAt: T0_MS }));
    await inner.putSession(makeRecord({ sessionId: "expiredB", endedAt: T0_MS }));
    const storage = new BrokenReadStorage(inner, "broken");
    const store = new SessionStore(storage);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sweepExpiredSessions(storage, store, T0_MS + RETENTION_MS, RETENTION_MS);

    expect(result).toEqual({ scanned: 3, deleted: 2 });
    await expect(inner.listSessionIds()).resolves.toEqual(["broken"]);
  });

  it("removes a swept session's directory from disk storage", async () => {
    const dataDir = await makeTempDir();
    const storage = new DiskSessionStorage(dataDir);
    const record = makeRecord({ endedAt: T0_MS });
    await storage.putSession(record);
    await storage.appendFrames(record.sessionId, makeStoredFrames([makeSystemFrame(0)]));
    const store = new SessionStore(storage);

    await sweepExpiredSessions(storage, store, T0_MS + RETENTION_MS, RETENTION_MS);

    await expect(access(join(dataDir, "sessions", record.sessionId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(storage.listSessionIds()).resolves.toEqual([]);
  });
});

describe("startSweeper", () => {
  it("sweeps once after the startup delay and then on every interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS + RETENTION_MS);
    const storage = new MemorySessionStorage();
    await storage.putSession(makeRecord({ sessionId: "old", endedAt: T0_MS }));
    await storage.putSession(makeRecord({ sessionId: "fresh", endedAt: T0_MS + 60_000 }));
    const listSpy = vi.spyOn(storage, "listSessionIds");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stop = startSweeper({
      storage,
      store: new SessionStore(storage),
      retentionMs: RETENTION_MS,
      intervalMs: 1_000,
      startupDelayMs: 100,
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(listSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(storage.listSessionIds()).resolves.toEqual(["fresh"]);

    vi.setSystemTime(T0_MS + RETENTION_MS + 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(storage.listSessionIds()).resolves.toEqual([]);

    stop();
  });

  it("skips an interval while the previous sweep is still running", async () => {
    vi.useFakeTimers();
    const storage = new GatedListStorage(new MemorySessionStorage());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stop = startSweeper({
      storage,
      store: new SessionStore(storage),
      retentionMs: RETENTION_MS,
      intervalMs: 1_000,
      startupDelayMs: 0,
    });

    await vi.advanceTimersByTimeAsync(2_500);
    expect(storage.listCalls).toBe(1);

    storage.releaseList();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(storage.listCalls).toBe(2);

    stop();
  });

  it("stops sweeping once the returned function is called", async () => {
    vi.useFakeTimers();
    const storage = new MemorySessionStorage();
    const listSpy = vi.spyOn(storage, "listSessionIds");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stop = startSweeper({
      storage,
      store: new SessionStore(storage),
      retentionMs: RETENTION_MS,
      intervalMs: 1_000,
      startupDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listSpy).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(listSpy).toHaveBeenCalledTimes(2);
  });
});
