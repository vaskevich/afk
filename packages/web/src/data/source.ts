import type { AnomalyEvent, FramesResponse, SessionSummary, StoredFrame } from "@afk/shared";

/** Delivered by `subscribe` as live data arrives. */
export interface SubscribeHandlers {
  /** One or more new frames, in index order, all with index > the resume cursor. */
  onFrames(frames: StoredFrame[]): void;
  /** The session summary changed (sent on connect, and when the session ends). */
  onSession(session: SessionSummary): void;
  /**
   * An anomaly event opened, changed, or closed. The server sends every existing event
   * as a snapshot on connect, then one per change; consumers upsert by `id`.
   */
  onEvent(event: AnomalyEvent): void;
  /** Transport state, for a small "live / reconnecting" indicator. */
  onConnection(state: ConnectionState): void;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "closed";

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
}

export const DEMO_SESSION_ID = "demo";
