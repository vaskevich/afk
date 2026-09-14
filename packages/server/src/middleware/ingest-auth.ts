import { createMiddleware } from "hono/factory";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse, sessionNotFound } from "../http/errors.ts";

/**
 * Resolves `:sessionId`, checks the bearer ingest token, and rejects sessions that are
 * no longer active with 410 Gone (the client treats that as "stop sending"). A session
 * that was deleted answers 404 (with `reason: "deleted"` while the store remembers it),
 * which the client treats as "the session is gone for good: stop, and do not chain".
 */
export function ingestAuth({ store }: AppDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const sessionId = c.req.param("sessionId") ?? "";
    const session = await store.get(sessionId);
    if (!session) {
      return sessionNotFound(c, store.wasDeleted(sessionId));
    }

    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${session.ingestToken}`) {
      return errorResponse(c, 401, "bad ingest token");
    }

    const status = store.status(session);
    if (status !== "active") {
      return errorResponse(c, 410, `session ${status}`);
    }

    c.set("session", session);
    await next();
  });
}
