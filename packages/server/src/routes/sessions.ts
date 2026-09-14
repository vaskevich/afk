import { Hono } from "hono";
import type { Context } from "hono";
import { CreateSessionRequest, PROTOCOL_VERSION } from "@afk/shared";
import type { CreateSessionResponse } from "@afk/shared";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse } from "../http/errors.ts";
import { limitBody } from "../middleware/body-limit.ts";
import {
  clientVersion,
  isAcceptedProtocolVersion,
  upgradeRequired,
} from "../middleware/client-version.ts";
import { ingestAuth } from "../middleware/ingest-auth.ts";
import { log } from "../log/logger.ts";
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

/**
 * Session lifecycle: create, inspect, end, and the dashboard URL as a QR code.
 * Mounted at /api/sessions. The QR sits behind the ingest token because the URL is the
 * share link: only the session's owner gets it rendered, and the dashboard draws its
 * own copy in the browser.
 */
export function sessionRoutes(deps: AppDeps) {
  const { store, config } = deps;

  return new Hono<AppEnv>()
    .post("/", clientVersion(deps), limitBody(MAX_CREATE_BODY_BYTES), async (c) => {
      if (!store.hasCapacity()) {
        // TODO(hardening): also rate limit creation per client address.
        c.header("Retry-After", String(CAPACITY_RETRY_AFTER_SECONDS));
        return errorResponse(
          c,
          503,
          `server is at capacity (${config.limits.maxActiveSessions} active sessions); try again later`,
        );
      }

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

      const session = await store.create({
        host: parsed.data.host,
        clientVersion: parsed.data.clientVersion,
      });
      const dashboardUrl = dashboardUrlFor(config.publicBaseUrl, session.sessionId);
      log.info("session created", {
        session: session.sessionId,
        host: session.host.hostname,
        client: session.clientVersion,
        cpus: session.host.cpuCount,
        url: dashboardUrl,
      });
      const body: CreateSessionResponse = {
        sessionId: session.sessionId,
        ingestToken: session.ingestToken,
        dashboardUrl,
        maxDurationSeconds: session.maxDurationSeconds,
      };
      // NOTE: the bash client extracts fields from this response with sed, relying on the
      // compact (no whitespace) JSON that c.json() emits.
      return c.json(body, 201);
    })
    .get("/:sessionId", async (c) => {
      const session = await store.get(c.req.param("sessionId"));
      if (!session) {
        return errorResponse(c, 404, "unknown session");
      }
      return c.json(store.summary(session));
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
    });
}
