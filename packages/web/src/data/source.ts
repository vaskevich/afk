import type { FramesResponse } from "@afk/shared";

/**
 * Where a session's data comes from. The session view only talks to this interface,
 * so the fixture used by `/s/demo` and the real API are interchangeable.
 *
 * TODO(streaming): add
 *   subscribe(sessionId: string, afterIndex: number, onFrame: (frame: StoredFrame) => void,
 *             onSession?: (session: SessionSummary) => void): () => void
 * backed by `GET /api/sessions/:id/stream` (SSE, see `StreamEventName` in shared).
 * `StoredFrame.index` is the resume cursor: after `load()` returns, subscribe with
 * `afterIndex = last frame's index` (or 0 for an empty session) and the server replays
 * anything missed; on reconnect the browser's `Last-Event-ID` does the same. The
 * returned function unsubscribes. The fixture implementation can simply no-op, or
 * replay the tail of the generated frames on a timer for local development.
 */
export interface SessionSource {
  load(sessionId: string): Promise<FramesResponse>;
}

export const DEMO_SESSION_ID = "demo";
