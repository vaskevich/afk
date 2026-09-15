import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CLIENT_HEADER } from "@afk/shared";
import type { DeletedSessionDetails, ErrorResponse } from "@afk/shared";
import { log } from "../log/logger.ts";

/** Responses from this status up are logged; below it a response is a success. */
const CLIENT_ERROR_STATUS = 400;
/** Responses from this status up are the server's own fault, so they are logged at `warn`. */
const SERVER_ERROR_STATUS = 500;

/** What a client sees for an error no route handled; the detail stays in the log. */
export const INTERNAL_ERROR_MESSAGE = "internal server error";

/**
 * The one place every error response is built, so it is also the one place they are
 * logged. Anything 400 and up gets a line at `info` (`warn` from 500) with the method,
 * path, status, message, the session id when the route has one, and the `X-Afk-Client`
 * header, which is what tells an old client apart from a broken one. The ingest token
 * and the Authorization header are never logged.
 *
 * Why at `info`: these responses used to show only as the `debug` "request" line from
 * middleware/request-timing.ts, and without the message, so at the default level a beta
 * user stuck on 426 or 410 was invisible to the operator.
 */
export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  details?: unknown,
) {
  logErrorResponse(c, status, message);
  const body: ErrorResponse = { error: message, details };
  return c.json(body, status);
}

function logErrorResponse(c: Context, status: number, message: string): void {
  if (status < CLIENT_ERROR_STATUS) {
    return;
  }
  const context = {
    method: c.req.method,
    path: c.req.path,
    status,
    session: c.req.param("sessionId"),
    client: c.req.header(CLIENT_HEADER),
    error: message,
  };
  if (status >= SERVER_ERROR_STATUS) {
    log.warn("request failed", context);
  } else {
    log.info("request rejected", context);
  }
}

/**
 * `app.onError`: what answers a route that threw. Without one, Hono writes the raw stack
 * with `console.error` (outside the logger, so with no session id and no level) and
 * answers a plain-text `Internal Server Error` body, which the bash client prints
 * verbatim. This logs the stack through `log.error` and answers the same
 * `ErrorResponse` shape as every other failure, minus the stack: a thrown error is the
 * server's bug, not something to hand a client.
 */
export function unhandledError(err: Error, c: Context) {
  // An HTTPException carries its own status and message, so it is a deliberate refusal
  // from somewhere below rather than a bug: answer it like any other error response.
  if (err instanceof HTTPException) {
    return errorResponse(c, err.status, err.message);
  }
  log.error("unhandled error", {
    method: c.req.method,
    path: c.req.path,
    session: c.req.param("sessionId"),
    client: c.req.header(CLIENT_HEADER),
    error: err.message,
    stack: err.stack,
  });
  const body: ErrorResponse = { error: INTERNAL_ERROR_MESSAGE };
  return c.json(body, SERVER_ERROR_STATUS);
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
