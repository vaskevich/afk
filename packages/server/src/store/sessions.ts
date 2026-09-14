import type { Frame, HostInfo, SessionSummary, SessionStatus, StoredFrame } from "@afk/shared";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { randomId, randomToken } from "../utils/ids.ts";

export type { StoredFrame };

/** Something that happened to a session that live subscribers (SSE) care about. */
export type SessionEvent =
  { type: "frames"; frames: StoredFrame[] } | { type: "ended"; summary: SessionSummary };
export type SessionListener = (event: SessionEvent) => void;

export interface Session {
  sessionId: string;
  ingestToken: string;
  host: HostInfo;
  clientVersion: string;
  startedAt: number;
  endedAt: number | null;
  maxDurationSeconds: number;
  /** Highest accepted sequence per stream. */
  latestSequence: Map<string, number>;
  /** TODO(persistence): append to disk (later S3) instead of holding everything in memory. */
  frames: StoredFrame[];
  listeners: Set<SessionListener>;
}

export interface IngestResult {
  accepted: StoredFrame[];
  duplicates: number;
}

/**
 * In-memory session store. Enough for the MVP; persistence and retention are tracked in BACKLOG.md.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(input: { host: HostInfo; clientVersion: string }): Session {
    const session: Session = {
      sessionId: randomId(),
      ingestToken: randomToken(),
      host: input.host,
      clientVersion: input.clientVersion,
      startedAt: Date.now(),
      endedAt: null,
      maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
      latestSequence: new Map(),
      frames: [],
      listeners: new Set(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  status(session: Session, now = Date.now()): SessionStatus {
    if (session.endedAt !== null) return "ended";
    if (now - session.startedAt > session.maxDurationSeconds * 1000) return "expired";
    return "active";
  }

  summary(session: Session): SessionSummary {
    return {
      sessionId: session.sessionId,
      status: this.status(session),
      host: session.host,
      clientVersion: session.clientVersion,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      maxDurationSeconds: session.maxDurationSeconds,
    };
  }

  end(session: Session): void {
    if (session.endedAt !== null) return;
    session.endedAt = Date.now();
    this.emit(session, { type: "ended", summary: this.summary(session) });
  }

  /** Frames after the given session-wide index (0 = everything). */
  framesAfter(session: Session, index: number): StoredFrame[] {
    return index <= 0 ? session.frames.slice() : session.frames.slice(index);
  }

  /** Subscribe to live changes. Returns an unsubscribe function. */
  subscribe(session: Session, listener: SessionListener): () => void {
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  private emit(session: Session, event: SessionEvent): void {
    for (const listener of session.listeners) listener(event);
  }

  /**
   * Accepts frames in order, skipping any whose sequence is at or below the latest seen for
   * its stream. That makes client retries idempotent: a batch that was received but whose
   * acknowledgement was lost is simply resent and ignored.
   */
  ingest(session: Session, frames: Frame[]): IngestResult {
    const receivedAt = Date.now();
    const accepted: StoredFrame[] = [];
    let duplicates = 0;
    for (const frame of frames) {
      const latest = session.latestSequence.get(frame.stream) ?? 0;
      if (frame.sequence <= latest) {
        duplicates++;
        continue;
      }
      session.latestSequence.set(frame.stream, frame.sequence);
      const stored: StoredFrame = { index: session.frames.length + 1, receivedAt, frame };
      session.frames.push(stored);
      accepted.push(stored);
    }
    if (accepted.length > 0) this.emit(session, { type: "frames", frames: accepted });
    return { accepted, duplicates };
  }
}
