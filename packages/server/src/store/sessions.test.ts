import { afterEach, describe, expect, it, vi } from "vitest";
import {
  T0_MS,
  makeHost,
  makeRunFrame,
  makeStoredFrames,
  makeSystemFrame,
} from "@afk/shared/testing";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS, type StoredFrame } from "@afk/shared";
import { log } from "../log/logger.ts";
import { MemorySessionStorage, type SessionRecord, type SessionStorage } from "./storage.ts";
import {
  AlreadyContinuedError,
  DEFAULT_STORE_OPTIONS,
  SessionStore,
  TooManyFramesError,
  TooManyStreamsError,
  UNKNOWN_ID_CACHE_MAX_ENTRIES,
  UNKNOWN_ID_TTL_MS,
  sessionEndMs,
  sessionStatus,
  type SessionEvent,
} from "./sessions.ts";

/**
 * Wraps a `SessionStorage` so a test can make exactly one `appendFrames` call fail,
 * to prove the store persists before it advances in-memory state.
 */
class FlakyAppendStorage implements SessionStorage {
  private failNextAppend = false;

  constructor(private readonly inner: SessionStorage) {}

  failNextAppendOnce(): void {
    this.failNextAppend = true;
  }

  putSession(record: SessionRecord): Promise<void> {
    return this.inner.putSession(record);
  }
  getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.inner.getSession(sessionId);
  }
  async appendFrames(sessionId: string, frames: StoredFrame[]): Promise<void> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("simulated write failure");
    }
    return this.inner.appendFrames(sessionId, frames);
  }
  readFrames(sessionId: string): Promise<StoredFrame[]> {
    return this.inner.readFrames(sessionId);
  }
  listSessionIds(): Promise<string[]> {
    return this.inner.listSessionIds();
  }
  deleteSession(sessionId: string): Promise<void> {
    return this.inner.deleteSession(sessionId);
  }
}

/** A run of system frames, one per second, with the given cpu percent at each offset. */
function highCpuFrames(count: number) {
  return Array.from({ length: count }, (_, i) => makeSystemFrame(i, { cpuPercent: 95 }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionStore", () => {
  describe("create", () => {
    it("persists a record and returns a session with a distinct id and token", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);

      const first = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const second = await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      expect(first.sessionId).not.toBe(second.sessionId);
      expect(first.ingestToken).not.toBe(second.ingestToken);
      await expect(storage.getSession(first.sessionId)).resolves.toMatchObject({
        sessionId: first.sessionId,
        ingestToken: first.ingestToken,
        clientVersion: "0.1.0",
      });
    });

    it("stamps the configured max duration on every new session", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage, { maxSessionDurationSeconds: 120 });

      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      expect(session.maxDurationSeconds).toBe(120);
      await expect(storage.getSession(session.sessionId)).resolves.toMatchObject({
        maxDurationSeconds: 120,
      });
    });

    it("uses the shared default max duration when none is configured", async () => {
      const store = new SessionStore(new MemorySessionStorage());

      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      expect(session.maxDurationSeconds).toBe(DEFAULT_MAX_SESSION_DURATION_SECONDS);
    });

    it("starts every session unlinked", async () => {
      const store = new SessionStore(new MemorySessionStorage());

      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      expect(store.summary(session)).toMatchObject({
        previousSessionId: null,
        nextSessionId: null,
      });
    });
  });

  describe("create with a previous session (chaining)", () => {
    it("links both records, ends the previous session at that moment, persists both, and emits ended with the successor", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const previous = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(previous, highCpuFrames(31));
      const received: SessionEvent[] = [];
      store.subscribe(previous, (event) => received.push(event));
      vi.setSystemTime(T0_MS + 50_000);

      const next = await store.create({ host: makeHost(), clientVersion: "0.1.0", previous });

      expect(store.summary(next)).toMatchObject({
        status: "active",
        startedAt: T0_MS + 50_000,
        previousSessionId: previous.sessionId,
        nextSessionId: null,
      });
      expect(store.summary(previous)).toMatchObject({
        status: "ended",
        endedAt: T0_MS + 50_000,
        nextSessionId: next.sessionId,
      });
      await expect(storage.getSession(previous.sessionId)).resolves.toMatchObject({
        endedAt: T0_MS + 50_000,
        nextSessionId: next.sessionId,
      });
      await expect(storage.getSession(next.sessionId)).resolves.toMatchObject({
        previousSessionId: previous.sessionId,
      });
      expect(previous.engine.events).toEqual([
        expect.objectContaining({ kind: "cpu.high", endedAt: T0_MS + 50_000 }),
      ]);
      expect(received).toContainEqual({
        type: "ended",
        summary: expect.objectContaining({ status: "ended", nextSessionId: next.sessionId }),
        reason: "ended",
      });
    });

    it("ends an expired previous session at its cap rather than at the chain moment", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const store = new SessionStore(new MemorySessionStorage(), { maxSessionDurationSeconds: 60 });
      const previous = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      vi.setSystemTime(T0_MS + 90_000);

      const next = await store.create({ host: makeHost(), clientVersion: "0.1.0", previous });

      expect(store.summary(previous)).toMatchObject({
        status: "ended",
        endedAt: T0_MS + 60_000,
        nextSessionId: next.sessionId,
      });
    });

    it("links a previous session that had already ended without moving its end time", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const previous = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.end(previous);
      vi.setSystemTime(T0_MS + 5_000);

      const next = await store.create({ host: makeHost(), clientVersion: "0.1.0", previous });

      expect(previous.endedAt).toBe(T0_MS);
      await expect(storage.getSession(previous.sessionId)).resolves.toMatchObject({
        endedAt: T0_MS,
        nextSessionId: next.sessionId,
      });
    });

    it("refuses a second successor for the same session", async () => {
      const store = new SessionStore(new MemorySessionStorage());
      const previous = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const next = await store.create({ host: makeHost(), clientVersion: "0.1.0", previous });

      await expect(
        store.create({ host: makeHost(), clientVersion: "0.1.0", previous }),
      ).rejects.toThrow(AlreadyContinuedError);
      expect(previous.nextSessionId).toBe(next.sessionId);
      expect(store.stats().sessionsInMemory).toBe(2);
    });

    it("keeps the links when a chained session is reloaded from storage", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const previous = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const next = await store.create({ host: makeHost(), clientVersion: "0.1.0", previous });
      store.evict(previous.sessionId);
      store.evict(next.sessionId);

      const reloadedPrevious = await store.get(previous.sessionId);
      const reloadedNext = await store.get(next.sessionId);

      expect(store.summary(reloadedPrevious!)).toMatchObject({ nextSessionId: next.sessionId });
      expect(store.summary(reloadedNext!)).toMatchObject({
        previousSessionId: previous.sessionId,
      });
    });
  });

  describe("get", () => {
    it("returns the cached session without going back to storage", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const created = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const getSessionSpy = vi.spyOn(storage, "getSession");

      const found = await store.get(created.sessionId);

      expect(found).toBe(created);
      expect(getSessionSpy).not.toHaveBeenCalled();
    });

    it("lazily loads a session that only exists in storage, rebuilding sequences and replaying rules", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const storage = new MemorySessionStorage();
      const record: SessionRecord = {
        sessionId: "existingSession",
        ingestToken: "existingToken",
        host: makeHost(),
        clientVersion: "0.1.0",
        startedAt: T0_MS,
        endedAt: null,
        maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
        previousSessionId: null,
        nextSessionId: null,
      };
      await storage.putSession(record);
      const frames = makeStoredFrames(highCpuFrames(31));
      await storage.appendFrames(record.sessionId, frames);
      const store = new SessionStore(storage);

      const loaded = await store.get(record.sessionId);

      expect(loaded?.frames).toEqual(frames);
      expect(loaded?.engine.events).toEqual([
        expect.objectContaining({ kind: "cpu.high", stream: "system", endedAt: null }),
      ]);
      // The 31st frame (offset 30) carries sequence 31; re-ingesting it proves the
      // per-stream sequence map was rebuilt from storage, not left empty.
      const result = await store.ingest(loaded!, [makeSystemFrame(30, { cpuPercent: 95 })]);
      expect(result).toEqual({ accepted: [], duplicates: 1 });
    });

    it("logs one line with the frame count and the time taken when a session is loaded from storage", async () => {
      const storage = new MemorySessionStorage();
      const record: SessionRecord = {
        sessionId: "existingSession",
        ingestToken: "existingToken",
        host: makeHost(),
        clientVersion: "0.1.0",
        startedAt: T0_MS,
        endedAt: null,
        maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
        previousSessionId: null,
        nextSessionId: null,
      };
      await storage.putSession(record);
      await storage.appendFrames(record.sessionId, makeStoredFrames(highCpuFrames(3)));
      const store = new SessionStore(storage);
      const info = vi.spyOn(log, "info").mockImplementation(() => {});

      await store.get(record.sessionId);
      await store.get(record.sessionId);

      // Once: the second get is served from memory.
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith("session loaded from storage", {
        session: record.sessionId,
        frames: 3,
        storageMs: expect.any(Number),
        ms: expect.any(Number),
      });
    });

    it("returns undefined for an id that exists nowhere", async () => {
      const store = new SessionStore(new MemorySessionStorage());

      const found = await store.get("doesNotExist");

      expect(found).toBeUndefined();
    });

    it("reads storage once for an unknown id and remembers the answer within the TTL", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const getSessionSpy = vi.spyOn(storage, "getSession");

      await store.get("doesNotExist", T0_MS);
      const again = await store.get("doesNotExist", T0_MS + UNKNOWN_ID_TTL_MS - 1);

      expect(again).toBeUndefined();
      expect(getSessionSpy).toHaveBeenCalledTimes(1);
    });

    it("asks storage about an unknown id again once the TTL has passed", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const getSessionSpy = vi.spyOn(storage, "getSession");

      await store.get("doesNotExist", T0_MS);
      await store.get("doesNotExist", T0_MS + UNKNOWN_ID_TTL_MS);

      expect(getSessionSpy).toHaveBeenCalledTimes(2);
    });

    it("forgets the oldest unknown id first once the cache is full", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      for (let i = 0; i < UNKNOWN_ID_CACHE_MAX_ENTRIES; i += 1) {
        await store.get(`unknown${i}`, T0_MS);
      }
      const getSessionSpy = vi.spyOn(storage, "getSession");

      // Remembering oneTooMany forgets unknown0; reading unknown0 again then forgets unknown1.
      await store.get("oneTooMany", T0_MS);
      await store.get("unknown0", T0_MS);
      await store.get("unknown2", T0_MS);

      expect(getSessionSpy.mock.calls.map(([id]) => id)).toEqual(["oneTooMany", "unknown0"]);
    });
  });

  describe("evict", () => {
    it("drops the cached copy so the next get reads storage again", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const created = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const getSessionSpy = vi.spyOn(storage, "getSession");

      const wasCached = store.evict(created.sessionId);
      const reloaded = await store.get(created.sessionId);

      expect(wasCached).toBe(true);
      expect(getSessionSpy).toHaveBeenCalledWith(created.sessionId);
      expect(reloaded).not.toBe(created);
      expect(reloaded?.sessionId).toBe(created.sessionId);
    });

    it("returns false for a session that was not in memory", async () => {
      const store = new SessionStore(new MemorySessionStorage());

      expect(store.evict("neverLoaded")).toBe(false);
    });
  });

  describe("delete", () => {
    it("removes the record and frames from storage and memory, and reports how many frames went", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(session, [makeSystemFrame(0), makeSystemFrame(1)]);

      const result = await store.delete(session);

      expect(result).toEqual({ sessionId: session.sessionId, frames: 2 });
      await expect(storage.getSession(session.sessionId)).resolves.toBeNull();
      await expect(storage.readFrames(session.sessionId)).resolves.toEqual([]);
      expect(store.stats().sessionsInMemory).toBe(0);
    });

    it("stops a running session first: closes its open events and tells subscribers it was deleted", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(session, highCpuFrames(31));
      const received: SessionEvent[] = [];
      store.subscribe(session, (event) => received.push(event));

      await store.delete(session, T0_MS + 40_000);

      expect(session.engine.events).toEqual([
        expect.objectContaining({ kind: "cpu.high", endedAt: T0_MS + 40_000 }),
      ]);
      expect(received.at(-1)).toEqual({
        type: "ended",
        summary: expect.objectContaining({ status: "ended", endedAt: T0_MS + 40_000 }),
        reason: "deleted",
      });
    });

    it("remembers the id as deleted, so the next get is answered from memory and says why", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const getSessionSpy = vi.spyOn(storage, "getSession");

      await store.delete(session, T0_MS);
      const found = await store.get(session.sessionId, T0_MS + 1);

      expect(found).toBeUndefined();
      expect(getSessionSpy).not.toHaveBeenCalled();
      expect(store.wasDeleted(session.sessionId, T0_MS + UNKNOWN_ID_TTL_MS - 1)).toBe(true);
      expect(store.wasDeleted(session.sessionId, T0_MS + UNKNOWN_ID_TTL_MS)).toBe(false);
    });

    it("reports an id that was never issued as unknown, not deleted", async () => {
      const store = new SessionStore(new MemorySessionStorage());

      await store.get("doesNotExist", T0_MS);

      expect(store.wasDeleted("doesNotExist", T0_MS + 1)).toBe(false);
    });

    it("waits for a frame write in flight so the batch cannot recreate the session's files", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const append = storage.appendFrames.bind(storage);
      vi.spyOn(storage, "appendFrames").mockImplementation(async (sessionId, frames) => {
        await gate;
        return append(sessionId, frames);
      });
      const ingesting = store.ingest(session, [makeSystemFrame(0)]);

      const deleting = store.delete(session);
      release();
      await ingesting;
      await deleting;

      await expect(storage.readFrames(session.sessionId)).resolves.toEqual([]);
    });

    it("deletes an already ended session without emitting a second end to anyone", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.end(session, T0_MS + 1_000);
      const received: SessionEvent[] = [];
      store.subscribe(session, (event) => received.push(event));

      await store.delete(session, T0_MS + 2_000);

      expect(session.endedAt).toBe(T0_MS + 1_000);
      expect(received).toEqual([
        {
          type: "ended",
          summary: expect.objectContaining({ endedAt: T0_MS + 1_000 }),
          reason: "deleted",
        },
      ]);
      await expect(storage.getSession(session.sessionId)).resolves.toBeNull();
    });
  });

  describe("ingest", () => {
    it("assigns session-wide indexes across streams in the order frames arrive", async () => {
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      const result = await store.ingest(session, [makeSystemFrame(0), makeRunFrame(0)]);

      expect(result.accepted.map((f) => f.index)).toEqual([1, 2]);
      expect(result.duplicates).toBe(0);
    });

    it("skips a frame whose sequence is at or below the latest seen for its stream and counts it", async () => {
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(session, [makeSystemFrame(0)]);

      const result = await store.ingest(session, [makeSystemFrame(0)]);

      expect(result).toEqual({ accepted: [], duplicates: 1 });
    });

    it("persists before advancing state, so a rejected write leaves the session untouched and a retry is accepted", async () => {
      const storage = new FlakyAppendStorage(new MemorySessionStorage());
      const store = new SessionStore(storage);
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const frames = [makeSystemFrame(0)];
      storage.failNextAppendOnce();

      await expect(store.ingest(session, frames)).rejects.toThrow("simulated write failure");
      expect(session.frames).toEqual([]);

      const retry = await store.ingest(session, frames);

      expect(retry.accepted).toHaveLength(1);
      expect(retry.duplicates).toBe(0);
    });

    it("emits frames and events to subscribers", async () => {
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const received: SessionEvent[] = [];
      store.subscribe(session, (event) => received.push(event));

      await store.ingest(session, highCpuFrames(31));

      const framesEvent = received.find((e) => e.type === "frames");
      const eventsEvent = received.find((e) => e.type === "events");
      expect(framesEvent?.type === "frames" && framesEvent.frames).toHaveLength(31);
      expect(eventsEvent?.type === "events" && eventsEvent.events).toEqual([
        expect.objectContaining({ kind: "cpu.high", endedAt: null }),
      ]);
    });

    it("throws TooManyFramesError once a session holds its maximum number of frames, and the client's retry is rejected too", async () => {
      const store = new SessionStore(new MemorySessionStorage(), {
        limits: { maxActiveSessions: 20, maxStreamsPerSession: 10, maxFramesPerSession: 3 },
      });
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(session, [makeSystemFrame(0), makeSystemFrame(1), makeSystemFrame(2)]);

      await expect(store.ingest(session, [makeSystemFrame(3)])).rejects.toThrow(TooManyFramesError);
      expect(session.frames).toHaveLength(3);
    });

    it("throws TooManyStreamsError when a batch would add more streams than the session's limit", async () => {
      const store = new SessionStore(new MemorySessionStorage(), {
        limits: { maxActiveSessions: 20, maxStreamsPerSession: 1, maxFramesPerSession: 15_000 },
      });
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(session, [makeSystemFrame(0)]);

      await expect(store.ingest(session, [makeRunFrame(0)])).rejects.toThrow(TooManyStreamsError);
      expect(session.frames).toHaveLength(1);
    });
  });

  describe("drainWrites", () => {
    it("resolves only once every pending append on every session has settled", async () => {
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const a = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const b = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const append = storage.appendFrames.bind(storage);
      vi.spyOn(storage, "appendFrames").mockImplementation(async (sessionId, frames) => {
        await gate;
        await append(sessionId, frames);
      });
      const ingests = [
        store.ingest(a, [makeSystemFrame(0)]),
        store.ingest(b, [makeSystemFrame(0)]),
      ];
      let drained = false;

      const drain = (async () => {
        await store.drainWrites();
        drained = true;
      })();
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      release();
      await drain;
      await Promise.all(ingests);

      expect(drained).toBe(true);
      await expect(storage.readFrames(a.sessionId)).resolves.toHaveLength(1);
      await expect(storage.readFrames(b.sessionId)).resolves.toHaveLength(1);
    });

    it("resolves at once when nothing is pending", async () => {
      const store = new SessionStore(new MemorySessionStorage());
      await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      await expect(store.drainWrites()).resolves.toBeUndefined();
    });
  });

  describe("end", () => {
    it("sets endedAt, persists it, closes open events, and emits ended", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage);
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(session, highCpuFrames(31));
      const received: SessionEvent[] = [];
      store.subscribe(session, (event) => received.push(event));
      vi.setSystemTime(T0_MS + 1000);

      await store.end(session);

      expect(session.endedAt).toBe(T0_MS + 1000);
      await expect(storage.getSession(session.sessionId)).resolves.toMatchObject({
        endedAt: T0_MS + 1000,
      });
      expect(session.engine.events).toEqual([
        expect.objectContaining({ kind: "cpu.high", endedAt: T0_MS + 1000 }),
      ]);
      expect(received).toContainEqual({
        type: "ended",
        summary: expect.objectContaining({ status: "ended", endedAt: T0_MS + 1000 }),
        reason: "ended",
      });
    });

    it("does nothing the second time a session is ended", async () => {
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.end(session);
      const endedAtFirst = session.endedAt;

      await store.end(session);

      expect(session.endedAt).toBe(endedAtFirst);
    });

    it("ends at the given moment when one is passed, closing events there too", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS + 120_000);
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(session, highCpuFrames(31));

      await store.end(session, T0_MS + 40_000);

      expect(session.endedAt).toBe(T0_MS + 40_000);
      expect(session.engine.events).toEqual([
        expect.objectContaining({ kind: "cpu.high", endedAt: T0_MS + 40_000 }),
      ]);
    });
  });

  describe("status and summary", () => {
    it("reports active for a session within its max duration", async () => {
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      expect(store.status(session)).toBe("active");
    });

    it("reports ended for a session that has been ended", async () => {
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      await store.end(session);

      expect(store.status(session)).toBe("ended");
    });

    it("reports expired for a session whose start is older than its max duration", async () => {
      const storage = new MemorySessionStorage();
      const oldStartedAt = Date.now() - (DEFAULT_MAX_SESSION_DURATION_SECONDS + 60) * 1000;
      const record: SessionRecord = {
        sessionId: "oldSession",
        ingestToken: "oldToken",
        host: makeHost(),
        clientVersion: "0.1.0",
        startedAt: oldStartedAt,
        endedAt: null,
        maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
        previousSessionId: null,
        nextSessionId: null,
      };
      await storage.putSession(record);
      const store = new SessionStore(storage);
      const loaded = await store.get(record.sessionId);

      expect(store.status(loaded!)).toBe("expired");
    });

    it("summarizes the stream count and the session's stream limit", async () => {
      const store = new SessionStore(new MemorySessionStorage(), {
        limits: { maxActiveSessions: 20, maxStreamsPerSession: 5, maxFramesPerSession: 15_000 },
      });
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      await store.ingest(session, [makeSystemFrame(0), makeRunFrame(0)]);

      expect(store.summary(session)).toMatchObject({ streamCount: 2, maxStreams: 5 });
    });
  });

  describe("activeSessionCount, hasCapacity, and stats", () => {
    it("counts only sessions that are still active", async () => {
      const store = new SessionStore(new MemorySessionStorage());
      await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const ended = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.end(ended);

      expect(store.activeSessionCount()).toBe(1);
    });

    it("hasCapacity is false once active sessions reach the configured limit", async () => {
      const store = new SessionStore(new MemorySessionStorage(), {
        limits: { maxActiveSessions: 1, maxStreamsPerSession: 10, maxFramesPerSession: 15_000 },
      });

      await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      expect(store.hasCapacity()).toBe(false);
    });

    it("hasCapacity is true while active sessions are under the limit", async () => {
      const store = new SessionStore(new MemorySessionStorage(), {
        limits: { maxActiveSessions: 2, maxStreamsPerSession: 10, maxFramesPerSession: 15_000 },
      });

      await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      expect(store.hasCapacity()).toBe(true);
    });

    it("reports session and frame totals", async () => {
      const store = new SessionStore(new MemorySessionStorage(), {
        limits: { maxActiveSessions: 5, maxStreamsPerSession: 10, maxFramesPerSession: 15_000 },
      });
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      await store.ingest(session, [makeSystemFrame(0), makeSystemFrame(1, { sequence: 2 })]);

      expect(store.stats()).toEqual({
        activeSessions: 1,
        maxActiveSessions: 5,
        maxStreamsPerSession: 10,
        sessionsInMemory: 1,
        framesInMemory: 2,
      });
    });
  });

  describe("tick", () => {
    it("runs time-based rules for active sessions, opening a client.stale event after a silent gap", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(session, [makeSystemFrame(0)]);

      vi.setSystemTime(T0_MS + 90_000);
      await store.tick(Date.now());

      expect(session.engine.events).toEqual([
        expect.objectContaining({
          kind: "client.stale",
          startedAt: T0_MS + 60_000,
          endedAt: null,
        }),
      ]);
    });

    it("ends a session silent for longer than endAfterSilentMs at the newest frame's receipt plus the silence, persisted, with ended emitted", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const storage = new MemorySessionStorage();
      const store = new SessionStore(storage, { endAfterSilentMs: 600_000 });
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      vi.setSystemTime(T0_MS + 5_000);
      await store.ingest(session, [makeSystemFrame(5)]);
      const received: SessionEvent[] = [];
      store.subscribe(session, (event) => received.push(event));
      // The early warning opens on a tick well before the end.
      vi.setSystemTime(T0_MS + 95_000);
      await store.tick(Date.now());

      vi.setSystemTime(T0_MS + 5_000 + 600_001);
      await store.tick(Date.now());

      expect(store.summary(session)).toMatchObject({ status: "ended", endedAt: T0_MS + 605_000 });
      await expect(storage.getSession(session.sessionId)).resolves.toMatchObject({
        endedAt: T0_MS + 605_000,
      });
      expect(received).toContainEqual({
        type: "ended",
        summary: expect.objectContaining({ status: "ended", endedAt: T0_MS + 605_000 }),
        reason: "ended",
      });
      // The early warning is closed at the same moment the session ends.
      expect(session.engine.events).toEqual([
        expect.objectContaining({ kind: "client.stale", endedAt: T0_MS + 605_000 }),
      ]);
    });

    it("keeps a session that has been silent for exactly the limit, still warning through client.stale", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const store = new SessionStore(new MemorySessionStorage(), { endAfterSilentMs: 600_000 });
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(session, [makeSystemFrame(0)]);

      vi.setSystemTime(T0_MS + 600_000);
      await store.tick(Date.now());

      expect(store.status(session)).toBe("active");
      expect(session.engine.events).toEqual([
        expect.objectContaining({ kind: "client.stale", endedAt: null }),
      ]);
    });

    it("counts the silence of a session that never sent a frame from its start", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const store = new SessionStore(new MemorySessionStorage(), { endAfterSilentMs: 600_000 });
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });

      vi.setSystemTime(T0_MS + 600_001);
      await store.tick(Date.now());

      expect(store.summary(session)).toMatchObject({ status: "ended", endedAt: T0_MS + 600_000 });
    });

    it("measures silence on the server clock, so a frame with an old client timestamp keeps the session alive", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS + 3_600_000);
      const store = new SessionStore(new MemorySessionStorage(), { endAfterSilentMs: 600_000 });
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      // Client clock an hour behind: the frame says T0 but arrives now.
      await store.ingest(session, [makeSystemFrame(0)]);

      vi.setSystemTime(T0_MS + 3_600_000 + 1_000);
      await store.tick(Date.now());

      expect(store.status(session)).toBe("active");
    });

    it("uses ten minutes of silence by default", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.ingest(session, [makeSystemFrame(0)]);

      vi.setSystemTime(T0_MS + DEFAULT_STORE_OPTIONS.endAfterSilentMs);
      await store.tick(Date.now());
      const stillActive = store.status(session);
      vi.setSystemTime(T0_MS + DEFAULT_STORE_OPTIONS.endAfterSilentMs + 1);
      await store.tick(Date.now());

      expect(stillActive).toBe("active");
      expect(store.status(session)).toBe("ended");
    });

    it("evicts an ended session with no listeners after the configured idle window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const store = new SessionStore(new MemorySessionStorage(), { evictEndedAfterMs: 1_000 });
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.end(session);

      vi.setSystemTime(T0_MS + 1_001);
      await store.tick(Date.now());

      expect(store.stats().sessionsInMemory).toBe(0);
    });

    it("keeps an ended session in memory until the default idle window has passed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      await store.end(session);

      vi.setSystemTime(T0_MS + DEFAULT_STORE_OPTIONS.evictEndedAfterMs);
      await store.tick(Date.now());

      expect(store.stats().sessionsInMemory).toBe(1);
    });

    it("keeps an ended session with a subscriber past the eviction window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0_MS);
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      store.subscribe(session, () => {});
      await store.end(session);

      vi.setSystemTime(T0_MS + DEFAULT_STORE_OPTIONS.evictEndedAfterMs + 1);
      await store.tick(Date.now());

      expect(store.stats().sessionsInMemory).toBe(1);
    });
  });

  describe("subscribe", () => {
    it("returns a function that stops further delivery to the listener", async () => {
      const store = new SessionStore(new MemorySessionStorage());
      const session = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
      const received: SessionEvent[] = [];
      const unsubscribe = store.subscribe(session, (event) => received.push(event));

      unsubscribe();
      await store.ingest(session, [makeSystemFrame(0)]);

      expect(received).toEqual([]);
    });
  });
});

describe("sessionStatus and sessionEndMs", () => {
  const record: SessionRecord = {
    sessionId: "record1",
    ingestToken: "token1",
    host: makeHost(),
    clientVersion: "0.1.0",
    startedAt: T0_MS,
    endedAt: null,
    maxDurationSeconds: 60,
    previousSessionId: null,
    nextSessionId: null,
  };

  it("reports active up to the cap and expired one millisecond past it", () => {
    expect(sessionStatus(record, T0_MS + 60_000)).toBe("active");
    expect(sessionStatus(record, T0_MS + 60_001)).toBe("expired");
  });

  it("reports ended whenever endedAt is set, even before the cap", () => {
    expect(sessionStatus({ ...record, endedAt: T0_MS + 5_000 }, T0_MS + 6_000)).toBe("ended");
  });

  it("ends at endedAt when set, otherwise at the cap", () => {
    expect(sessionEndMs({ ...record, endedAt: T0_MS + 5_000 })).toBe(T0_MS + 5_000);
    expect(sessionEndMs(record)).toBe(T0_MS + 60_000);
  });
});
