import { S3Client } from "@aws-sdk/client-s3";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { T0_MS, makeHost, makeStoredFrames, makeSystemFrame } from "@afk/shared/testing";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS, type StoredFrame } from "@afk/shared";
import { log } from "../log/logger.ts";
import {
  DEFAULT_SLAB_FLUSH_INTERVAL_MS,
  DEFAULT_SLAB_MAX_FRAMES,
  READ_CONCURRENCY,
  S3SessionStorage,
  type S3StorageOptions,
} from "./s3-storage.ts";
import type { SessionRecord } from "./storage.ts";

/**
 * S3SessionStorage constructs its own S3Client internally (it takes bucket/region/
 * credentials, not a client instance), so the fake is wired in by spying on
 * S3Client.prototype.send rather than injecting a client. Small enough page size
 * (2 keys) to force real pagination in the list-based tests below.
 */
const PAGE_SIZE = 2;

const SESSION_ID = "session1";
const PARTS_PREFIX = `sessions/${SESSION_ID}/frames/`;
const COMPACTED_KEY = `sessions/${SESSION_ID}/frames.ndjson`;

function commandName(command: unknown): string {
  return (command as { constructor: { name: string } }).constructor.name;
}

/** Awaited before a GET or PUT is served, so a test can observe or delay individual requests. */
type RequestGate = (key: string) => Promise<void>;

interface FakeS3Options {
  beforeGet?: RequestGate;
  beforePut?: RequestGate;
  /** Commands (by class name) the fake rejects, until the test removes them from the set. */
  failing?: Set<string>;
}

/** Lets every fetch started so far run before continuing, without a real wait. */
const yieldToOthers = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A tiny in-memory stand-in for a bucket, keyed by object key. */
function installFakeS3(objects: Map<string, string>, options: FakeS3Options = {}) {
  return vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (options.failing?.has(name)) {
      throw new Error(`fake S3: ${name} is failing`);
    }
    const input = (command as { input: Record<string, unknown> }).input;
    switch (name) {
      case "PutObjectCommand": {
        await options.beforePut?.(input.Key as string);
        objects.set(input.Key as string, input.Body as string);
        return {};
      }
      case "GetObjectCommand": {
        await options.beforeGet?.(input.Key as string);
        const body = objects.get(input.Key as string);
        if (body === undefined) {
          throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        }
        return { Body: { transformToString: async () => body } };
      }
      case "ListObjectsV2Command": {
        const prefix = (input.Prefix as string | undefined) ?? "";
        const delimiter = input.Delimiter as string | undefined;
        const allKeys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
        const page = allKeys.slice(start, start + PAGE_SIZE);
        const isTruncated = start + PAGE_SIZE < allKeys.length;
        const nextToken = isTruncated ? String(start + PAGE_SIZE) : undefined;
        if (delimiter !== undefined) {
          const prefixes = new Set<string>();
          for (const key of page) {
            const rest = key.slice(prefix.length);
            const cut = rest.indexOf(delimiter);
            if (cut >= 0) {
              prefixes.add(prefix + rest.slice(0, cut + 1));
            }
          }
          return {
            CommonPrefixes: [...prefixes].map((Prefix) => ({ Prefix })),
            IsTruncated: isTruncated,
            NextContinuationToken: nextToken,
          };
        }
        return {
          Contents: page.map((Key) => ({ Key })),
          IsTruncated: isTruncated,
          NextContinuationToken: nextToken,
        };
      }
      case "DeleteObjectsCommand": {
        const deleteInput = input as { Delete: { Objects: { Key: string }[] } };
        for (const object of deleteInput.Delete.Objects) {
          objects.delete(object.Key);
        }
        return {};
      }
      default:
        throw new Error(`fake S3: unhandled command ${name}`);
    }
  });
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: SESSION_ID,
    ingestToken: "token1",
    host: makeHost(),
    clientVersion: "0.1.0",
    startedAt: T0_MS,
    endedAt: null,
    maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
    previousSessionId: null,
    nextSessionId: null,
    ...overrides,
  };
}

/** Storage over the fake bucket; slab bounds default to the production values. */
function makeStorage(
  objects: Map<string, string>,
  options: FakeS3Options & Pick<S3StorageOptions, "slabMaxFrames" | "slabFlushIntervalMs"> = {},
): S3SessionStorage {
  installFakeS3(objects, options);
  return new S3SessionStorage({
    bucket: "test-bucket",
    region: "us-east-1",
    accessKeyId: "key",
    secretAccessKey: "secret",
    slabMaxFrames: options.slabMaxFrames,
    slabFlushIntervalMs: options.slabFlushIntervalMs,
  });
}

/** `count` stored system frames with consecutive indexes and sequences from 1. */
function frames(count: number): StoredFrame[] {
  return makeStoredFrames(
    Array.from({ length: count }, (_, i) => makeSystemFrame(i, { sequence: i + 1 })),
  );
}

function ndjson(stored: readonly StoredFrame[]): string {
  return stored.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
}

/** The frames an NDJSON object holds, for comparing content that has been through the parser. */
function parseNdjson(text: string | undefined): unknown[] {
  return (text ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function partKeys(objects: Map<string, string>): string[] {
  return [...objects.keys()].filter((key) => key.startsWith(PARTS_PREFIX)).sort();
}

beforeEach(() => {
  // Slab writes and compactions log at info, flush failures at warn; keep the suite quiet.
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("S3SessionStorage", () => {
  it("putSession writes sessions/<id>/session.json", async () => {
    const objects = new Map<string, string>();
    const storage = makeStorage(objects);
    const record = makeRecord();

    await storage.putSession(record);

    expect(JSON.parse(objects.get(`sessions/${SESSION_ID}/session.json`)!)).toEqual(record);
  });

  describe("slabs", () => {
    it("writes a slab keyed by the zero-padded index of its first frame once the buffer holds the maximum", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects, { slabMaxFrames: 3 });
      const stored = frames(3).map((frame) => ({ ...frame, index: frame.index + 4 }));

      await storage.appendFrames(SESSION_ID, stored.slice(0, 2));
      expect(objects.size).toBe(0);
      await storage.appendFrames(SESSION_ID, stored.slice(2));

      expect([...objects.entries()]).toEqual([
        [`${PARTS_PREFIX}0000000005.ndjson`, ndjson(stored)],
      ]);
    });

    it("writes a slab when the flush interval passes with fewer frames than the maximum", async () => {
      vi.useFakeTimers();
      const objects = new Map<string, string>();
      const storage = makeStorage(objects);
      const stored = frames(2);

      await storage.appendFrames(SESSION_ID, [stored[0]!]);
      await vi.advanceTimersByTimeAsync(DEFAULT_SLAB_FLUSH_INTERVAL_MS - 1);
      await storage.appendFrames(SESSION_ID, [stored[1]!]);
      expect(objects.size).toBe(0);
      await vi.advanceTimersByTimeAsync(1);

      expect([...objects.entries()]).toEqual([
        [`${PARTS_PREFIX}0000000001.ndjson`, ndjson(stored)],
      ]);
    });

    it("writes a slab per session as each session's own interval passes", async () => {
      vi.useFakeTimers();
      const objects = new Map<string, string>();
      const storage = makeStorage(objects, { slabFlushIntervalMs: 1_000 });

      await storage.appendFrames("sessionA", frames(1));
      await vi.advanceTimersByTimeAsync(500);
      await storage.appendFrames("sessionB", frames(1));
      await vi.advanceTimersByTimeAsync(500);
      expect([...objects.keys()]).toEqual(["sessions/sessionA/frames/0000000001.ndjson"]);
      await vi.advanceTimersByTimeAsync(500);

      expect([...objects.keys()].sort()).toEqual([
        "sessions/sessionA/frames/0000000001.ndjson",
        "sessions/sessionB/frames/0000000001.ndjson",
      ]);
    });

    it("uses the production bounds when none are given", () => {
      expect(DEFAULT_SLAB_FLUSH_INTERVAL_MS).toBe(60_000);
      expect(DEFAULT_SLAB_MAX_FRAMES).toBe(100);
    });

    it("flush writes every session's buffer, as shutdown needs", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects);
      await storage.appendFrames("sessionA", frames(2));
      await storage.appendFrames("sessionB", frames(1));
      expect(objects.size).toBe(0);

      await storage.flush();

      expect([...objects.keys()].sort()).toEqual([
        "sessions/sessionA/frames/0000000001.ndjson",
        "sessions/sessionB/frames/0000000001.ndjson",
      ]);
      expect(objects.get("sessions/sessionA/frames/0000000001.ndjson")).toBe(ndjson(frames(2)));
    });

    it("flush tries every session and then rejects if any of them failed", async () => {
      const objects = new Map<string, string>();
      const failing = new Set<string>();
      const storage = makeStorage(objects, { failing });
      await storage.appendFrames("sessionA", frames(1));
      await storage.appendFrames("sessionB", frames(1));
      failing.add("PutObjectCommand");

      await expect(storage.flush()).rejects.toThrow("2 of 2 slab flushes failed");

      failing.clear();
      await storage.flush();
      expect(objects.size).toBe(2);
    });

    it("readFrames from the writing process sees frames that are still buffered", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects);
      const stored = frames(3);
      await storage.appendFrames(SESSION_ID, stored.slice(0, 2));
      await storage.appendFrames(SESSION_ID, stored.slice(2));

      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual(stored);
      expect(objects.get(`${PARTS_PREFIX}0000000001.ndjson`)).toBe(ndjson(stored));
    });

    it("keeps a slab that failed to write and retries it on the next append, which reports the failure", async () => {
      const objects = new Map<string, string>();
      const failing = new Set<string>();
      const storage = makeStorage(objects, { failing, slabMaxFrames: 2 });
      const stored = frames(3);
      failing.add("PutObjectCommand");

      // The full buffer's own write fails, but these frames are already accepted.
      await expect(storage.appendFrames(SESSION_ID, stored.slice(0, 2))).resolves.toBeUndefined();
      // The next append retries the slab first and reports its failure; its frames
      // are not buffered, so the client's retry of them is not a duplicate.
      await expect(storage.appendFrames(SESSION_ID, stored.slice(2))).rejects.toThrow(
        "PutObjectCommand is failing",
      );
      expect(objects.size).toBe(0);
      failing.clear();
      await storage.appendFrames(SESSION_ID, stored.slice(2));

      expect(objects.get(`${PARTS_PREFIX}0000000001.ndjson`)).toBe(ndjson(stored.slice(0, 2)));
      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual(stored);
    });

    it("retries a failed slab on the next interval without waiting for an append", async () => {
      vi.useFakeTimers();
      const objects = new Map<string, string>();
      const failing = new Set<string>();
      const storage = makeStorage(objects, { failing, slabFlushIntervalMs: 1_000 });
      await storage.appendFrames(SESSION_ID, frames(1));
      failing.add("PutObjectCommand");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(objects.size).toBe(0);

      failing.clear();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(objects.get(`${PARTS_PREFIX}0000000001.ndjson`)).toBe(ndjson(frames(1)));
    });

    it("appends that arrive during a slab write go into the next slab", async () => {
      const objects = new Map<string, string>();
      let releasePut: (() => void) | undefined;
      const storage = makeStorage(objects, {
        slabMaxFrames: 2,
        // The first slab write hangs until the test lets it through.
        beforePut: async () => {
          if (releasePut === undefined) {
            await new Promise<void>((resolve) => {
              releasePut = resolve;
            });
          }
        },
      });
      const stored = frames(3);

      const first = storage.appendFrames(SESSION_ID, stored.slice(0, 2));
      await yieldToOthers();
      await storage.appendFrames(SESSION_ID, stored.slice(2));
      expect(objects.size).toBe(0);
      releasePut!();
      await first;
      await storage.flush();

      expect(objects.get(`${PARTS_PREFIX}0000000001.ndjson`)).toBe(ndjson(stored.slice(0, 2)));
      expect(objects.get(`${PARTS_PREFIX}0000000003.ndjson`)).toBe(ndjson(stored.slice(2)));
    });

    it("drops a deleted session's buffer so no slab is written for it later", async () => {
      vi.useFakeTimers();
      const objects = new Map<string, string>();
      const storage = makeStorage(objects, { slabFlushIntervalMs: 1_000 });
      await storage.putSession(makeRecord());
      await storage.appendFrames(SESSION_ID, frames(1));

      await storage.deleteSession(SESSION_ID);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(objects.size).toBe(0);
    });
  });

  describe("readFrames", () => {
    it("concatenates parts in key order across list pages", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects, { slabMaxFrames: 1 });
      const stored = frames(3);

      // Three slabs of one frame -> three objects -> at least two list pages at PAGE_SIZE=2.
      for (const frame of stored) {
        await storage.appendFrames(SESSION_ID, [frame]);
      }

      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual(stored);
    });

    it("reads parts written one per batch before slabs existed, and slabs, in index order", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects, { slabMaxFrames: 100 });
      const stored = frames(12);
      // The old layout: one object per ingested batch, one frame each.
      for (const frame of stored.slice(0, 9)) {
        objects.set(
          `${PARTS_PREFIX}${String(frame.index).padStart(10, "0")}.ndjson`,
          ndjson([frame]),
        );
      }
      // Then this server takes over and writes a slab of the rest.
      await storage.appendFrames(SESSION_ID, stored.slice(9));

      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual(stored);
      expect(partKeys(objects).at(-1)).toBe(`${PARTS_PREFIX}0000000010.ndjson`);
    });

    it("fetches READ_CONCURRENCY parts at a time rather than one after another", async () => {
      // A session with more parts than the limit: one per frame, the way sessions
      // written before slabs existed are laid out in the bucket.
      const objects = new Map<string, string>();
      let inFlight = 0;
      let peakInFlight = 0;
      const storage = makeStorage(objects, {
        slabMaxFrames: 1,
        beforeGet: async () => {
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await yieldToOthers();
          inFlight--;
        },
      });
      const stored = frames(READ_CONCURRENCY * 2 + 3);
      for (const frame of stored) {
        await storage.appendFrames(SESSION_ID, [frame]);
      }

      const read = await storage.readFrames(SESSION_ID);

      expect(read).toEqual(stored);
      expect(peakInFlight).toBe(READ_CONCURRENCY);
    });

    it("keeps index order when an earlier part arrives after later ones", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects, {
        slabMaxFrames: 1,
        beforeGet: async (key) => {
          if (key.endsWith("/0000000001.ndjson")) {
            await yieldToOthers();
            await yieldToOthers();
          }
        },
      });
      const stored = frames(3);
      for (const frame of stored) {
        await storage.appendFrames(SESSION_ID, [frame]);
      }

      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual(stored);
    });

    it("skips a part deleted between the listing and its fetch", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects, {
        slabMaxFrames: 1,
        beforeGet: async (key) => {
          if (key.endsWith("/0000000002.ndjson")) {
            objects.delete(key);
          }
        },
      });
      const stored = frames(3);
      for (const frame of stored) {
        await storage.appendFrames(SESSION_ID, [frame]);
      }

      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual([stored[0], stored[2]]);
    });

    it("prefers the compacted object over parts that are still present", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects);
      const stored = frames(3);
      objects.set(COMPACTED_KEY, ndjson(stored));
      // A stale part that disagrees, to prove which one is read.
      objects.set(`${PARTS_PREFIX}0000000001.ndjson`, ndjson([stored[0]!]));

      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual(stored);
    });

    it("returns nothing for a session with no frames in either layout", async () => {
      const storage = makeStorage(new Map());

      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual([]);
    });
  });

  describe("compactSession", () => {
    it("writes the given frames as one object and deletes the parts", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects, { slabMaxFrames: 2 });
      const stored = frames(5);
      const info = vi.spyOn(log, "info");
      for (const frame of stored) {
        await storage.appendFrames(SESSION_ID, [frame]);
      }
      expect(partKeys(objects)).toHaveLength(2); // the fifth frame is still buffered

      await expect(storage.compactSession(SESSION_ID, stored)).resolves.toBe(true);

      expect([...objects.entries()]).toEqual([[COMPACTED_KEY, ndjson(stored)]]);
      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual(stored);
      expect(info).toHaveBeenCalledWith("compacted", {
        session: SESSION_ID,
        frames: 5,
        objects: 3,
        ms: expect.any(Number),
      });
    });

    it("reads the parts back when the caller has no frames to give, as the sweeper does", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects, { slabMaxFrames: 1 });
      const stored = frames(3);
      for (const frame of stored) {
        await storage.appendFrames(SESSION_ID, [frame]);
      }

      await expect(storage.compactSession(SESSION_ID)).resolves.toBe(true);

      expect([...objects.keys()]).toEqual([COMPACTED_KEY]);
      expect(parseNdjson(objects.get(COMPACTED_KEY))).toEqual(stored);
    });

    it("does nothing for a session that is already compact, or has no frames", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects, { slabMaxFrames: 1 });
      const stored = frames(2);
      await storage.appendFrames(SESSION_ID, stored);
      await storage.compactSession(SESSION_ID, stored);
      const send = S3Client.prototype.send as ReturnType<typeof vi.fn>;
      send.mockClear();

      await expect(storage.compactSession(SESSION_ID, stored)).resolves.toBe(false);
      await expect(storage.compactSession("neverWritten")).resolves.toBe(false);

      expect(send.mock.calls.map(([command]) => commandName(command))).toEqual([
        "ListObjectsV2Command",
        "ListObjectsV2Command",
      ]);
      expect([...objects.entries()]).toEqual([[COMPACTED_KEY, ndjson(stored)]]);
    });

    it("leaves a readable session when the delete step fails, and finishes on the next attempt", async () => {
      const objects = new Map<string, string>();
      const failing = new Set<string>();
      const storage = makeStorage(objects, { failing, slabMaxFrames: 1 });
      const stored = frames(3);
      for (const frame of stored) {
        await storage.appendFrames(SESSION_ID, [frame]);
      }
      failing.add("DeleteObjectsCommand");

      await expect(storage.compactSession(SESSION_ID, stored)).rejects.toThrow(
        "DeleteObjectsCommand is failing",
      );

      // Half finished: both layouts present, and the read is still right.
      expect(objects.has(COMPACTED_KEY)).toBe(true);
      expect(partKeys(objects)).toHaveLength(3);
      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual(stored);

      failing.clear();
      await expect(storage.compactSession(SESSION_ID)).resolves.toBe(true);
      expect([...objects.keys()]).toEqual([COMPACTED_KEY]);
      expect(parseNdjson(objects.get(COMPACTED_KEY))).toEqual(stored);
    });

    it("leaves the parts alone when writing the compacted object fails", async () => {
      const objects = new Map<string, string>();
      const failing = new Set<string>();
      const storage = makeStorage(objects, { failing, slabMaxFrames: 1 });
      const stored = frames(2);
      for (const frame of stored) {
        await storage.appendFrames(SESSION_ID, [frame]);
      }
      failing.add("PutObjectCommand");

      await expect(storage.compactSession(SESSION_ID, stored)).rejects.toThrow(
        "PutObjectCommand is failing",
      );

      expect(objects.has(COMPACTED_KEY)).toBe(false);
      expect(partKeys(objects)).toHaveLength(2);
      await expect(storage.readFrames(SESSION_ID)).resolves.toEqual(stored);
    });

    it("deletes the parts in batches of at most 1000 keys", async () => {
      const objects = new Map<string, string>();
      const storage = makeStorage(objects);
      const stored = frames(2_001);
      for (const frame of stored) {
        objects.set(
          `${PARTS_PREFIX}${String(frame.index).padStart(10, "0")}.ndjson`,
          ndjson([frame]),
        );
      }
      const send = S3Client.prototype.send as ReturnType<typeof vi.fn>;

      await storage.compactSession(SESSION_ID, stored);

      const deleteSizes = send.mock.calls
        .map(([command]) => command as { input: { Delete?: { Objects: unknown[] } } })
        .filter((command) => command.input.Delete !== undefined)
        .map((command) => command.input.Delete!.Objects.length);
      expect(deleteSizes).toEqual([1000, 1000, 1]);
      expect([...objects.keys()]).toEqual([COMPACTED_KEY]);
    });
  });

  it("listSessionIds derives ids from common prefixes across pages", async () => {
    const objects = new Map<string, string>();
    const storage = makeStorage(objects);
    await storage.putSession(makeRecord({ sessionId: "sessionA" }));
    await storage.putSession(makeRecord({ sessionId: "sessionB" }));
    await storage.putSession(makeRecord({ sessionId: "sessionC" }));

    const ids = await storage.listSessionIds();

    expect(ids.sort()).toEqual(["sessionA", "sessionB", "sessionC"]);
  });

  it("deleteSession deletes every key under the session's prefix", async () => {
    const objects = new Map<string, string>();
    const storage = makeStorage(objects, { slabMaxFrames: 1 });
    await storage.putSession(makeRecord({ sessionId: "sessionA" }));
    await storage.appendFrames("sessionA", frames(1));
    await storage.putSession(makeRecord({ sessionId: "sessionB" }));

    await storage.deleteSession("sessionA");

    expect([...objects.keys()].some((key) => key.startsWith("sessions/sessionA/"))).toBe(false);
    await expect(storage.getSession("sessionB")).resolves.not.toBeNull();
  });

  it("gives up on a bucket that accepts the connection but never answers", async () => {
    // A real loopback socket, not the fake: the timeout lives in the SDK's HTTP
    // handler, below anything a stubbed `send` would exercise.
    const server = createServer(() => {
      // Never respond.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const storage = new S3SessionStorage({
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${port}`,
      accessKeyId: "key",
      secretAccessKey: "secret",
      requestTimeoutMs: 50,
    });

    try {
      await expect(storage.getSession(SESSION_ID)).rejects.toMatchObject({
        name: "TimeoutError",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
