import { Hono } from "hono";
import type { Context } from "hono";
import { CreateSessionRequest, DEMO_SESSION_ID, PROTOCOL_VERSION } from "@afk/shared";
import type { CreateSessionResponse, DeleteSessionResponse } from "@afk/shared";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse, sessionNotFound } from "../http/errors.ts";
import { limitBody } from "../middleware/body-limit.ts";
import {
  clientVersion,
  isAcceptedProtocolVersion,
  upgradeRequired,
} from "../middleware/client-version.ts";
import { bearerMatchesSession, ingestAuth } from "../middleware/ingest-auth.ts";
import { log } from "../log/logger.ts";
import { AlreadyContinuedError, type CreatedSession, type Session } from "../store/sessions.ts";
import { renderQrSvg, renderQrText } from "../utils/qr.ts";

/** Parses the request body as JSON, or null if it isn't valid JSON. */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** The body's `protocolVersion` when it is a number, before schema validation; undefined otherwise. */
function protocolVersionOf(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null || !("protocolVersion" in body)) {
    return undefined;
  }
  const version = (body as { protocolVersion: unknown }).protocolVersion;
  return typeof version === "number" ? version : undefined;
}

/** `?format=` values `GET /:sessionId/qr` accepts; the default is text for the terminal. */
const QR_FORMAT_TEXT = "text";
const QR_FORMAT_SVG = "svg";
const QR_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const QR_SVG_CONTENT_TYPE = "image/svg+xml";

/** What a client is told to wait before retrying a create that hit the session cap. */
const CAPACITY_RETRY_AFTER_SECONDS = 60;

/**
 * A create request is a few hundred bytes: the schema caps hostname at 256 chars,
 * platform, osVersion, and clientVersion at 64 each, plus three numbers and the JSON
 * punctuation, so under 1 KiB even with every field at its maximum. 4 KiB leaves room
 * for a future optional field or two without inviting anything larger.
 */
export const MAX_CREATE_BODY_BYTES = 4 * 1024;

/** The share link: where the dashboard for `sessionId` lives on this deployment. */
function dashboardUrlFor(publicBaseUrl: string, sessionId: string): string {
  return `${publicBaseUrl}/s/${sessionId}`;
}

/** Why a chain request's `previousSessionId` was refused, with the status to answer. */
type PreviousSessionRefusal = { status: 401 | 404; message: string };

/** What `DELETE /api/sessions/demo` answers; the dashboard's fixture session is not a record here. */
export const DEMO_SESSION_DELETE_MESSAGE = "the demo session cannot be deleted";

/**
 * The demo session (`/s/demo`) lives in the dashboard as a fixture, not on the server,
 * and its id is not one the server issues, so the id check in front of every session
 * route would answer 404 for it. This sub-app is mounted ahead of that check so a
 * delete of the demo is refused by name (403) rather than reported as unknown, and so
 * nothing anyone could send would ever "delete the demo".
 */
export function demoSessionRoutes() {
  return new Hono<AppEnv>().delete(`/${DEMO_SESSION_ID}`, (c) =>
    errorResponse(c, 403, DEMO_SESSION_DELETE_MESSAGE),
  );
}

/**
 * Session lifecycle: create, inspect, end, delete, and the dashboard URL as a QR code.
 * Mounted at /api/sessions. The QR sits behind the ingest token because the URL is the
 * share link: only the session's owner gets it rendered, and the dashboard draws its
 * own copy in the browser.
 */
export function sessionRoutes(deps: AppDeps) {
  const { store, config } = deps;

  /**
   * The session a create request wants to continue. Chaining is proven the same way as
   * every other write to a session: the previous session's ingest token as the bearer.
   * Unlike ingest, an ended or expired session may still be chained from, so a client
   * that was late (the machine slept through the cap) still gets its successor linked.
   */
  async function resolvePreviousSession(
    c: Context<AppEnv>,
    previousSessionId: string,
  ): Promise<Session | PreviousSessionRefusal> {
    const previous = await store.get(previousSessionId);
    if (!previous) {
      return { status: 404, message: "unknown previous session" };
    }
    if (!bearerMatchesSession(c.req.header("authorization"), previous)) {
      return { status: 401, message: "bad ingest token for the previous session" };
    }
    return previous;
  }

  return (
    new Hono<AppEnv>()
      .post("/", clientVersion(deps), limitBody(MAX_CREATE_BODY_BYTES), async (c) => {
        const request = await readJsonBody(c);
        // The schema would reject an out-of-range protocolVersion with a 400 like any other
        // invalid field; intercept it first so an old client gets the upgrade message instead.
        const protocolVersion = protocolVersionOf(request);
        if (
          protocolVersion !== undefined &&
          !isAcceptedProtocolVersion(protocolVersion, config.minimumVersions)
        ) {
          return upgradeRequired(
            c,
            config.minimumVersions,
            `protocol version ${protocolVersion} is not supported; this server accepts ` +
              `${config.minimumVersions.protocolVersion} to ${PROTOCOL_VERSION}`,
            c.get("clientVersion"),
          );
        }

        const parsed = CreateSessionRequest.safeParse(request);
        if (!parsed.success) {
          return errorResponse(c, 400, "invalid session request", parsed.error.flatten());
        }

        let previous: Session | undefined;
        if (parsed.data.previousSessionId !== undefined) {
          const resolved = await resolvePreviousSession(c, parsed.data.previousSessionId);
          if (!("sessionId" in resolved)) {
            return errorResponse(c, resolved.status, resolved.message);
          }
          previous = resolved;
        }

        // A chain from a still-active session frees that session's slot as it takes one,
        // so it is admitted at capacity; anything else waits for room.
        const replacesActiveSession = previous !== undefined && store.status(previous) === "active";
        if (!store.hasCapacity() && !replacesActiveSession) {
          // TODO(hardening): also rate limit creation per client address.
          c.header("Retry-After", String(CAPACITY_RETRY_AFTER_SECONDS));
          return errorResponse(
            c,
            503,
            `server is at capacity (${config.limits.maxActiveSessions} active sessions); try again later`,
          );
        }

        let created: CreatedSession;
        try {
          created = await store.create({
            host: parsed.data.host,
            clientVersion: parsed.data.clientVersion,
            previous,
          });
        } catch (err) {
          if (err instanceof AlreadyContinuedError) {
            return errorResponse(c, 409, err.message, { nextSessionId: err.nextSessionId });
          }
          throw err;
        }
        // The only place the token exists in clear on the server side: this response.
        const { session, ingestToken } = created;
        const dashboardUrl = dashboardUrlFor(config.publicBaseUrl, session.sessionId);
        log.info("session created", {
          session: session.sessionId,
          host: session.host.hostname,
          client: session.clientVersion,
          cpus: session.host.cpuCount,
          url: dashboardUrl,
          ...(previous ? { continues: previous.sessionId } : {}),
        });
        if (previous) {
          log.info(
            replacesActiveSession ? "session ended by chain" : "session linked to successor",
            {
              session: previous.sessionId,
              frames: previous.frames.length,
              next: session.sessionId,
            },
          );
        }
        const body: CreateSessionResponse = {
          sessionId: session.sessionId,
          ingestToken,
          dashboardUrl,
          maxDurationSeconds: session.maxDurationSeconds,
          // Advice, not a floor (the 426 above is the floor): the client says so on stderr
          // and, on a terminal, offers to run the installer. Omitted without a client script.
          ...(config.latestClientVersion === null
            ? {}
            : { latestClientVersion: config.latestClientVersion }),
        };
        // NOTE: the bash client extracts fields from this response with sed, relying on the
        // compact (no whitespace) JSON that c.json() emits.
        return c.json(body, 201);
      })
      .get("/:sessionId", async (c) => {
        const sessionId = c.req.param("sessionId");
        const session = await store.get(sessionId);
        if (!session) {
          return sessionNotFound(c, store.wasDeleted(sessionId));
        }
        return c.json(store.summary(session));
      })
      // Two callers: the client, which sends its ingest token like every other write,
      // and the dashboard, which has no token and sends none. Holding the link is holding
      // the session (the id is the secret; see the decision log in docs/ARCHITECTURE.md),
      // so a request without a bearer is allowed; one with a bearer must have the right
      // one, so a client with a stale token learns that rather than deleting blindly.
      // Not version-checked: the dashboard sends no X-Afk-Client. Idempotent: a second
      // delete, or one of an id that never existed, is the same 404 as any other read.
      .delete("/:sessionId", async (c) => {
        const sessionId = c.req.param("sessionId");
        const session = await store.get(sessionId);
        if (!session) {
          return sessionNotFound(c, store.wasDeleted(sessionId));
        }
        const auth = c.req.header("authorization");
        if (auth !== undefined && !bearerMatchesSession(auth, session)) {
          return errorResponse(c, 401, "bad ingest token");
        }
        const wasActive = store.status(session) === "active";
        const result = await store.delete(session);
        log.info("session deleted", {
          session: result.sessionId,
          frames: result.frames,
          wasActive,
          by: auth === undefined ? "link" : "client",
        });
        const body: DeleteSessionResponse = result;
        return c.json(body);
      })
      .post("/:sessionId/end", clientVersion(deps), ingestAuth(deps), async (c) => {
        const session = c.get("session");
        await store.end(session);
        log.info("session ended by client", {
          session: session.sessionId,
          frames: session.frames.length,
        });
        return c.json(store.summary(session));
      })
      .get("/:sessionId/qr", clientVersion(deps), ingestAuth(deps), (c) => {
        const format = c.req.query("format") ?? QR_FORMAT_TEXT;
        const dashboardUrl = dashboardUrlFor(config.publicBaseUrl, c.get("session").sessionId);
        if (format === QR_FORMAT_SVG) {
          return c.body(renderQrSvg(dashboardUrl), 200, { "content-type": QR_SVG_CONTENT_TYPE });
        }
        if (format === QR_FORMAT_TEXT) {
          return c.body(renderQrText(dashboardUrl), 200, { "content-type": QR_TEXT_CONTENT_TYPE });
        }
        return errorResponse(
          c,
          400,
          `unknown format "${format}"; use ${QR_FORMAT_TEXT} or ${QR_FORMAT_SVG}`,
        );
      })
  );
}
