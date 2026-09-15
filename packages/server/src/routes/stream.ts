import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { StreamEventName } from "@afk/shared";
import type {
  AnomalyEvent,
  FramesResponse,
  StoredFrame,
  StreamEndEvent,
  StreamEndReason,
} from "@afk/shared";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse, sessionNotFound } from "../http/errors.ts";
import type { Session, SessionEvent } from "../store/sessions.ts";
import { SerialQueue } from "../utils/serial-queue.ts";

/**
 * What a viewer refused for lack of SSE capacity is told to wait before retrying. The
 * dashboard's EventSource reconnects on its own; a short wait is enough for a
 * connection that was closing to have been released.
 */
const SSE_CAPACITY_RETRY_AFTER_SECONDS = 10;

/** Parses the resume cursor: `Last-Event-ID` header wins, then `?after=`, else from the start. */
function resumeIndex(lastEventId: string | undefined, afterQuery: string | undefined): number {
  const raw = lastEventId ?? afterQuery ?? "0";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Read side of a session, for the dashboard. Mounted at /api/sessions. No auth: the
 * session id is the unguessable share link. Ingest stays behind the bearer token.
 */
export function streamRoutes(deps: AppDeps) {
  const { store, config } = deps;

  return new Hono<AppEnv>()
    .get("/:sessionId/frames", async (c) => {
      const sessionId = c.req.param("sessionId");
      const session = await store.get(sessionId);
      if (!session) {
        return sessionNotFound(c, store.wasDeleted(sessionId));
      }
      const after = resumeIndex(undefined, c.req.query("after"));
      const body: FramesResponse = {
        session: store.summary(session),
        frames: store.framesAfter(session, after),
        events: session.engine.events,
      };
      return c.json(body);
    })
    .get("/:sessionId/stream", async (c) => {
      const sessionId = c.req.param("sessionId");
      const session = await store.get(sessionId);
      if (!session) {
        return sessionNotFound(c, store.wasDeleted(sessionId));
      }
      const after = resumeIndex(c.req.header("last-event-id"), c.req.query("after"));
      // Counted before the first write and released in serveSession's finally, so the
      // caps hold whether the stream ends by replay, by the session ending, or by the
      // viewer going away.
      const admission = store.openSseConnection(session);
      if (admission !== "admitted") {
        c.header("Retry-After", String(SSE_CAPACITY_RETRY_AFTER_SECONDS));
        const { limits } = config;
        const reason =
          admission === "session-full"
            ? `this session already has ${limits.maxSseConnectionsPerSession} open streams`
            : `the server already has ${limits.maxSseConnections} open streams`;
        return errorResponse(c, 503, `${reason}; try again later`);
      }
      return streamSSE(c, async (stream) => {
        try {
          await serveSession(stream, session, after);
        } finally {
          store.closeSseConnection(session);
        }
      });
    });

  async function serveSession(stream: SSEStreamingApi, session: Session, after: number) {
    const writeFrame = (f: StoredFrame) =>
      stream.writeSSE({
        event: StreamEventName.Frame,
        id: String(f.index),
        data: JSON.stringify(f),
      });
    const writeSession = () =>
      stream.writeSSE({
        event: StreamEventName.Session,
        data: JSON.stringify(store.summary(session)),
      });
    // The last thing the stream says: the final summary and why it is closing.
    const writeEnd = (reason: StreamEndReason) => {
      const data: StreamEndEvent = { ...store.summary(session), reason };
      return stream.writeSSE({ event: StreamEventName.End, data: JSON.stringify(data) });
    };
    const writeEvent = (e: AnomalyEvent) =>
      stream.writeSSE({ event: StreamEventName.Event, data: JSON.stringify(e) });

    await writeSession();
    // Events are few and consumers upsert by id, so the full set is sent every time.
    for (const e of session.engine.events) {
      await writeEvent(e);
    }

    // Subscribe before replaying so nothing that arrives mid-replay is lost. Live events are
    // buffered until the replay finishes, then everything is written through one serial
    // queue so frames always go out in index order.
    let sent = after;
    let replaying = true;
    const buffered: SessionEvent[] = [];
    const queue = new SerialQueue();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));

    const handle = (event: SessionEvent) => {
      void (async () => {
        try {
          await queue.run(async () => {
            if (event.type === "frames") {
              for (const f of event.frames) {
                if (f.index <= sent) {
                  continue;
                }
                await writeFrame(f);
                sent = f.index;
              }
            } else if (event.type === "events") {
              for (const e of event.events) {
                await writeEvent(e);
              }
            } else {
              await writeEnd(event.reason);
              finish();
            }
          });
        } catch {
          finish(); // a write failure means the client went away
        }
      })();
    };

    const unsubscribe = store.subscribe(session, (event) => {
      if (replaying) {
        buffered.push(event);
      } else {
        handle(event);
      }
    });
    // A named event rather than a comment line: both keep proxies from closing an idle
    // stream, but only an event reaches the dashboard, which counts it as a sign of life.
    const keepalive = setInterval(
      () => void stream.writeSSE({ event: StreamEventName.Ping, data: "" }),
      config.sseKeepaliveMs,
    );
    stream.onAbort(() => finish());

    try {
      for (const f of store.framesAfter(session, after)) {
        await writeFrame(f);
        sent = f.index;
      }
      replaying = false;
      for (const event of buffered) {
        handle(event);
      }

      if (store.status(session) !== "active") {
        // TODO(sessions): a session that runs into its cap while still sending frames (an
        // old client that does not chain) expires without an "ended" event; the stream
        // stays open until the client disconnects. A session that goes quiet is ended by
        // the store's tick and does emit one.
        await queue.drain();
        await writeEnd("ended");
        return;
      }
      await done;
    } finally {
      clearInterval(keepalive);
      unsubscribe();
    }
  }
}
