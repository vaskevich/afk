import { createMiddleware } from "hono/factory";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse, sessionNotFound } from "../http/errors.ts";
import type { Session } from "../store/sessions.ts";
import { ingestTokenMatches } from "../utils/ingest-token.ts";

const BEARER_PREFIX = "Bearer ";

/**
 * Whether an `Authorization` header value is `Bearer <the session's ingest token>`.
 * The token is compared through its hash in constant time (`utils/ingest-token.ts`);
 * the session holds only the hash. Every route that takes the token as proof of
 * ownership (ingest, end, qr, chaining from a previous session, a client's delete)
 * goes through here so there is one comparison to get right.
 */
export function bearerMatchesSession(authorization: string | undefined, session: Session): boolean {
  if (authorization === undefined || !authorization.startsWith(BEARER_PREFIX)) {
    return false;
  }
  return ingestTokenMatches(authorization.slice(BEARER_PREFIX.length), session.ingestTokenHash);
}

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

    if (!bearerMatchesSession(c.req.header("authorization"), session)) {
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
