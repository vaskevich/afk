import { Hono } from "hono";
import type { IngestResponse } from "@afk/shared";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse } from "../http/errors.ts";
import { limitBody } from "../middleware/body-limit.ts";
import { clientVersion } from "../middleware/client-version.ts";
import { ingestAuth } from "../middleware/ingest-auth.ts";
import { TooManyFramesError, type IngestResult } from "../store/sessions.ts";
import { parseFrames } from "../utils/ndjson.ts";
import { describeFrame } from "../log/describe.ts";
import { log } from "../log/logger.ts";

/**
 * One `info` line per batch (an operator can find a session and see it is alive without
 * one line per frame; at the 20 x 10 cap that would be tens of thousands of lines an
 * hour) and one `debug` line per accepted frame. The `afk run` command line is logged
 * at no level: it is typed by the user and, redaction notwithstanding, can carry a
 * secret, and the run's stream id in `describeFrame` is enough to find it.
 */
function logBatch(sessionId: string, result: IngestResult): void {
  const streams = new Set(result.accepted.map((stored) => stored.frame.stream));
  log.info("accepted batch", {
    session: sessionId,
    streams: [...streams].join(","),
    accepted: result.accepted.length,
    duplicates: result.duplicates,
    ...(result.rejectedStreams.length > 0 ? { rejected: result.rejectedStreams.join(",") } : {}),
  });
  if (!log.enabled("debug")) {
    return;
  }
  for (const { frame } of result.accepted) {
    log.debug(describeFrame(frame), { session: sessionId });
  }
}

/**
 * Largest ingest body accepted. The client's sender ships at most
 * SEND_MAX_FILES_PER_BATCH (200) queue files per request, and each file is what its
 * sampler wrote in one SEND_INTERVAL_SECONDS (1 s) rotation: one system frame (about
 * 350 bytes) plus, for an `afk run`, one run frame (about 300 bytes), since a joiner
 * keeps its own spool and sender. So a full batch is roughly 200 x 650 bytes = 130 KB,
 * and 1 MiB is about eight times that, with room for a couple more collectors at 1 Hz
 * before the limit is felt. A queue that has grown past 200 files while the server was
 * unreachable is drained in successive batches, not one big one.
 */
export const MAX_INGEST_BODY_BYTES = 1024 * 1024;

/** Frame ingest. Mounted at /api/sessions. Body is newline-delimited JSON, one frame per line. */
export function frameRoutes(deps: AppDeps) {
  const { store } = deps;

  // Auth before the body limit so an ended session answers 410 (stop) rather than a 413
  // the client would park; the limit checks Content-Length before reading anything.
  return new Hono<AppEnv>().post(
    "/:sessionId/frames",
    clientVersion(deps),
    ingestAuth(deps),
    limitBody(MAX_INGEST_BODY_BYTES),
    async (c) => {
      const session = c.get("session");

      const parsed = parseFrames(await c.req.text());
      if (!parsed.ok) {
        return errorResponse(c, 400, parsed.message, parsed.details);
      }

      let result;
      try {
        result = await store.ingest(session, parsed.frames);
      } catch (err) {
        if (err instanceof TooManyFramesError) {
          // 410: the session is full and will accept nothing more, so the client stops.
          return errorResponse(c, 410, err.message, { limit: err.limit });
        }
        throw err;
      }
      const { rejectedStreams } = result;
      if (rejectedStreams.length > 0 && result.accepted.length === 0 && result.duplicates === 0) {
        // Every frame belongs to a stream the session has no room for (an `afk run`'s
        // first batch, whose stream is new): 422 rather than 4xx-generic so the client
        // knows the batch was well formed, and nothing of it was kept. A batch that also
        // carried known streams is a 200 below, with the rejected ones named.
        const stream = rejectedStreams[0]!;
        const limit = deps.config.limits.maxStreamsPerSession;
        return errorResponse(
          c,
          422,
          `stream "${stream}" would exceed the limit of ${limit} streams per session`,
          { stream, limit },
        );
      }
      logBatch(session.sessionId, result);
      const body: IngestResponse = {
        accepted: result.accepted.length,
        duplicates: result.duplicates,
        latestSequence: Object.fromEntries(session.latestSequence),
        ...(rejectedStreams.length > 0 ? { rejectedStreams } : {}),
      };
      return c.json(body);
    },
  );
}
