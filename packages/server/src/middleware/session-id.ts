import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env.ts";
import { errorResponse } from "../http/errors.ts";
import { isSessionId } from "../utils/ids.ts";

/**
 * Rejects a `:sessionId` that is not the shape the server issues (`SESSION_ID_PATTERN`
 * in utils/ids.ts) with the same 404 an unknown session gets, before any route or
 * storage backend looks at it. Mounted once in app.ts on `/api/sessions/:sessionId/*`,
 * which Hono also matches for the bare `/api/sessions/:sessionId`, so the summary,
 * frames, stream, qr, end, and ingest routes are all covered.
 *
 * Without it a malformed id reached `S3SessionStorage.prefix`, which throws, so the
 * hosted instance answered 500 where disk storage answered 404. Well-formed unknown ids
 * still get through to the store, whose negative cache keeps repeated probes of the
 * same id from costing a storage read each.
 */
export function sessionIdParam() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const sessionId = c.req.param("sessionId");
    if (sessionId !== undefined && !isSessionId(sessionId)) {
      return errorResponse(c, 404, "unknown session");
    }
    await next();
  });
}
