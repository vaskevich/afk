import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { StoredFrame } from "@afk/shared";
import { log } from "../log/logger.ts";
import { mapWithConcurrency } from "../utils/concurrency.ts";
import { SerialQueue } from "../utils/serial-queue.ts";
import { SessionRecord, parseStoredFrameLine, type SessionStorage } from "./storage.ts";

const SESSION_KEY = "session.json";
/** One object holding every frame of a session, written by `compactSession`. */
const COMPACTED_FRAMES_KEY = "frames.ndjson";
/** Where the slabs (and the one-object-per-batch parts of older sessions) live. */
const FRAME_PARTS_PREFIX = "frames/";
/** Slab keys are the index of their first frame, zero padded to this many digits. */
const FRAME_INDEX_WIDTH = 10;
const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/** Session ids are server-generated base62, but never trust a path segment blindly. */
const SAFE_ID = /^[A-Za-z0-9]+$/;

/** S3 caps a single DeleteObjects call at 1000 keys. */
const DELETE_BATCH_SIZE = 1000;

/**
 * How long frames may wait in a session's buffer before they are written as a slab,
 * and how many frames a buffer holds before it is written regardless of the timer.
 * The client sends about one frame a second, so the defaults make a slab about a
 * minute of a session (the timer fires first) and cap it at 100 frames for a client
 * that sends more: a one-hour session is about 60 slab objects until it is compacted
 * into one, instead of the ~3,600 objects of one object per batch. The interval is
 * also the durability window: a hard crash (not a graceful shutdown, which flushes)
 * loses at most this much of each live session. See the 2026-09-14 entries in the
 * decision log of docs/ARCHITECTURE.md.
 */
export const DEFAULT_SLAB_FLUSH_INTERVAL_MS = 60_000;
export const DEFAULT_SLAB_MAX_FRAMES = 100;

/**
 * How many frame objects `readFrames` fetches at once when a session is still in
 * parts (not yet compacted, or written before slabs existed as one object per batch).
 * The round trips dominate: fetched one at a time at ~14 ms each, the 2,798 objects of
 * a real session took 40 s to load on 2026-09-14 (the first dashboard visit after the
 * cache had let the session go). Sixteen in flight brings that to about 3 s, stays
 * well inside the SDK's socket pool (50 per host), and buffers at most sixteen objects.
 */
export const READ_CONCURRENCY = 16;

/**
 * How long one bucket request may take before the SDK gives up on it, and how long
 * opening its connection may take. The SDK's own defaults are no request timeout at
 * all, so a hung request would hold its caller forever: a stuck slab write holds every
 * later flush and the compaction of that session, a read blocks the coalesced load
 * every dashboard visitor is waiting on. A slab is at most a minute of frames and the
 * compacted object a few MB, so anything past a few seconds is a fault, not a slow
 * transfer.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 3_000;
/**
 * Attempts per request, including the first. The SDK's default is three; two keeps a
 * dead bucket from tying a caller up for three timeouts when a slab that failed to
 * write is kept and retried on the next flush anyway.
 */
export const MAX_ATTEMPTS = 2;

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Override for S3-compatible stores (MinIO, etc). Lightsail buckets use the standard
   * regional S3 endpoint, so this is normally left unset. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Slab bounds; `AFK_S3_SLAB_FLUSH_SECONDS` and `AFK_S3_SLAB_MAX_FRAMES` in production. */
  slabFlushIntervalMs?: number;
  slabMaxFrames?: number;
  /** Overrides for tests; production runs on the defaults above. */
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

/** What caused a slab write, for the log line. */
type FlushTrigger = "count" | "interval" | "retry" | "read" | "compact" | "shutdown";

/** Frames accepted for a session and not yet written to the bucket. */
interface SlabBuffer {
  frames: StoredFrame[];
  /** The interval flush, armed by the first append into an empty buffer. */
  timer: NodeJS.Timeout | undefined;
  /** Set when the last write failed; the next append retries it before buffering more. */
  flushFailed: boolean;
}

/** What a compaction wrote, or null when there was nothing to compact. */
interface CompactionResult {
  frames: number;
  objects: number;
}

/**
 * S3-compatible storage (Lightsail object storage, real S3, MinIO). Layout under the
 * bucket:
 *   sessions/<sessionId>/session.json           SessionRecord
 *   sessions/<sessionId>/frames/<index>.ndjson  a slab: StoredFrame lines in index
 *                                                order, named after the index of the
 *                                                first frame, zero padded to 10 digits
 *                                                so lexicographic (S3's own) key order
 *                                                is index order
 *   sessions/<sessionId>/frames.ndjson          every frame of the session as one
 *                                                object, once it has been compacted
 *
 * Object stores can't append, so unlike DiskSessionStorage `appendFrames` buffers in
 * memory and writes a slab when the buffer is `slabMaxFrames` deep or
 * `slabFlushIntervalMs` old, whichever comes first; `flush` (graceful shutdown),
 * `readFrames` (so a read from this process sees everything), and `compactSession`
 * also write out whatever is buffered. A flush that fails keeps its frames for the next
 * one and surfaces on the next `appendFrames` of that session, so a bucket outage
 * stops the client (which spools and retries) rather than growing the buffer.
 *
 * Once a session is over, `compactSession` rewrites its slabs as the one
 * `frames.ndjson` object and deletes them. `readFrames` prefers that object and falls
 * back to listing and fetching the parts, so a session in either layout, or caught
 * between the two steps of a compaction, reads the same. Sessions written before slabs
 * existed (one object per ingested batch) use the same key scheme and read as parts.
 */
export class S3SessionStorage implements SessionStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly slabFlushIntervalMs: number;
  private readonly slabMaxFrames: number;
  private readonly buffers = new Map<string, SlabBuffer>();
  /**
   * One queue per session with a buffer or a compaction, so at most one slab write is
   * in flight per session and a compaction never overlaps a write of the same session.
   */
  private readonly queues = new Map<string, SerialQueue>();

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.slabFlushIntervalMs = options.slabFlushIntervalMs ?? DEFAULT_SLAB_FLUSH_INTERVAL_MS;
    this.slabMaxFrames = options.slabMaxFrames ?? DEFAULT_SLAB_MAX_FRAMES;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      // A custom endpoint is only ever a local/self-hosted S3-compatible store
      // (MinIO and friends), which needs path-style addressing; real S3/Lightsail
      // use their default virtual-hosted addressing.
      forcePathStyle: options.endpoint !== undefined,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      // A plain options object here becomes the SDK's own NodeHttpHandler, so no
      // dependency on @smithy/node-http-handler is needed for the timeouts. Without
      // `throwOnRequestTimeout` the request timeout only prints a warning.
      requestHandler: {
        requestTimeout: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        throwOnRequestTimeout: true,
        connectionTimeout: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      },
      maxAttempts: MAX_ATTEMPTS,
    });
  }

  private prefix(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) {
      throw new Error(`invalid session id: ${sessionId}`);
    }
    return `sessions/${sessionId}/`;
  }

  private partsPrefix(sessionId: string): string {
    return `${this.prefix(sessionId)}${FRAME_PARTS_PREFIX}`;
  }

  private compactedKey(sessionId: string): string {
    return `${this.prefix(sessionId)}${COMPACTED_FRAMES_KEY}`;
  }

  private slabKey(sessionId: string, firstIndex: number): string {
    const name = String(firstIndex).padStart(FRAME_INDEX_WIDTH, "0");
    return `${this.partsPrefix(sessionId)}${name}.ndjson`;
  }

  async putSession(record: SessionRecord) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix(record.sessionId)}${SESSION_KEY}`,
        Body: JSON.stringify(record),
        ContentType: "application/json",
      }),
    );
  }

  async getSession(sessionId: string) {
    if (!SAFE_ID.test(sessionId)) {
      return null;
    }
    try {
      const text = await this.getObjectText(`${this.prefix(sessionId)}${SESSION_KEY}`);
      return SessionRecord.parse(JSON.parse(text));
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Buffers the frames and writes a slab once the buffer is full. Resolves as soon as
   * the frames are buffered (a full slab's write is awaited, but its failure is kept
   * for the next flush rather than thrown: the frames are already accepted, and a
   * failure here would make the client's retry of them a duplicate). A flush that
   * failed earlier is retried first, and that failure is thrown, since this call's
   * frames are not yet buffered and the retry of them is not a duplicate.
   */
  async appendFrames(sessionId: string, frames: StoredFrame[]) {
    if (frames.length === 0) {
      return;
    }
    this.prefix(sessionId); // validates the id before anything is kept under it
    const existing = this.buffers.get(sessionId);
    if (existing?.flushFailed) {
      await this.flushSession(sessionId, "retry");
    }
    const buffer = this.buffer(sessionId);
    buffer.frames.push(...frames);
    if (buffer.frames.length >= this.slabMaxFrames) {
      await this.flushQuietly(sessionId, "count");
    } else if (buffer.timer === undefined) {
      this.armTimer(sessionId, buffer);
    }
  }

  async readFrames(sessionId: string) {
    this.prefix(sessionId);
    // A read from the process that is ingesting the session must see its buffered
    // frames too; a failed write is thrown rather than read around.
    await this.flushSession(sessionId, "read");
    return this.readStoredFrames(sessionId);
  }

  /** Writes every session's buffer; throws once all have been tried if any failed. */
  async flush() {
    const sessionIds = [...this.queues.keys()];
    const results = await Promise.allSettled(
      sessionIds.map((sessionId) => this.flushSession(sessionId, "shutdown")),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `${failures.length} of ${sessionIds.length} slab flushes failed`,
      );
    }
  }

  /**
   * Writes the session's frames as `frames.ndjson`, then deletes its parts. Whatever
   * is still buffered is written first. Without `frames` (the sweeper's path) they are
   * read back from the bucket, which prefers a compacted object a previous attempt
   * left behind. Serialized with the session's slab writes so nothing is in flight
   * while the parts are listed.
   */
  async compactSession(sessionId: string, frames?: readonly StoredFrame[]) {
    const started = performance.now();
    const result = await this.queue(sessionId).run(() => this.compactNow(sessionId, frames));
    this.forget(sessionId);
    if (result === null) {
      return false;
    }
    log.info("compacted", {
      session: sessionId,
      frames: result.frames,
      objects: result.objects,
      ms: Math.round(performance.now() - started),
    });
    return true;
  }

  async listSessionIds() {
    const ids: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: "sessions/",
          Delimiter: "/",
          ContinuationToken: continuationToken,
        }),
      );
      for (const commonPrefix of page.CommonPrefixes ?? []) {
        const prefix = commonPrefix.Prefix;
        if (prefix === undefined) {
          continue;
        }
        // "sessions/<id>/" -> "<id>"
        const id = prefix.slice("sessions/".length, -1);
        if (SAFE_ID.test(id)) {
          ids.push(id);
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return ids;
  }

  async deleteSession(sessionId: string) {
    const keys = await this.listAllKeys(this.prefix(sessionId));
    // Anything still buffered is dropped with the session, or a later flush would
    // write a part of a session that no longer exists.
    this.forget(sessionId);
    await this.deleteKeys(keys);
  }

  /** The session's buffer, created (with its queue, so `flush` finds it) on first use. */
  private buffer(sessionId: string): SlabBuffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = { frames: [], timer: undefined, flushFailed: false };
      this.buffers.set(sessionId, buffer);
      this.queue(sessionId);
    }
    return buffer;
  }

  private queue(sessionId: string): SerialQueue {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = new SerialQueue();
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  private armTimer(sessionId: string, buffer: SlabBuffer): void {
    buffer.timer = setTimeout(() => {
      void this.flushQuietly(sessionId, "interval");
    }, this.slabFlushIntervalMs);
    // A pending flush must never be what keeps the process alive.
    buffer.timer.unref();
  }

  /** Drops the session's buffer, its timer, and its queue. */
  private forget(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer?.timer !== undefined) {
      clearTimeout(buffer.timer);
    }
    this.buffers.delete(sessionId);
    this.queues.delete(sessionId);
  }

  /** Writes the session's buffer as a slab, behind any write or compaction already queued. */
  private async flushSession(sessionId: string, trigger: FlushTrigger): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (!queue) {
      return; // nothing was ever buffered for this session in this process
    }
    await queue.run(() => this.writeSlab(sessionId, trigger));
  }

  /** `flushSession` for callers that cannot do anything with the failure (a timer, a full buffer). */
  private async flushQuietly(sessionId: string, trigger: FlushTrigger): Promise<void> {
    try {
      await this.flushSession(sessionId, trigger);
    } catch (err) {
      log.warn("slab write failed, keeping its frames for the next flush", {
        session: sessionId,
        trigger,
        frames: this.buffers.get(sessionId)?.frames.length ?? 0,
        error: describeError(err),
      });
    }
  }

  /** The body of a flush; only ever runs inside the session's queue. */
  private async writeSlab(sessionId: string, trigger: FlushTrigger): Promise<void> {
    const buffer = this.buffers.get(sessionId);
    if (!buffer || buffer.frames.length === 0) {
      return;
    }
    if (buffer.timer !== undefined) {
      clearTimeout(buffer.timer);
      buffer.timer = undefined;
    }
    // Appends that arrive while this slab is in flight go to the next one.
    const frames = buffer.frames;
    buffer.frames = [];
    const started = performance.now();
    try {
      await this.putFrames(this.slabKey(sessionId, frames[0]!.index), frames);
    } catch (err) {
      // Oldest first, so the retry writes them in index order under the same key.
      buffer.frames = frames.concat(buffer.frames);
      buffer.flushFailed = true;
      this.armTimer(sessionId, buffer);
      throw err;
    }
    buffer.flushFailed = false;
    log.info("flushed slab", {
      session: sessionId,
      frames: frames.length,
      trigger,
      ms: Math.round(performance.now() - started),
    });
    if (buffer.frames.length === 0) {
      this.buffers.delete(sessionId);
    }
  }

  /** The body of a compaction; only ever runs inside the session's queue. */
  private async compactNow(
    sessionId: string,
    frames: readonly StoredFrame[] | undefined,
  ): Promise<CompactionResult | null> {
    await this.writeSlab(sessionId, "compact");
    const parts = await this.listAllKeys(this.partsPrefix(sessionId));
    if (parts.length === 0) {
      return null; // already compacted, or nothing was ever written
    }
    const all = frames ?? (await this.readStoredFrames(sessionId));
    await this.putFrames(this.compactedKey(sessionId), all);
    await this.deleteKeys(parts);
    return { frames: all.length, objects: parts.length };
  }

  /** What the bucket holds for the session: the compacted object if there is one, else the parts. */
  private async readStoredFrames(sessionId: string): Promise<StoredFrame[]> {
    const compacted = await this.getObjectTextIfPresent(this.compactedKey(sessionId));
    if (compacted !== null) {
      return parseFrames(sessionId, [compacted]);
    }
    const keys = await this.listAllKeys(this.partsPrefix(sessionId));
    keys.sort(); // zero-padded, so lexicographic order is index order

    // Fetch in parallel, parse in key order: the objects are small and there can be
    // thousands, so the round trips are the cost, and the result must be in index order.
    const texts = await mapWithConcurrency(keys, READ_CONCURRENCY, (key) =>
      this.getObjectTextIfPresent(key),
    );
    // A null is an object deleted between list and get; treat it like a gap, not an error.
    return parseFrames(
      sessionId,
      texts.filter((text): text is string => text !== null),
    );
  }

  private async putFrames(key: string, frames: readonly StoredFrame[]): Promise<void> {
    const lines = frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: lines,
        ContentType: NDJSON_CONTENT_TYPE,
      }),
    );
  }

  private async deleteKeys(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      );
    }
  }

  /** Lists every key under `prefix`, following pagination to the end. */
  private async listAllKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) {
          keys.push(object.Key);
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    return keys;
  }

  private async getObjectText(key: string): Promise<string> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (result.Body === undefined) {
      return "";
    }
    return result.Body.transformToString("utf8");
  }

  /** The object's text, or null when it no longer exists. */
  private async getObjectTextIfPresent(key: string): Promise<string | null> {
    try {
      return await this.getObjectText(key);
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }
}

/** The frames in the given NDJSON texts, in order; a corrupt line is skipped with a warning. */
function parseFrames(sessionId: string, texts: readonly string[]): StoredFrame[] {
  const frames: StoredFrame[] = [];
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (line === "") {
        continue;
      }
      const frame = parseStoredFrameLine(line);
      if (frame) {
        frames.push(frame);
      } else {
        log.warn("skipping unreadable frame", { session: sessionId });
      }
    }
  }
  return frames;
}

/** True for both the typed S3 "no such key" error and a generic 404 from an
 * S3-compatible store that doesn't send the same error shape. */
function isNotFound(err: unknown): boolean {
  if (err instanceof Error && err.name === "NoSuchKey") {
    return true;
  }
  const metadata = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode === 404;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
