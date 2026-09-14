import { S3Client } from "@aws-sdk/client-s3";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { T0_MS, makeHost, makeStoredFrames, makeSystemFrame } from "@afk/shared/testing";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { READ_CONCURRENCY, S3SessionStorage } from "./s3-storage.ts";
import type { SessionRecord } from "./storage.ts";

/**
 * S3SessionStorage constructs its own S3Client internally (it takes bucket/region/
 * credentials, not a client instance), so the fake is wired in by spying on
 * S3Client.prototype.send rather than injecting a client. Small enough page size
 * (2 keys) to force real pagination in the list-based tests below.
 */
const PAGE_SIZE = 2;

function commandName(command: unknown): string {
  return (command as { constructor: { name: string } }).constructor.name;
}

/** Awaited before a GET is served, so a test can observe or delay individual fetches. */
type GetGate = (key: string) => Promise<void>;

/** Lets every fetch started so far run before continuing, without a real wait. */
const yieldToOthers = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A tiny in-memory stand-in for a bucket, keyed by object key. */
function installFakeS3(objects: Map<string, string>, beforeGet?: GetGate) {
  return vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
    const input = (command as { input: Record<string, unknown> }).input;
    switch (commandName(command)) {
      case "PutObjectCommand": {
        objects.set(input.Key as string, input.Body as string);
        return {};
      }
      case "GetObjectCommand": {
        await beforeGet?.(input.Key as string);
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
        throw new Error(`fake S3: unhandled command ${commandName(command)}`);
    }
  });
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "session1",
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

function makeStorage(objects: Map<string, string>, beforeGet?: GetGate): S3SessionStorage {
  installFakeS3(objects, beforeGet);
  return new S3SessionStorage({
    bucket: "test-bucket",
    region: "us-east-1",
    accessKeyId: "key",
    secretAccessKey: "secret",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("S3SessionStorage", () => {
  it("putSession writes sessions/<id>/session.json", async () => {
    const objects = new Map<string, string>();
    const storage = makeStorage(objects);
    const record = makeRecord();

    await storage.putSession(record);

    expect(JSON.parse(objects.get("sessions/session1/session.json")!)).toEqual(record);
  });

  it("appendFrames writes one object per batch keyed by the zero-padded first index", async () => {
    const objects = new Map<string, string>();
    const storage = makeStorage(objects);
    const frames = makeStoredFrames([makeSystemFrame(4, { sequence: 5 })]).map((f) => ({
      ...f,
      index: 5,
    }));

    await storage.appendFrames("session1", frames);

    expect(objects.has("sessions/session1/frames/0000000005.ndjson")).toBe(true);
  });

  it("readFrames concatenates in key order across pages", async () => {
    const objects = new Map<string, string>();
    const storage = makeStorage(objects);
    const frames = makeStoredFrames([
      makeSystemFrame(0),
      makeSystemFrame(1, { sequence: 2 }),
      makeSystemFrame(2, { sequence: 3 }),
    ]);

    // Three separate batches -> three objects -> at least two list pages at PAGE_SIZE=2.
    await storage.appendFrames("session1", [frames[0]!]);
    await storage.appendFrames("session1", [frames[1]!]);
    await storage.appendFrames("session1", [frames[2]!]);

    await expect(storage.readFrames("session1")).resolves.toEqual(frames);
  });

  it("readFrames fetches READ_CONCURRENCY objects at a time rather than one after another", async () => {
    // A session with more objects than the limit: one batch object per frame, the way
    // the client's one-batch-a-second sender lays a session out in the bucket.
    const objects = new Map<string, string>();
    let inFlight = 0;
    let peakInFlight = 0;
    const storage = makeStorage(objects, async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await yieldToOthers();
      inFlight--;
    });
    const frames = makeStoredFrames(
      Array.from({ length: READ_CONCURRENCY * 2 + 3 }, (_, i) =>
        makeSystemFrame(i, { sequence: i + 1 }),
      ),
    );
    for (const frame of frames) {
      await storage.appendFrames("session1", [frame]);
    }

    const read = await storage.readFrames("session1");

    expect(read).toEqual(frames);
    expect(peakInFlight).toBe(READ_CONCURRENCY);
  });

  it("readFrames keeps index order when an earlier object arrives after later ones", async () => {
    const objects = new Map<string, string>();
    const storage = makeStorage(objects, async (key) => {
      if (key.endsWith("/0000000001.ndjson")) {
        await yieldToOthers();
        await yieldToOthers();
      }
    });
    const frames = makeStoredFrames([
      makeSystemFrame(0),
      makeSystemFrame(1, { sequence: 2 }),
      makeSystemFrame(2, { sequence: 3 }),
    ]);
    for (const frame of frames) {
      await storage.appendFrames("session1", [frame]);
    }

    await expect(storage.readFrames("session1")).resolves.toEqual(frames);
  });

  it("readFrames skips an object deleted between the listing and its fetch", async () => {
    const objects = new Map<string, string>();
    const storage = makeStorage(objects, async (key) => {
      if (key.endsWith("/0000000002.ndjson")) {
        objects.delete(key);
      }
    });
    const frames = makeStoredFrames([
      makeSystemFrame(0),
      makeSystemFrame(1, { sequence: 2 }),
      makeSystemFrame(2, { sequence: 3 }),
    ]);
    for (const frame of frames) {
      await storage.appendFrames("session1", [frame]);
    }

    await expect(storage.readFrames("session1")).resolves.toEqual([frames[0], frames[2]]);
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
    const storage = makeStorage(objects);
    await storage.putSession(makeRecord({ sessionId: "sessionA" }));
    await storage.appendFrames("sessionA", makeStoredFrames([makeSystemFrame(0)]));
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
      await expect(storage.getSession("session1")).rejects.toMatchObject({
        name: "TimeoutError",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
