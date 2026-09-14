import type {
  AnomalyEvent,
  Frame,
  HostInfo,
  SessionSummary,
  SessionStatus,
  StoredFrame,
} from "@afk/shared";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { DEFAULT_LIMITS, type AdmissionLimits } from "../env.ts";
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
  /** Last read or write, server clock; idle ended sessions are evicted from memory. */
  lastAccessAt: number;
}

/** Policy the store applies to every session. `index.ts` fills this from config.ts. */
export interface SessionStoreOptions {
  limits: AdmissionLimits;
  /** Server-owned cap on how long a session accepts frames; stamped on each record at create. */
  maxSessionDurationSeconds: number;
  /** How long an ended session with no viewers stays in memory before `tick` evicts it. */
  evictEndedAfterMs: number;
}

export const DEFAULT_STORE_OPTIONS: SessionStoreOptions = {
  limits: DEFAULT_LIMITS,
  maxSessionDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
  evictEndedAfterMs: 10 * 60 * 1000,
};

/** How often `startTicker` runs time-based rules and evicts idle ended sessions. */
export const DEFAULT_TICK_INTERVAL_MS = 5_000;

/** Whether a record is still accepting frames, was ended by the client, or ran past its cap. */
export function sessionStatus(record: SessionRecord, now: number): SessionStatus {
  if (record.endedAt !== null) {
    return "ended";
  }
  if (now - record.startedAt > record.maxDurationSeconds * 1000) {
    return "expired";
  }
  return "active";
}

/** When a non-active session stopped: its explicit end, or the moment it hit the cap. */
export function sessionEndMs(record: SessionRecord): number {
  return record.endedAt ?? record.startedAt + record.maxDurationSeconds * 1000;
}

export interface IngestResult {
  accepted: StoredFrame[];
  duplicates: number;
}

/** Thrown by `ingest` when a batch would add an eleventh (etc.) stream to a session. */
/** Thrown by `ingest` when a batch would push a session past `maxFramesPerSession`. */
export class TooManyFramesError extends Error {
  constructor(readonly limit: number) {
    super(`session has reached the limit of ${limit} frames`);
  }
}

export class TooManyStreamsError extends Error {
  constructor(
    readonly stream: string,
    readonly limit: number,
  ) {
    super(`stream "${stream}" would exceed the limit of ${limit} streams per session`);
  }
}

/**
 * Sessions the server is working with, cached in memory and written through to
 * `SessionStorage`. Sessions not in memory (after a restart, or ended ones being
 * viewed) are loaded from storage on first access, and idle ended sessions are evicted
 * again by `tick`.
 * TODO(memory): measure actual bytes instead of counting frames for admission control.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly loading = new Map<string, Promise<Session | undefined>>();
  private readonly options: SessionStoreOptions;

  constructor(
    private readonly storage: SessionStorage,
    options: Partial<SessionStoreOptions> = {},
  ) {
    this.options = { ...DEFAULT_STORE_OPTIONS, ...options };
  }

  /** Sessions that are still accepting frames. */
  activeSessionCount(now = Date.now()): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (this.status(session, now) === "active") {
        count++;
      }
    }
    return count;
  }

  /** True when another session may be created. */
  hasCapacity(now = Date.now()): boolean {
    return this.activeSessionCount(now) < this.options.limits.maxActiveSessions;
  }

  stats(now = Date.now()) {
    let framesInMemory = 0;
    for (const session of this.sessions.values()) {
      framesInMemory += session.frames.length;
    }
    return {
      activeSessions: this.activeSessionCount(now),
      maxActiveSessions: this.options.limits.maxActiveSessions,
      maxStreamsPerSession: this.options.limits.maxStreamsPerSession,
      sessionsInMemory: this.sessions.size,
      framesInMemory,
    };
  }

  async create(input: { host: HostInfo; clientVersion: string }): Promise<Session> {
    const record: SessionRecord = {
      sessionId: randomId(),
      ingestToken: randomToken(),
      host: input.host,
      clientVersion: input.clientVersion,
      startedAt: Date.now(),
      endedAt: null,
      maxDurationSeconds: this.options.maxSessionDurationSeconds,
    };
    await this.storage.putSession(record);
    const session = this.hydrate(record, []);
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async get(sessionId: string): Promise<Session | undefined> {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      cached.lastAccessAt = Date.now();
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
      lastAccessAt: Date.now(),
    };
    if (this.status(session) !== "active") {
      engine.closeAll(sessionEndMs(session));
    }
    return session;
  }

  private record(session: Session): SessionRecord {
    const { sessionId, ingestToken, host, clientVersion, startedAt, endedAt, maxDurationSeconds } =
      session;
    return { sessionId, ingestToken, host, clientVersion, startedAt, endedAt, maxDurationSeconds };
  }

  status(session: Session, now = Date.now()): SessionStatus {
    return sessionStatus(session, now);
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
      streamCount: session.latestSequence.size,
      maxStreams: this.options.limits.maxStreamsPerSession,
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
    const timer = setInterval(() => this.tick(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }

  /** One pass of the periodic work: time-based rules for live sessions, eviction for idle ended ones. */
  tick(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (this.status(session, now) === "active") {
        this.emitEvents(session, session.engine.onTick(now));
      } else if (
        session.listeners.size === 0 &&
        now - session.lastAccessAt > this.options.evictEndedAfterMs
      ) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Drops a session from the in-memory cache without touching storage. Used by the
   * retention sweeper after it has deleted the session's data, so a later `get` does
   * not serve a copy of something that no longer exists. Returns whether it was cached.
   */
  evict(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
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
    session.lastAccessAt = receivedAt;
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
      if (
        !nextSequence.has(frame.stream) &&
        nextSequence.size >= this.options.limits.maxStreamsPerSession
      ) {
        throw new TooManyStreamsError(frame.stream, this.options.limits.maxStreamsPerSession);
      }
      nextSequence.set(frame.stream, frame.sequence);
      if (nextIndex > this.options.limits.maxFramesPerSession) {
        throw new TooManyFramesError(this.options.limits.maxFramesPerSession);
      }
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
