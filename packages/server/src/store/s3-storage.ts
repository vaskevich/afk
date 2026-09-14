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
import { SessionRecord, parseStoredFrameLine, type SessionStorage } from "./storage.ts";

const SESSION_KEY = "session.json";

/** Session ids are server-generated base62, but never trust a path segment blindly. */
const SAFE_ID = /^[A-Za-z0-9]+$/;

/** S3 caps a single DeleteObjects call at 1000 keys. */
const DELETE_BATCH_SIZE = 1000;

/**
 * How many frame objects `readFrames` fetches at once. The client sends one batch a
 * second and every batch is its own object, so a one-hour session is a few thousand
 * small objects and the round trips dominate: fetched one at a time at ~14 ms each,
 * the 2,798 objects of a real session took 40 s to load on 2026-09-14 (the first
 * dashboard visit after the cache had let the session go). Sixteen in flight brings
 * that to about 3 s, stays well inside the SDK's socket pool (50 per host), and
 * buffers at most sixteen batch objects (~130 KB each at the ingest body limit).
 */
export const READ_CONCURRENCY = 16;

/**
 * How long one bucket request may take before the SDK gives up on it, and how long
 * opening its connection may take. The SDK's own defaults are no request timeout at
 * all, so a hung request would hold its caller forever: an ingest write blocks every
 * later batch of that session (`writeQueue`), a read blocks the coalesced load every
 * dashboard visitor is waiting on. Objects are at most a batch (~130 KB), so anything
 * past a few seconds is a fault, not a slow transfer.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 3_000;
/**
 * Attempts per request, including the first. The SDK's default is three; two keeps a
 * dead bucket from tying a caller up for three timeouts when the client will retry
 * the whole batch anyway.
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
  /** Overrides for tests; production runs on the defaults above. */
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

/**
 * S3-compatible storage (Lightsail object storage, real S3, MinIO). Layout under the
 * bucket:
 *   sessions/<sessionId>/session.json           SessionRecord
 *   sessions/<sessionId>/frames/<index>.ndjson  one batch of StoredFrame lines, in
 *                                                index order, named after the index of
 *                                                the first frame in the batch, zero
 *                                                padded to 10 digits so lexicographic
 *                                                (S3's own) key order is index order
 *
 * Object stores can't append, so unlike DiskSessionStorage each `appendFrames` call
 * becomes a new object rather than more lines in one file. `readFrames` lists the
 * `frames/` prefix and concatenates the objects back together in key order.
 */
export class S3SessionStorage implements SessionStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
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

  async appendFrames(sessionId: string, frames: StoredFrame[]) {
    if (frames.length === 0) {
      return;
    }
    const firstIndex = frames[0]!.index;
    const key = `${this.prefix(sessionId)}frames/${String(firstIndex).padStart(10, "0")}.ndjson`;
    const lines = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: lines,
        ContentType: "application/x-ndjson",
      }),
    );
  }

  async readFrames(sessionId: string) {
    const framesPrefix = `${this.prefix(sessionId)}frames/`;
    const keys = await this.listAllKeys(framesPrefix);
    keys.sort(); // zero-padded, so lexicographic order is index order

    // Fetch in parallel, parse in key order: the objects are tiny and there are
    // thousands, so the round trips are the cost, and the result must be in index order.
    const texts = await mapWithConcurrency(keys, READ_CONCURRENCY, (key) =>
      this.getObjectTextIfPresent(key),
    );
    const frames: StoredFrame[] = [];
    for (const text of texts) {
      if (text === null) {
        continue; // deleted between list and get; treat like a gap, not an error
      }
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
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
      if (batch.length === 0) {
        continue;
      }
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

/** True for both the typed S3 "no such key" error and a generic 404 from an
 * S3-compatible store that doesn't send the same error shape. */
function isNotFound(err: unknown): boolean {
  if (err instanceof Error && err.name === "NoSuchKey") {
    return true;
  }
  const metadata = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode === 404;
}
