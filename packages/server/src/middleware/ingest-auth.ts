import { createMiddleware } from "hono/factory";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse } from "../http/errors.ts";

/**
 * Resolves `:sessionId`, checks the bearer ingest token, and rejects sessions that are
 * no longer active with 410 Gone (the client treats that as "stop sending").
 */
export function ingestAuth({ store }: AppDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = await store.get(c.req.param("sessionId") ?? "");
    if (!session) {
      return errorResponse(c, 404, "unknown session");
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
