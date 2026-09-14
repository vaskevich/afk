import { z } from "zod";
import { HostInfo, StoredFrame } from "@afk/shared";

/**
 * What the server persists about a session, independent of where. The live per-stream
 * sequence bookkeeping is not stored; it is rebuilt from the frames on load.
 */
export const SessionRecord = z.object({
  sessionId: z.string(),
  ingestToken: z.string(),
  host: HostInfo,
  clientVersion: z.string(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  maxDurationSeconds: z.number().int().positive(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

/**
 * Durable storage for sessions. Implementations: local disk for dev and self-hosting,
 * an S3-compatible bucket (Lightsail object storage) for the hosted deployment.
 *
 * Frames are append-only and always arrive in index order, so `appendFrames` can be a
 * file append on disk or one new object per batch in a bucket; `readFrames` returns them
 * concatenated in order either way.
 *
 * Retention is `store/sweeper.ts`, built on listSessionIds/getSession/deleteSession so it
 * works the same against every backend.
 */
export interface SessionStorage {
  /** Creates or replaces the session record (called on create and on end). */
  putSession(record: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  appendFrames(sessionId: string, frames: StoredFrame[]): Promise<void>;
  readFrames(sessionId: string): Promise<StoredFrame[]>;
  listSessionIds(): Promise<string[]>;
  deleteSession(sessionId: string): Promise<void>;
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
