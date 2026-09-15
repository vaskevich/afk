import type {
  AnomalyEvent,
  Frame,
  HostInfo,
  SessionSummary,
  SessionStatus,
  StoredFrame,
  StreamEndReason,
} from "@afk/shared";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { DEFAULT_LIMITS, type AdmissionLimits } from "../env.ts";
import { log } from "../log/logger.ts";
import { RuleEngine } from "../rules/engine.ts";
import { randomId, randomToken } from "../utils/ids.ts";
import { hashIngestToken } from "../utils/ingest-token.ts";
import { SerialQueue } from "../utils/serial-queue.ts";
import { mergeFrames } from "./frame-order.ts";
import type { SessionRecord, SessionStorage } from "./storage.ts";

export type { StoredFrame };

/**
 * Something that happened to a session that live subscribers (SSE) care about. `ended`
 * carries why (`StreamEndReason`): a deleted session's last summary is the same shape
 * as an ended one's, and the reason is what tells a viewer the difference.
 */
export type SessionEvent =
  | { type: "frames"; frames: StoredFrame[] }
  | { type: "events"; events: AnomalyEvent[] }
  | { type: "ended"; summary: SessionSummary; reason: StreamEndReason };
export type SessionListener = (event: SessionEvent) => void;

/** A session held in memory: the persisted record plus live bookkeeping. */
export interface Session extends SessionRecord {
  /** Highest accepted sequence per stream. */
  latestSequence: Map<string, number>;
  /** Every frame so far, in index order. */
  frames: StoredFrame[];
  /**
   * The session-wide index the next accepted frame gets: one past the highest index
   * the session holds, never `frames.length + 1`. The two differ whenever the frames
   * are not exactly 1..n — a line `parseStoredFrameLine` could not read, or another
   * writer's frames merged in — and counting would then hand out an index that is
   * already taken.
   */
  nextIndex: number;
  /** Bytes of `frames` as stored NDJSON (`storedFrameBytes`); what `maxBytesPerSession` bounds. */
  byteCount: number;
  /** Open SSE connections serving this session (`openSseConnection` / `closeSseConnection`). */
  sseConnections: number;
  listeners: Set<SessionListener>;
  /** Serializes storage appends so frames land on disk in index order. */
  writeQueue: SerialQueue;
  /** Anomaly rules and the events they have produced. Derived from frames, never persisted. */
  engine: RuleEngine;
  /** Last read or write, server clock; idle ended sessions are evicted from memory. */
  lastAccessAt: number;
  /**
   * Set on a session loaded from storage, cleared by the first `ingest` after that
   * load, which re-reads storage first: the writer this process is taking over from
   * (the container a deploy is replacing) may land its last slab after the load. A
   * session created here has nothing to catch up on.
   */
  mergeStorageBeforeIngest: boolean;
}

/** Policy the store applies to every session. `index.ts` fills this from config.ts. */
export interface SessionStoreOptions {
  limits: AdmissionLimits;
  /** Server-owned cap on how long a session accepts frames; stamped on each record at create. */
  maxSessionDurationSeconds: number;
  /** How long an ended session with no viewers stays in memory before `tick` evicts it. */
  evictEndedAfterMs: number;
  /**
   * An active session that has received nothing for this long is ended by `tick`, at
   * the moment the silence began plus this. `client.stale` (60 s) is the early warning.
   */
  endAfterSilentMs: number;
}

export const DEFAULT_STORE_OPTIONS: SessionStoreOptions = {
  limits: DEFAULT_LIMITS,
  maxSessionDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
  evictEndedAfterMs: 10 * 60 * 1000,
  endAfterSilentMs: 10 * 60 * 1000,
};

/** How often `startTicker` runs time-based rules and evicts idle ended sessions. */
export const DEFAULT_TICK_INTERVAL_MS = 5_000;

/**
 * How long `get` remembers that an id was not in storage before asking again. Read
 * routes take no auth, so a well-formed unknown id would otherwise cost one storage
 * read (an S3 GetObject on the hosted instance) per probe.
 */
export const UNKNOWN_ID_TTL_MS = 60_000;
/** Bound on remembered unknown ids; past it the oldest entry is forgotten first. */
export const UNKNOWN_ID_CACHE_MAX_ENTRIES = 4096;

/**
 * An entry of the negative id cache: when to forget it, and whether the id is unknown
 * because it was deleted (so a 404 can say so, see `wasDeleted`) rather than never
 * issued.
 */
interface UnknownIdEntry {
  expiresAt: number;
  deleted: boolean;
}

/**
 * What `openSseConnection` decides: admitted, or refused because the session or the
 * whole process is at its cap (`maxSseConnectionsPerSession` / `maxSseConnections`).
 */
export type SseAdmission = "admitted" | "session-full" | "server-full";

/**
 * What `create` returns: the session, and the one and only copy of its ingest token in
 * clear. The session (and its record) holds the token's hash; the create response hands
 * the token to the client and the server never sees it again except as a bearer.
 */
export interface CreatedSession {
  session: Session;
  ingestToken: string;
}

/** What `delete` reports back: the record that was removed and how many frames went with it. */
export interface DeleteResult {
  sessionId: string;
  frames: number;
}

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
  /** Streams the batch carried that the session had no room for; their frames were skipped. */
  rejectedStreams: string[];
}

/** Thrown by `ingest` when a batch would push a session past `maxFramesPerSession`. */
export class TooManyFramesError extends Error {
  constructor(readonly limit: number) {
    super(`session has reached the limit of ${limit} frames`);
  }
}

/** Thrown by `ingest` when a batch would push a session past `maxBytesPerSession`. */
export class TooManyBytesError extends Error {
  constructor(readonly limit: number) {
    super(`session has reached the limit of ${limit} bytes`);
  }
}

/**
 * What one stored frame costs against `maxBytesPerSession`: its NDJSON line as the
 * storage backends write it, newline included. Counted the same way on ingest and on
 * load, so the cap holds across a restart.
 */
export function storedFrameBytes(stored: StoredFrame): number {
  return Buffer.byteLength(JSON.stringify(stored)) + 1;
}

/**
 * The position of the first frame whose index is past `index`, by binary search over
 * frames held in index order (`frames.length` when there is none). Position and index
 * are not the same number: indexes can have holes (a stored line that would not parse)
 * or repeat (two writers numbering from the same point during a deploy).
 */
function firstIndexAfter(frames: readonly StoredFrame[], index: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle]!.index > index) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/** Thrown by `create` when the session to chain from already has a successor. */
export class AlreadyContinuedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly nextSessionId: string,
  ) {
    super(`session ${sessionId} already continues in ${nextSessionId}`);
  }
}

/**
 * Sessions the server is working with, cached in memory and written through to
 * `SessionStorage`. Sessions not in memory (after a restart, or ended ones being
 * viewed) are loaded from storage on first access, and idle ended sessions are evicted
 * again by `tick`.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly loading = new Map<string, Promise<Session | undefined>>();
  /** Ids storage did not know (or that were deleted), each with when to forget it. Insertion order is age. */
  private readonly unknownIds = new Map<string, UnknownIdEntry>();
  private readonly options: SessionStoreOptions;
  /** Open SSE connections across every session; the sum of `Session.sseConnections`. */
  private sseConnections = 0;

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
    let bytesInMemory = 0;
    for (const session of this.sessions.values()) {
      framesInMemory += session.frames.length;
      bytesInMemory += session.byteCount;
    }
    return {
      activeSessions: this.activeSessionCount(now),
      maxActiveSessions: this.options.limits.maxActiveSessions,
      maxStreamsPerSession: this.options.limits.maxStreamsPerSession,
      maxFramesPerSession: this.options.limits.maxFramesPerSession,
      maxBytesPerSession: this.options.limits.maxBytesPerSession,
      maxSseConnectionsPerSession: this.options.limits.maxSseConnectionsPerSession,
      maxSseConnections: this.options.limits.maxSseConnections,
      sessionsInMemory: this.sessions.size,
      framesInMemory,
      bytesInMemory,
      sseConnections: this.sseConnections,
    };
  }

  /**
   * Counts one more SSE connection against `session` and the process, unless either is
   * at its cap, in which case nothing is counted and the answer says which. The stream
   * route calls this before it starts writing and `closeSseConnection` when it stops,
   * so the counts are exact at the moment of the check; there is no await in between.
   */
  openSseConnection(session: Session): SseAdmission {
    if (session.sseConnections >= this.options.limits.maxSseConnectionsPerSession) {
      return "session-full";
    }
    if (this.sseConnections >= this.options.limits.maxSseConnections) {
      return "server-full";
    }
    session.sseConnections++;
    this.sseConnections++;
    return "admitted";
  }

  /** Releases a connection `openSseConnection` admitted, once the stream has ended for any reason. */
  closeSseConnection(session: Session): void {
    session.sseConnections--;
    this.sseConnections--;
  }

  /**
   * Creates a session. With `previous` (a session this client owns, already checked by
   * the route) the new one continues it: both records are linked, and the previous
   * session ends at this moment if it was still running (at its cap if it had already
   * expired), so its viewers get an `ended` event naming the successor.
   */
  async create(input: {
    host: HostInfo;
    clientVersion: string;
    previous?: Session;
  }): Promise<CreatedSession> {
    const { previous } = input;
    if (previous && previous.nextSessionId !== null) {
      throw new AlreadyContinuedError(previous.sessionId, previous.nextSessionId);
    }
    const now = Date.now();
    const ingestToken = randomToken();
    const record: SessionRecord = {
      sessionId: randomId(),
      ingestTokenHash: hashIngestToken(ingestToken),
      host: input.host,
      clientVersion: input.clientVersion,
      startedAt: now,
      endedAt: null,
      maxDurationSeconds: this.options.maxSessionDurationSeconds,
      previousSessionId: previous?.sessionId ?? null,
      nextSessionId: null,
    };
    await this.storage.putSession(record);
    const session = this.hydrate(record, []);
    this.sessions.set(session.sessionId, session);
    this.unknownIds.delete(session.sessionId);
    if (previous) {
      await this.continueIn(previous, session, now);
    }
    return { session, ingestToken };
  }

  /** Links `previous` to its successor and ends it (persisting either way). */
  private async continueIn(previous: Session, next: Session, now: number): Promise<void> {
    previous.nextSessionId = next.sessionId;
    if (previous.endedAt === null) {
      await this.end(previous, Math.min(now, sessionEndMs(previous)));
    } else {
      await this.storage.putSession(this.record(previous));
    }
  }

  /**
   * The session, from memory or storage; undefined when it exists nowhere. An id that
   * storage did not know is remembered for `UNKNOWN_ID_TTL_MS` so repeated probes of
   * it do not each cost a storage read.
   */
  async get(sessionId: string, now = Date.now()): Promise<Session | undefined> {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      cached.lastAccessAt = now;
      return cached;
    }
    if (this.isRememberedUnknown(sessionId, now)) {
      return undefined;
    }
    // Coalesce concurrent loads of the same session so it is only read once.
    let pending = this.loading.get(sessionId);
    if (!pending) {
      pending = this.loadAndUntrack(sessionId, now);
      this.loading.set(sessionId, pending);
    }
    return pending;
  }

  private isRememberedUnknown(sessionId: string, now: number): boolean {
    return this.rememberedUnknown(sessionId, now) !== undefined;
  }

  /**
   * True while the store remembers that `sessionId` was deleted (the same
   * `UNKNOWN_ID_TTL_MS` as any unknown id), so a 404 can say "deleted" rather than
   * "unknown" to the client that was still sending to it and to a dashboard that
   * reloads. After that the id is simply unknown, which the client handles the same way.
   */
  wasDeleted(sessionId: string, now = Date.now()): boolean {
    return this.rememberedUnknown(sessionId, now)?.deleted ?? false;
  }

  /** The live negative-cache entry for `sessionId`, dropping it once it has expired. */
  private rememberedUnknown(sessionId: string, now: number): UnknownIdEntry | undefined {
    const entry = this.unknownIds.get(sessionId);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.unknownIds.delete(sessionId);
      return undefined;
    }
    return entry;
  }

  private rememberUnknown(sessionId: string, now: number, deleted = false): void {
    // A Map iterates in insertion order, so its first key is the oldest entry.
    if (this.unknownIds.size >= UNKNOWN_ID_CACHE_MAX_ENTRIES) {
      const oldest = this.unknownIds.keys().next().value;
      if (oldest !== undefined) {
        this.unknownIds.delete(oldest);
      }
    }
    this.unknownIds.set(sessionId, { expiresAt: now + UNKNOWN_ID_TTL_MS, deleted });
  }

  private async loadAndUntrack(sessionId: string, now: number): Promise<Session | undefined> {
    try {
      return await this.load(sessionId, now);
    } finally {
      this.loading.delete(sessionId);
    }
  }

  /**
   * Reads a session from storage and hydrates it. Logged with its cost because this is
   * the one expensive read the server does: on the bucket backend it is thousands of
   * small objects, and the first dashboard visit after a restart or eviction pays it.
   */
  private async load(sessionId: string, now: number): Promise<Session | undefined> {
    const started = performance.now();
    const record = await this.storage.getSession(sessionId);
    if (!record) {
      this.rememberUnknown(sessionId, now);
      return undefined;
    }
    const frames = await this.storage.readFrames(sessionId);
    const storageMs = Math.round(performance.now() - started);
    const session = this.hydrate(record, frames);
    // Another process may have been writing this session as it was read (a deploy's
    // overlap); the first ingest checks storage once more before it numbers anything.
    session.mergeStorageBeforeIngest = true;
    this.sessions.set(sessionId, session);
    log.info("session loaded from storage", {
      session: sessionId,
      frames: frames.length,
      storageMs,
      ms: Math.round(performance.now() - started),
    });
    return session;
  }

  private hydrate(record: SessionRecord, frames: StoredFrame[]): Session {
    const session: Session = {
      ...record,
      latestSequence: new Map(),
      frames: [],
      nextIndex: 1,
      byteCount: 0,
      sseConnections: 0,
      listeners: new Set(),
      writeQueue: new SerialQueue(),
      engine: new RuleEngine(),
      lastAccessAt: Date.now(),
      mergeStorageBeforeIngest: false,
    };
    this.adoptFrames(session, frames);
    return session;
  }

  /**
   * Makes `frames` the session's history: the per-stream sequence bookkeeping, the
   * byte count, the next index, and a fresh rule engine replayed over them. Used when
   * a session is hydrated and again when a late slab is merged in, so both go through
   * one derivation. Replaying history through fresh rules is also what makes an
   * improved rule apply to old sessions.
   */
  private adoptFrames(session: Session, frames: StoredFrame[]): void {
    const latestSequence = new Map<string, number>();
    let byteCount = 0;
    let highestIndex = 0;
    for (const stored of frames) {
      const { frame } = stored;
      const latest = latestSequence.get(frame.stream) ?? 0;
      if (frame.sequence > latest) {
        latestSequence.set(frame.stream, frame.sequence);
      }
      if (stored.index > highestIndex) {
        highestIndex = stored.index;
      }
      byteCount += storedFrameBytes(stored);
    }
    const engine = new RuleEngine();
    engine.onFrames(frames);
    session.frames = frames;
    session.latestSequence = latestSequence;
    session.byteCount = byteCount;
    session.nextIndex = highestIndex + 1;
    session.engine = engine;
    if (this.status(session) !== "active") {
      engine.closeAll(sessionEndMs(session));
    }
  }

  /**
   * Re-reads the session from storage and merges in whatever appeared since it was
   * loaded — the last slab of the process this one is taking the session over from,
   * which a deploy's overlap lands after the load. Runs once per session per process,
   * inside the write queue and before the batch that triggered it is admitted, so the
   * indexes handed out are past everything that exists rather than on top of it.
   * Nothing is emitted to live subscribers: the merged frames are older than anything
   * a viewer following this process has, and a viewer's next load reads them in order.
   */
  private async mergeFramesFromStorage(session: Session): Promise<void> {
    const stored = await this.storage.readFrames(session.sessionId);
    const merged = mergeFrames(session.frames, stored);
    const added = merged.length - session.frames.length;
    if (added === 0) {
      return;
    }
    this.adoptFrames(session, merged);
    log.info("merged frames another process wrote", {
      session: session.sessionId,
      added,
      frames: merged.length,
    });
  }

  private record(session: Session): SessionRecord {
    const {
      sessionId,
      ingestTokenHash,
      host,
      clientVersion,
      startedAt,
      endedAt,
      maxDurationSeconds,
      previousSessionId,
      nextSessionId,
    } = session;
    return {
      sessionId,
      ingestTokenHash,
      host,
      clientVersion,
      startedAt,
      endedAt,
      maxDurationSeconds,
      previousSessionId,
      nextSessionId,
    };
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
      previousSessionId: session.previousSessionId,
      nextSessionId: session.nextSessionId,
    };
  }

  /**
   * Ends a session at `endedAt` (now by default; a chain or the silence rule pass the
   * moment they decided on), persists it, closes its open events, and tells subscribers.
   * Does nothing to a session that has already ended.
   */
  async end(session: Session, endedAt = Date.now()): Promise<void> {
    if (session.endedAt !== null) {
      return;
    }
    session.endedAt = endedAt;
    await this.storage.putSession(this.record(session));
    this.emitEvents(session, session.engine.closeAll(session.endedAt));
    this.emit(session, { type: "ended", summary: this.summary(session), reason: "ended" });
    void this.compactAfterEnd(session);
  }

  /**
   * Hands an ended session's frames to a storage backend that compacts, once any
   * append still queued has settled so the compaction sees every frame. Detached from
   * `end` on purpose: the request that ended the session (or the tick, or a chain)
   * must not wait on a bucket rewrite, and a failure is a warning, not an error to the
   * caller; the sweeper retries it within the hour.
   */
  private async compactAfterEnd(session: Session): Promise<void> {
    if (!this.storage.compactSession) {
      return;
    }
    try {
      await session.writeQueue.drain();
      await this.storage.compactSession(session.sessionId, session.frames);
    } catch (err) {
      log.warn("could not compact ended session", {
        session: session.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Removes a session and every frame it held, from storage (the same
   * `deleteSession` the retention sweeper uses) and from memory. A session that is
   * still running is stopped first: its open events are closed and its subscribers get
   * an `ended` event whose reason is `deleted`, after which the stream route closes
   * them. Nothing is persisted on the way out; the record is about to go. Pending
   * frame writes are drained first so a batch in flight cannot recreate the session's
   * files after they were removed. The id then goes into the negative cache marked
   * deleted, so the client's next request and a dashboard reload get a cheap 404 that
   * says why. Chain links on a neighbouring session are left as they are: the dashboard
   * renders a link to a 404, which it already handles.
   */
  async delete(session: Session, now = Date.now()): Promise<DeleteResult> {
    const frames = session.frames.length;
    if (session.endedAt === null) {
      session.endedAt = Math.min(now, sessionEndMs(session));
      this.emitEvents(session, session.engine.closeAll(session.endedAt));
    }
    this.emit(session, { type: "ended", summary: this.summary(session), reason: "deleted" });
    await session.writeQueue.drain();
    await this.storage.deleteSession(session.sessionId);
    this.sessions.delete(session.sessionId);
    this.rememberUnknown(session.sessionId, now, true);
    return { sessionId: session.sessionId, frames };
  }

  /**
   * Frames after the given session-wide index (0 = everything). Resolved by index, not
   * by array position: the two agree only while the frames are exactly 1..n, and a
   * dashboard resuming from `index` after a frame was skipped or merged in would
   * otherwise be handed the wrong slice (silently missing or repeating frames).
   */
  framesAfter(session: Session, index: number): StoredFrame[] {
    if (index <= 0) {
      return session.frames.slice();
    }
    return session.frames.slice(firstIndexAfter(session.frames, index));
  }

  /** Subscribe to live changes. Returns an unsubscribe function. */
  subscribe(session: Session, listener: SessionListener): () => void {
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  /**
   * Gives time-based rules (client silent) a chance to fire on every active session
   * in memory, and ends sessions that have gone quiet. Returns a function that stops
   * the ticker.
   */
  startTicker(intervalMs: number): () => void {
    const timer = setInterval(() => void this.tick(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }

  /**
   * One pass of the periodic work: time-based rules for live sessions, an end for
   * those silent past `endAfterSilentMs`, eviction for idle ended ones. Silence is
   * measured on the server clock (`receivedAt` of the newest frame, or the session's
   * start), so a client with a skewed clock is not ended for it.
   */
  async tick(now: number): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      if (this.status(session, now) === "active") {
        const lastHeardAt = session.frames.at(-1)?.receivedAt ?? session.startedAt;
        if (now - lastHeardAt > this.options.endAfterSilentMs) {
          await this.endAfterSilence(session, lastHeardAt + this.options.endAfterSilentMs);
          continue;
        }
        this.emitEvents(session, session.engine.onTick(now));
      } else if (
        session.listeners.size === 0 &&
        now - session.lastAccessAt > this.options.evictEndedAfterMs
      ) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /** Ends a session the client went quiet on; a failed write is logged and retried on the next tick. */
  private async endAfterSilence(session: Session, endedAt: number): Promise<void> {
    try {
      await this.end(session, endedAt);
      console.log(
        `[session ${session.sessionId}] ended after ${this.options.endAfterSilentMs / 1000}s of silence`,
      );
    } catch (err) {
      // `end` set endedAt before the write; undo so the next tick tries again.
      session.endedAt = null;
      console.error(
        `[session ${session.sessionId}] could not persist the silent end: ${String(err)}`,
      );
    }
  }

  /**
   * Resolves once every storage append queued so far, on every session in memory, has
   * settled. Shutdown waits on this so an accepted batch is never left half-written.
   */
  async drainWrites(): Promise<void> {
    const drains = [...this.sessions.values()].map((session) => session.writeQueue.drain());
    await Promise.all(drains);
  }

  /**
   * Writes whatever the storage backend still holds in memory (the bucket backend's
   * slabs) to durable storage; nothing to do for a backend that writes through.
   * Shutdown calls it after `drainWrites`, so every accepted batch is in the buffer
   * it flushes.
   */
  async flushStorage(): Promise<void> {
    await this.storage.flush?.();
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
      log.info(`${state} ${event.kind} (${event.severity}): ${event.message}`, {
        session: session.sessionId,
      });
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
   * A frame of a stream the session has no room for (`maxStreamsPerSession`) is skipped
   * too and its stream reported in `rejectedStreams`, so the rest of the batch still
   * lands; the frames route answers 422 only when every frame in the batch was one.
   *
   * Admission (de-duplication, the stream cap, the index each new frame gets) is decided
   * inside the session's write queue, together with the write it leads to. The senders
   * of one session run concurrently (an `afk start` and every `afk run` joined to it
   * each have their own), and two batches admitted against the same in-memory state
   * would both take the same next index, which the dashboard drops as already seen, and
   * both pass a stream cap with one slot left.
   *
   * Frames are persisted before the in-memory state advances, so a failed write leaves the
   * session untouched and the client's retry is not mistaken for a duplicate.
   */
  async ingest(session: Session, frames: Frame[]): Promise<IngestResult> {
    const receivedAt = Date.now();
    session.lastAccessAt = receivedAt;
    return session.writeQueue.run(async () => {
      if (session.mergeStorageBeforeIngest) {
        session.mergeStorageBeforeIngest = false;
        await this.mergeFramesFromStorage(session);
      }
      const { nextSequence, nextIndex, byteCount, ...result } = this.admit(
        session,
        frames,
        receivedAt,
      );
      if (result.accepted.length === 0) {
        return result;
      }

      await this.storage.appendFrames(session.sessionId, result.accepted);

      session.latestSequence = nextSequence;
      session.nextIndex = nextIndex;
      session.byteCount = byteCount;
      session.frames.push(...result.accepted);
      this.emit(session, { type: "frames", frames: result.accepted });
      this.emitEvents(session, session.engine.onFrames(result.accepted));
      return result;
    });
  }

  /** The admission decision for one batch against the session's state right now. */
  private admit(
    session: Session,
    frames: Frame[],
    receivedAt: number,
  ): IngestResult & {
    nextSequence: Map<string, number>;
    nextIndex: number;
    byteCount: number;
  } {
    const accepted: StoredFrame[] = [];
    const rejectedStreams: string[] = [];
    const nextSequence = new Map(session.latestSequence);
    let duplicates = 0;
    // One past the highest index the session holds, not a count of its frames: a frame
    // that could not be read back, or one merged in from another writer, must not shift
    // the numbering onto indexes that are already in use.
    let nextIndex = session.nextIndex;
    let byteCount = session.byteCount;
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
        if (!rejectedStreams.includes(frame.stream)) {
          rejectedStreams.push(frame.stream);
        }
        continue;
      }
      nextSequence.set(frame.stream, frame.sequence);
      if (nextIndex > this.options.limits.maxFramesPerSession) {
        throw new TooManyFramesError(this.options.limits.maxFramesPerSession);
      }
      const stored: StoredFrame = { index: nextIndex++, receivedAt, frame };
      byteCount += storedFrameBytes(stored);
      if (byteCount > this.options.limits.maxBytesPerSession) {
        throw new TooManyBytesError(this.options.limits.maxBytesPerSession);
      }
      accepted.push(stored);
    }
    return { accepted, duplicates, rejectedStreams, nextSequence, nextIndex, byteCount };
  }
}
