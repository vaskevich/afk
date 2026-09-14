import type { Frame, HostInfo, SessionSummary, SessionStatus } from "@afk/shared";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { randomId, randomToken } from "../utils/ids.ts";

export interface StoredFrame {
  frame: Frame;
  /** Server clock, unix milliseconds. */
  receivedAt: number;
}

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
    if (session.endedAt === null) session.endedAt = Date.now();
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
      const stored = { frame, receivedAt };
      session.frames.push(stored);
      accepted.push(stored);
    }
    return { accepted, duplicates };
  }
}
