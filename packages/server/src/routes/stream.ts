import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { StreamEventName } from "@afk/shared";
import type { FramesResponse, StoredFrame } from "@afk/shared";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse } from "../http/errors.ts";
import type { Session, SessionEvent } from "../store/sessions.ts";

/** How often to send an SSE comment so proxies and browsers keep the connection open. */
const KEEPALIVE_INTERVAL_MS = 15_000;

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
  const { store } = deps;

  return new Hono<AppEnv>()
    .get("/:sessionId/frames", (c) => {
      const session = store.get(c.req.param("sessionId"));
      if (!session) return errorResponse(c, 404, "unknown session");
      const after = resumeIndex(undefined, c.req.query("after"));
      const body: FramesResponse = {
        session: store.summary(session),
        frames: store.framesAfter(session, after),
      };
      return c.json(body);
    })
    .get("/:sessionId/stream", (c) => {
      const session = store.get(c.req.param("sessionId"));
      if (!session) return errorResponse(c, 404, "unknown session");
      const after = resumeIndex(c.req.header("last-event-id"), c.req.query("after"));
      return streamSSE(c, (stream) => serveSession(stream, session, after));
    });

  async function serveSession(stream: SSEStreamingApi, session: Session, after: number) {
    const writeFrame = (f: StoredFrame) =>
      stream.writeSSE({
        event: StreamEventName.Frame,
        id: String(f.index),
        data: JSON.stringify(f),
      });
    const writeSummary = (event: string) =>
      stream.writeSSE({ event, data: JSON.stringify(store.summary(session)) });

    await writeSummary(StreamEventName.Session);

    // Subscribe before replaying so nothing that arrives mid-replay is lost. Live events are
    // buffered until the replay finishes, then everything is written through one serial
    // queue so frames always go out in index order.
    let sent = after;
    let replaying = true;
    const buffered: SessionEvent[] = [];
    let queue = Promise.resolve();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));

    const handle = (event: SessionEvent) => {
      queue = queue
        .then(async () => {
          if (event.type === "frames") {
            for (const f of event.frames) {
              if (f.index <= sent) continue;
              await writeFrame(f);
              sent = f.index;
            }
          } else {
            await writeSummary(StreamEventName.End);
            finish();
          }
        })
        .catch(finish); // a write failure means the client went away
    };

    const unsubscribe = store.subscribe(session, (event) => {
      if (replaying) buffered.push(event);
      else handle(event);
    });
    const keepalive = setInterval(
      () => void stream.write(": keepalive\n\n"),
      KEEPALIVE_INTERVAL_MS,
    );
    stream.onAbort(() => finish());

    try {
      for (const f of store.framesAfter(session, after)) {
        await writeFrame(f);
        sent = f.index;
      }
      replaying = false;
      for (const event of buffered) handle(event);

      if (store.status(session) !== "active") {
        // TODO(sessions): a session that hits the max duration without an explicit end never
        // emits "ended"; the stream stays open until the client disconnects.
        await queue;
        await writeSummary(StreamEventName.End);
        return;
      }
      await done;
    } finally {
      clearInterval(keepalive);
      unsubscribe();
    }
  }
}
