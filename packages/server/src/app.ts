import { Hono } from "hono";
import { Frame, CreateSessionRequest, PROTOCOL_VERSION } from "@afk/shared";
import type { CreateSessionResponse, ErrorResponse, IngestResponse } from "@afk/shared";
import { SessionStore, type Session } from "./sessions.ts";
import { describeFrame } from "./describe.ts";

export interface AppConfig {
  /** Public origin used to build dashboard URLs, e.g. https://afk.osv.im */
  publicBaseUrl: string;
}

// TODO(hardening): security headers, request body size limit, per-session rate limit,
// global active-session cap, minimum client version check. See BACKLOG.md.

export function createApp(config: AppConfig, store = new SessionStore()) {
  const app = new Hono();

  const error = (message: string, details?: unknown): ErrorResponse => ({ error: message, details });

  app.get("/api/health", (c) => c.json({ ok: true, protocolVersion: PROTOCOL_VERSION }));

  app.post("/api/sessions", async (c) => {
    const parsed = CreateSessionRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(error("invalid session request", parsed.error.flatten()), 400);

    const session = store.create({ host: parsed.data.host, clientVersion: parsed.data.clientVersion });
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
  });

  /** Resolves the session for an ingest-style request and checks the bearer token. */
  function authorize(c: { req: { param: (k: string) => string | undefined; header: (k: string) => string | undefined } }):
    | { session: Session }
    | { status: 401 | 404 | 410; message: string } {
    const session = store.get(c.req.param("sessionId") ?? "");
    if (!session) return { status: 404, message: "unknown session" };
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${session.ingestToken}`) return { status: 401, message: "bad ingest token" };
    const status = store.status(session);
    if (status !== "active") return { status: 410, message: `session ${status}` };
    return { session };
  }

  app.post("/api/sessions/:sessionId/frames", async (c) => {
    const auth = authorize(c);
    if ("status" in auth) return c.json(error(auth.message), auth.status);

    const text = await c.req.text();
    const frames: Frame[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === "") continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        return c.json(error(`line ${i + 1} is not valid JSON`), 400);
      }
      const parsed = Frame.safeParse(json);
      if (!parsed.success) return c.json(error(`line ${i + 1} failed validation`, parsed.error.flatten()), 400);
      frames.push(parsed.data);
    }

    const result = store.ingest(auth.session, frames);
    for (const stored of result.accepted) {
      console.log(`[session ${auth.session.sessionId}] ${describeFrame(stored.frame)}`);
    }
    if (result.duplicates > 0) {
      console.log(`[session ${auth.session.sessionId}] skipped ${result.duplicates} duplicate frame(s)`);
    }
    const body: IngestResponse = {
      accepted: result.accepted.length,
      duplicates: result.duplicates,
      latestSequence: Object.fromEntries(auth.session.latestSequence),
    };
    return c.json(body);
  });

  app.post("/api/sessions/:sessionId/end", (c) => {
    const auth = authorize(c);
    if ("status" in auth) return c.json(error(auth.message), auth.status);
    store.end(auth.session);
    console.log(`[session ${auth.session.sessionId}] ended by client after ${auth.session.frames.length} frames`);
    return c.json(store.summary(auth.session));
  });

  app.get("/api/sessions/:sessionId", (c) => {
    const session = store.get(c.req.param("sessionId"));
    if (!session) return c.json(error("unknown session"), 404);
    return c.json(store.summary(session));
  });

  return app;
}
