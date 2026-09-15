import { z } from "zod";
import { HostInfo, StoredFrame } from "@afk/shared";
import { hashIngestToken } from "../utils/ingest-token.ts";

/**
 * What the server persists about a session, independent of where. The live per-stream
 * sequence bookkeeping is not stored; it is rebuilt from the frames on load. The chain
 * links default to null so records written before chaining existed still parse.
 *
 * The ingest token is stored as its sha256 (`utils/ingest-token.ts`), never in clear:
 * the store (a bucket, a self-hoster's disk) is readable by more than the server, and
 * reading it must not grant write access to every live session.
 */
export const SessionRecord = z.object({
  sessionId: z.string(),
  ingestTokenHash: z.string(),
  host: HostInfo,
  clientVersion: z.string(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  maxDurationSeconds: z.number().int().positive(),
  /** The session this one continues (the client chained past the cap), or null. */
  previousSessionId: z.string().nullable().default(null),
  /** The session that continues this one, or null. Set when the successor is created. */
  nextSessionId: z.string().nullable().default(null),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

/** The clear-token field records carried before tokens were hashed. */
const LEGACY_INGEST_TOKEN_FIELD = "ingestToken";

/**
 * A record as it may be found in storage: written by this server (`ingestTokenHash`)
 * or by one from before tokens were hashed (clear `ingestToken`). The legacy shape is
 * hashed on the way in, so the rest of the server only ever sees `SessionRecord`.
 * TODO(storage): drop the legacy field once every deployment has written past it (one
 * release: sessions live an hour and are kept seven days).
 */
const StoredSessionRecord = SessionRecord.omit({ ingestTokenHash: true })
  .extend({
    ingestTokenHash: z.string().optional(),
    [LEGACY_INGEST_TOKEN_FIELD]: z.string().optional(),
  })
  .transform((stored, ctx): SessionRecord => {
    const { ingestTokenHash, ingestToken, ...rest } = stored;
    if (ingestTokenHash !== undefined) {
      return { ...rest, ingestTokenHash };
    }
    if (ingestToken !== undefined) {
      return { ...rest, ingestTokenHash: hashIngestToken(ingestToken) };
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ingestTokenHash"],
      message: `record has neither ingestTokenHash nor ${LEGACY_INGEST_TOKEN_FIELD}`,
    });
    return z.NEVER;
  });

/**
 * Parses a `session.json` document from storage, accepting both the hashed shape this
 * server writes and the clear-token shape of records written before. Throws (a
 * `ZodError`) on anything else, like `SessionRecord.parse` would.
 */
export function parseSessionRecord(json: unknown): SessionRecord {
  return StoredSessionRecord.parse(json);
}

/**
 * Durable storage for sessions. Implementations: local disk for dev and self-hosting,
 * an S3-compatible bucket (Lightsail object storage) for the hosted deployment.
 *
 * Frames are append-only and always arrive in index order, so `appendFrames` can be a
 * file append on disk or a buffered slab object in a bucket; `readFrames` returns them
 * concatenated in order either way.
 *
 * The two optional methods exist for backends that hold frames in memory or keep them
 * in a shape that is cheap to write but costly to read back (the bucket backend does
 * both): `flush` is called from graceful shutdown, `compactSession` once a session is
 * over. A backend that writes through and reads back in one go (disk, memory) leaves
 * them out.
 *
 * Retention is `store/sweeper.ts`, built on listSessionIds/getSession/deleteSession so it
 * works the same against every backend.
 */
export interface SessionStorage {
  /** Creates or replaces the session record (called on create and on end). */
  putSession(record: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  /**
   * Persists frames that were accepted, in index order. Resolving is the backend's
   * promise that a later `readFrames` from this process returns them; it may still be
   * buffering them for durable storage (see `flush`).
   */
  appendFrames(sessionId: string, frames: StoredFrame[]): Promise<void>;
  readFrames(sessionId: string): Promise<StoredFrame[]>;
  listSessionIds(): Promise<string[]>;
  deleteSession(sessionId: string): Promise<void>;
  /**
   * Writes everything still buffered in memory, for every session, to durable storage.
   * Shutdown calls it after the store's write queues have drained.
   */
  flush?(): Promise<void>;
  /**
   * Rewrites an ended or expired session into whatever shape reads back cheapest, given
   * the session's frames when the caller already holds them (the store does at end) so
   * they need not be read back first. Resolves to whether anything was rewritten; a
   * session that is already compact, or has no frames, is a no-op. Runs in the
   * background at end and from the sweeper: it must be safe to call more than once,
   * concurrently with reads, and to fail part way (reads must still be correct).
   */
  compactSession?(sessionId: string, frames?: readonly StoredFrame[]): Promise<boolean>;
}

/**
 * One line of a frames file, or null when it is corrupt (bad JSON or wrong shape) so
 * a damaged line loses one frame rather than the whole session.
 */
export function parseStoredFrameLine(line: string): StoredFrame | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = StoredFrame.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Keeps everything in memory. For tests and throwaway runs. */
export class MemorySessionStorage implements SessionStorage {
  private readonly records = new Map<string, SessionRecord>();
  private readonly frames = new Map<string, StoredFrame[]>();

  async putSession(record: SessionRecord) {
    this.records.set(record.sessionId, record);
  }
  async getSession(sessionId: string) {
    return this.records.get(sessionId) ?? null;
  }
  async appendFrames(sessionId: string, frames: StoredFrame[]) {
    const list = this.frames.get(sessionId) ?? [];
    list.push(...frames);
    this.frames.set(sessionId, list);
  }
  async readFrames(sessionId: string) {
    return (this.frames.get(sessionId) ?? []).slice();
  }
  async listSessionIds() {
    return [...this.records.keys()];
  }
  async deleteSession(sessionId: string) {
    this.records.delete(sessionId);
    this.frames.delete(sessionId);
  }
}
