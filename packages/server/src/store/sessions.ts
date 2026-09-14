import type {
  AnomalyEvent,
  Frame,
  HostInfo,
  SessionSummary,
  SessionStatus,
  StoredFrame,
} from "@afk/shared";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { RuleEngine } from "../rules/engine.ts";
import { randomId, randomToken } from "../utils/ids.ts";
import { SerialQueue } from "../utils/serial-queue.ts";
import type { SessionRecord, SessionStorage } from "./storage.ts";

export type { StoredFrame };

/** Something that happened to a session that live subscribers (SSE) care about. */
export type SessionEvent =
  | { type: "frames"; frames: StoredFrame[] }
  | { type: "events"; events: AnomalyEvent[] }
  | { type: "ended"; summary: SessionSummary };
export type SessionListener = (event: SessionEvent) => void;

/** A session held in memory: the persisted record plus live bookkeeping. */
export interface Session extends SessionRecord {
  /** Highest accepted sequence per stream. */
  latestSequence: Map<string, number>;
  /** Every frame so far, in index order. */
  frames: StoredFrame[];
  listeners: Set<SessionListener>;
  /** Serializes storage appends so frames land on disk in index order. */
  writeQueue: SerialQueue;
  /** Anomaly rules and the events they have produced. Derived from frames, never persisted. */
  engine: RuleEngine;
}

export interface IngestResult {
  accepted: StoredFrame[];
  duplicates: number;
}

/**
 * Sessions the server is working with, cached in memory and written through to
 * `SessionStorage`. Sessions not in memory (after a restart, or ended ones being
 * viewed) are loaded from storage on first access.
 * TODO(memory): evict idle ended sessions from the cache.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly loading = new Map<string, Promise<Session | undefined>>();

  constructor(private readonly storage: SessionStorage) {}

  async create(input: { host: HostInfo; clientVersion: string }): Promise<Session> {
    const record: SessionRecord = {
      sessionId: randomId(),
      ingestToken: randomToken(),
      host: input.host,
      clientVersion: input.clientVersion,
      startedAt: Date.now(),
      endedAt: null,
      maxDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
    };
    await this.storage.putSession(record);
    const session = this.hydrate(record, []);
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      return cached;
    }
    // Coalesce concurrent loads of the same session so it is only read once.
    let pending = this.loading.get(sessionId);
    if (!pending) {
      pending = this.loadAndUntrack(sessionId);
      this.loading.set(sessionId, pending);
    }
    return pending;
  }

  private async loadAndUntrack(sessionId: string): Promise<Session | undefined> {
    try {
      return await this.load(sessionId);
    } finally {
      this.loading.delete(sessionId);
    }
  }

  private async load(sessionId: string): Promise<Session | undefined> {
    const record = await this.storage.getSession(sessionId);
    if (!record) {
      return undefined;
    }
    const frames = await this.storage.readFrames(sessionId);
    const session = this.hydrate(record, frames);
    this.sessions.set(sessionId, session);
    return session;
  }

  private hydrate(record: SessionRecord, frames: StoredFrame[]): Session {
    const latestSequence = new Map<string, number>();
    for (const { frame } of frames) {
      const latest = latestSequence.get(frame.stream) ?? 0;
      if (frame.sequence > latest) {
        latestSequence.set(frame.stream, frame.sequence);
      }
    }
    // Replay history through fresh rules so improved rules apply to old sessions too.
    const engine = new RuleEngine();
    engine.onFrames(frames);
    const session: Session = {
      ...record,
      latestSequence,
      frames,
      listeners: new Set(),
      writeQueue: new SerialQueue(),
      engine,
    };
    if (this.status(session) !== "active") {
      engine.closeAll(this.sessionEndMs(session));
    }
    return session;
  }

  /** When a non-active session stopped: its explicit end, or the moment it hit the cap. */
  private sessionEndMs(session: Session): number {
    return session.endedAt ?? session.startedAt + session.maxDurationSeconds * 1000;
  }

  private record(session: Session): SessionRecord {
    const { sessionId, ingestToken, host, clientVersion, startedAt, endedAt, maxDurationSeconds } =
      session;
    return { sessionId, ingestToken, host, clientVersion, startedAt, endedAt, maxDurationSeconds };
  }

  status(session: Session, now = Date.now()): SessionStatus {
    if (session.endedAt !== null) {
      return "ended";
    }
    if (now - session.startedAt > session.maxDurationSeconds * 1000) {
      return "expired";
    }
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

  async end(session: Session): Promise<void> {
    if (session.endedAt !== null) {
      return;
    }
    session.endedAt = Date.now();
    await this.storage.putSession(this.record(session));
    this.emitEvents(session, session.engine.closeAll(session.endedAt));
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

  /**
   * Gives time-based rules (client silent) a chance to fire on every active session
   * in memory. Returns a function that stops the ticker.
   */
  startTicker(intervalMs: number): () => void {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const session of this.sessions.values()) {
        if (this.status(session, now) === "active") {
          this.emitEvents(session, session.engine.onTick(now));
        }
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }

  private emitEvents(session: Session, events: AnomalyEvent[]): void {
    if (events.length === 0) {
      return;
    }
    for (const event of events) {
      const state = event.endedAt === null ? "open" : "closed";
      console.log(
        `[session ${session.sessionId}] ${state} ${event.kind} (${event.severity}): ${event.message}`,
      );
    }
    this.emit(session, { type: "events", events });
  }

  private emit(session: Session, event: SessionEvent): void {
    for (const listener of session.listeners) {
      listener(event);
    }
  }

  /**
   * Accepts frames in order, skipping any whose sequence is at or below the latest seen for
   * its stream. That makes client retries idempotent: a batch that was received but whose
   * acknowledgement was lost is simply resent and ignored.
   *
   * Frames are persisted before the in-memory state advances, so a failed write leaves the
   * session untouched and the client's retry is not mistaken for a duplicate.
   */
  async ingest(session: Session, frames: Frame[]): Promise<IngestResult> {
    const receivedAt = Date.now();
    const accepted: StoredFrame[] = [];
    const nextSequence = new Map(session.latestSequence);
    let duplicates = 0;
    let nextIndex = session.frames.length + 1;
    for (const frame of frames) {
      const latest = nextSequence.get(frame.stream) ?? 0;
      if (frame.sequence <= latest) {
        duplicates++;
        continue;
      }
      nextSequence.set(frame.stream, frame.sequence);
      accepted.push({ index: nextIndex++, receivedAt, frame });
    }
    if (accepted.length === 0) {
      return { accepted, duplicates };
    }

    await session.writeQueue.run(() => this.storage.appendFrames(session.sessionId, accepted));

    session.latestSequence = nextSequence;
    session.frames.push(...accepted);
    this.emit(session, { type: "frames", frames: accepted });
    this.emitEvents(session, session.engine.onFrames(accepted));
    return { accepted, duplicates };
  }
}
