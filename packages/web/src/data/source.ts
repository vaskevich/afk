import { DEMO_SESSION_ID } from "@afk/shared";
import type {
  AnomalyEvent,
  FramesResponse,
  SessionSummary,
  StoredFrame,
  StreamEndReason,
} from "@afk/shared";

/** Delivered by `subscribe` as live data arrives. */
export interface SubscribeHandlers {
  /** One or more new frames, in index order, all with index > the resume cursor. */
  onFrames(frames: StoredFrame[]): void;
  /** The session summary changed (sent on connect, and when the session ends). */
  onSession(session: SessionSummary): void;
  /**
   * The stream is over: the session ended (`ended`; `onSession` already carried the
   * final summary) or was deleted under the viewer (`deleted`; the page says so and
   * stops offering to delete it again).
   */
  onEnd(reason: StreamEndReason): void;
  /**
   * An anomaly event opened, changed, or closed. The server sends every existing event
   * as a snapshot on connect, then one per change; consumers upsert by `id`.
   */
  onEvent(event: AnomalyEvent): void;
  /**
   * The server's keepalive, every `EXPECTED_KEEPALIVE_MS` (`freshness.ts`) while the
   * stream has nothing else to say: the only sign of life on a quiet session.
   */
  onPing(): void;
  /** Transport state, for a small "live / reconnecting" indicator. */
  onConnection(state: ConnectionState): void;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "closed";

/** Why a session has nothing to load: never existed (or swept) vs. deleted by its owner. */
export type SessionGoneReason = "not-found" | "deleted";

const GONE_MESSAGES: Record<SessionGoneReason, (sessionId: string) => string> = {
  "not-found": (sessionId) => `Session "${sessionId}" not found`,
  deleted: (sessionId) => `Session "${sessionId}" was deleted`,
};

/**
 * `load` rejects with this when the server has no such session, so the page can say
 * which of the two it was and name the id; any other failure is a plain Error.
 */
export class SessionGoneError extends Error {
  readonly sessionId: string;
  readonly reason: SessionGoneReason;

  constructor(sessionId: string, reason: SessionGoneReason) {
    super(GONE_MESSAGES[reason](sessionId));
    this.name = "SessionGoneError";
    this.sessionId = sessionId;
    this.reason = reason;
  }
}

/**
 * Where a session's data comes from. The session view only talks to this interface,
 * so the fixture used by `/s/demo` and the real API are interchangeable.
 */
export interface SessionSource {
  /** Everything so far: summary, all frames, and the current set of anomaly events. */
  load(sessionId: string): Promise<FramesResponse>;
  /**
   * Follow the session live, starting after `afterIndex` (`StoredFrame.index` is the
   * resume cursor: pass the last index from `load`, or 0 for an empty session). The
   * server replays anything missed and the browser's `Last-Event-ID` does the same on
   * reconnect. Returns an unsubscribe function.
   */
  subscribe(sessionId: string, afterIndex: number, handlers: SubscribeHandlers): () => void;
  /**
   * Deletes the session and everything it recorded from the server. Anyone holding the
   * link may (the id is the secret; see docs/PROTOCOL.md, "Delete"). Rejects with the
   * server's reason when it refuses.
   */
  deleteSession(sessionId: string): Promise<void>;
}

export { DEMO_SESSION_ID };
