import { Hono } from "hono";
import type { IngestResponse } from "@afk/shared";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse } from "../http/errors.ts";
import { limitBody } from "../middleware/body-limit.ts";
import { clientVersion } from "../middleware/client-version.ts";
import { ingestAuth } from "../middleware/ingest-auth.ts";
import { TooManyStreamsError } from "../store/sessions.ts";
import { parseFrames } from "../utils/ndjson.ts";
import { describeFrame } from "../log/describe.ts";

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
        if (err instanceof TooManyStreamsError) {
          // 422 rather than 4xx-generic so the client knows the batch itself was well formed.
          return errorResponse(c, 422, err.message, { stream: err.stream, limit: err.limit });
        }
        throw err;
      }
      for (const stored of result.accepted) {
        console.log(`[session ${session.sessionId}] ${describeFrame(stored.frame)}`);
      }
      if (result.duplicates > 0) {
        console.log(
          `[session ${session.sessionId}] skipped ${result.duplicates} duplicate frame(s)`,
        );
      }
      const body: IngestResponse = {
        accepted: result.accepted.length,
        duplicates: result.duplicates,
        latestSequence: Object.fromEntries(session.latestSequence),
      };
      return c.json(body);
    },
  );
}
