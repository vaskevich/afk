import { Hono } from "hono";
import type { Context } from "hono";
import { CreateSessionRequest } from "@afk/shared";
import type { CreateSessionResponse } from "@afk/shared";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse } from "../http/errors.ts";
import { ingestAuth } from "../middleware/ingest-auth.ts";

/** Parses the request body as JSON, or null if it isn't valid JSON. */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** Session lifecycle: create, inspect, end. Mounted at /api/sessions. */
export function sessionRoutes(deps: AppDeps) {
  const { store, config } = deps;

  return new Hono<AppEnv>()
    .post("/", async (c) => {
      const parsed = CreateSessionRequest.safeParse(await readJsonBody(c));
      if (!parsed.success)
        return errorResponse(c, 400, "invalid session request", parsed.error.flatten());

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
      if (!session) return errorResponse(c, 404, "unknown session");
      return c.json(store.summary(session));
    })
    .post("/:sessionId/end", ingestAuth(deps), async (c) => {
      const session = c.get("session");
      await store.end(session);
      console.log(
        `[session ${session.sessionId}] ended by client after ${session.frames.length} frames`,
      );
      return c.json(store.summary(session));
    });
}
