import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { StoredFrame } from "@afk/shared";
import { log } from "../log/logger.ts";
import { SessionRecord, parseStoredFrameLine, type SessionStorage } from "./storage.ts";

const SESSION_KEY = "session.json";

/** Session ids are server-generated base62, but never trust a path segment blindly. */
const SAFE_ID = /^[A-Za-z0-9]+$/;

/** S3 caps a single DeleteObjects call at 1000 keys. */
const DELETE_BATCH_SIZE = 1000;

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Override for S3-compatible stores (MinIO, etc). Lightsail buckets use the standard
   * regional S3 endpoint, so this is normally left unset. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
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

    const frames: StoredFrame[] = [];
    for (const key of keys) {
      let text: string;
      try {
        text = await this.getObjectText(key);
      } catch (err) {
        if (isNotFound(err)) {
          continue; // deleted between list and get; treat like a gap, not an error
        }
        throw err;
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
