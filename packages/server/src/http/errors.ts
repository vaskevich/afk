import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DeletedSessionDetails, ErrorResponse } from "@afk/shared";

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  details?: unknown,
) {
  const body: ErrorResponse = { error: message, details };
  return c.json(body, status);
}

/** What every route answers for an id no session has. */
export const UNKNOWN_SESSION_MESSAGE = "unknown session";
/** The same 404, for an id the store still remembers deleting; `details` says so. */
export const DELETED_SESSION_MESSAGE = "session deleted";
const DELETED_SESSION_DETAILS: DeletedSessionDetails = { reason: "deleted" };

/**
 * The 404 for a session that does not exist: a plain `unknown session`, or, while the
 * store remembers that the id was deleted (`SessionStore.wasDeleted`), `session
 * deleted` with `DeletedSessionDetails`, so the client that was still sending to it and
 * a dashboard that reloads can say why rather than "not found".
 */
export function sessionNotFound(c: Context, deleted: boolean) {
  return deleted
    ? errorResponse(c, 404, DELETED_SESSION_MESSAGE, DELETED_SESSION_DETAILS)
    : errorResponse(c, 404, UNKNOWN_SESSION_MESSAGE);
}
