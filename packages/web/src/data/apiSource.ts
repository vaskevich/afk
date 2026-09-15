import {
  AnomalyEvent,
  DeletedSessionDetails,
  ErrorResponse,
  FramesResponse,
  SessionSummary,
  StoredFrame,
  StreamEndEvent,
  StreamEventName,
} from "@afk/shared";
import { SessionGoneError, type SessionSource } from "./source.ts";

/** How long to buffer incoming frames before handing them to React, to avoid a render per frame during replay. */
const FLUSH_INTERVAL_MS = 100;

const sessionPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`;

/** The server's `error` line from a failed response, or null when the body is not an ErrorResponse. */
async function errorMessageOf(res: Response): Promise<string | null> {
  try {
    const parsed = ErrorResponse.safeParse(await res.json());
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

/** True when a 404 body says the session was deleted rather than never existed. */
async function saysDeleted(res: Response): Promise<boolean> {
  try {
    const parsed = ErrorResponse.safeParse(await res.clone().json());
    return parsed.success && DeletedSessionDetails.safeParse(parsed.data.details).success;
  } catch {
    return false;
  }
}

/** Reads a session from the afk server. In dev, Vite proxies `/api` to the server. */
export const apiSource: SessionSource = {
  async load(sessionId) {
    const res = await fetch(`${sessionPath(sessionId)}/frames`);
    if (res.status === 404) {
      throw new SessionGoneError(sessionId, (await saysDeleted(res)) ? "deleted" : "not-found");
    }
    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }
    return FramesResponse.parse(await res.json());
  },

  async deleteSession(sessionId) {
    // No token: the dashboard never has one, and the link is enough.
    const res = await fetch(sessionPath(sessionId), { method: "DELETE" });
    if (!res.ok) {
      const message = await errorMessageOf(res);
      throw new Error(message ?? `Server returned ${res.status}`);
    }
  },

  subscribe(sessionId, afterIndex, handlers) {
    const source = new EventSource(`${sessionPath(sessionId)}/stream?after=${afterIndex}`);
    let pending: StoredFrame[] = [];
    let flushTimer: number | null = null;
    let closed = false;

    const flush = () => {
      flushTimer = null;
      if (pending.length === 0) {
        return;
      }
      const batch = pending;
      pending = [];
      handlers.onFrames(batch);
    };

    handlers.onConnection("connecting");
    source.onopen = () => handlers.onConnection("live");
    // EventSource reconnects on its own and resends Last-Event-ID; we only report it.
    source.onerror = () => {
      if (closed) {
        return;
      }
      handlers.onConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    };
    source.addEventListener(StreamEventName.Frame, (e: MessageEvent<string>) => {
      const parsed = StoredFrame.safeParse(JSON.parse(e.data));
      if (!parsed.success) {
        // TODO(hardening): surface schema drift between server and dashboard
        return;
      }
      pending.push(parsed.data);
      flushTimer ??= window.setTimeout(flush, FLUSH_INTERVAL_MS);
    });
    source.addEventListener(StreamEventName.Session, (e: MessageEvent<string>) => {
      handlers.onSession(SessionSummary.parse(JSON.parse(e.data)));
    });
    source.addEventListener(StreamEventName.Event, (e: MessageEvent<string>) => {
      const parsed = AnomalyEvent.safeParse(JSON.parse(e.data));
      if (!parsed.success) {
        // TODO(hardening): surface schema drift between server and dashboard
        return;
      }
      handlers.onEvent(parsed.data);
    });
    source.addEventListener(StreamEventName.End, (e: MessageEvent<string>) => {
      flush();
      const { reason, ...summary } = StreamEndEvent.parse(JSON.parse(e.data));
      handlers.onSession(summary);
      // The server closes the stream after `end`; close first so EventSource doesn't reconnect.
      closed = true;
      source.close();
      handlers.onConnection("closed");
      handlers.onEnd(reason);
    });

    return () => {
      closed = true;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
      }
      source.close();
    };
  },
};
