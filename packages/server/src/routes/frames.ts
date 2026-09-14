import { Hono } from "hono";
import type { IngestResponse } from "@afk/shared";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse } from "../http/errors.ts";
import { ingestAuth } from "../middleware/ingest-auth.ts";
import { TooManyStreamsError } from "../store/sessions.ts";
import { parseFrames } from "../utils/ndjson.ts";
import { describeFrame } from "../log/describe.ts";

/** Frame ingest. Mounted at /api/sessions. Body is newline-delimited JSON, one frame per line. */
export function frameRoutes(deps: AppDeps) {
  const { store } = deps;

  return new Hono<AppEnv>().post("/:sessionId/frames", ingestAuth(deps), async (c) => {
    const session = c.get("session");

    // TODO(hardening): cap body size before reading it.
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
      console.log(`[session ${session.sessionId}] skipped ${result.duplicates} duplicate frame(s)`);
    }
    const body: IngestResponse = {
      accepted: result.accepted.length,
      duplicates: result.duplicates,
      latestSequence: Object.fromEntries(session.latestSequence),
    };
    return c.json(body);
  });
}
