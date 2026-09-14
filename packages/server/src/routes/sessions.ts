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

/** What a client is told to wait before retrying a create that hit the session cap. */
const CAPACITY_RETRY_AFTER_SECONDS = 60;

/**
 * A create request is a few hundred bytes: the schema caps hostname at 256 chars,
 * platform, osVersion, and clientVersion at 64 each, plus three numbers and the JSON
 * punctuation, so under 1 KiB even with every field at its maximum. 4 KiB leaves room
 * for a future optional field or two without inviting anything larger.
 */
export const MAX_CREATE_BODY_BYTES = 4 * 1024;

/** Session lifecycle: create, inspect, end. Mounted at /api/sessions. */
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
      const dashboardUrl = `${config.publicBaseUrl}/s/${session.sessionId}`;
      console.log(
        `[session ${session.sessionId}] created for ${session.host.hostname} ` +
          `(client ${session.clientVersion}, ${session.host.cpuCount} cpus) -> ${dashboardUrl}`,
      );
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
      console.log(
        `[session ${session.sessionId}] ended by client after ${session.frames.length} frames`,
      );
      return c.json(store.summary(session));
    });
}
