import { Hono } from "hono";
import { compress } from "hono/compress";
import type { AppConfig, AppDeps } from "./env.ts";
import type { SessionStore } from "./store/sessions.ts";
import { healthRoutes } from "./routes/health.ts";
import { statsRoutes } from "./routes/stats.ts";
import { versionRoutes } from "./routes/version.ts";
import { demoSessionRoutes, sessionRoutes } from "./routes/sessions.ts";
import { frameRoutes } from "./routes/frames.ts";
import { streamRoutes } from "./routes/stream.ts";
import { installRoutes } from "./routes/install.ts";
import { webRoutes } from "./routes/web.ts";
import { errorResponse, unhandledError } from "./http/errors.ts";
import { requestTiming } from "./middleware/request-timing.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { sessionIdParam } from "./middleware/session-id.ts";

// TODO(hardening): rate limiting of session creation per client address. See BACKLOG.md.

// Layout of src/:
//   app.ts, index.ts   - entry point and app wiring (this file)
//   env.ts             - app-level config/deps types shared across routes and middleware
//   routes/            - one Hono sub-app per resource, mounted here
//   middleware/         - request plumbing shared by routes (session id shape, ingest auth,
//                        client version, security headers)
//   store/             - sessions (in-memory cache written through to SessionStorage: disk or bucket)
//   http/              - generic HTTP helpers (error responses)
//   log/               - server-side log formatting
//   utils/             - small standalone helpers (ids, ndjson parsing)

/** Wires route modules together. Handlers live in ./routes, shared request plumbing in ./middleware. */
export function createApp(config: AppConfig, store: SessionStore) {
  const deps: AppDeps = { config, store };
  // Request timing goes first so everything below is inside the measurement. The
  // session id check sits in front of every route with a :sessionId (the `/*` also
  // matches the bare path) so no route module can forget it; the one route ahead of it
  // is the refusal to delete the demo session, whose id is not one the check would
  // pass. The installer routes go before the dashboard, whose catch-all would
  // otherwise answer /install with index.html.
  return (
    new Hono()
      .use("*", requestTiming())
      .use("*", securityHeaders())
      // gzip/deflate for JSON and the dashboard bundle: a one-hour session's /frames
      // document is roughly 15 MB of very repetitive JSON, about a tenth of that
      // compressed. Hono skips text/event-stream, so the SSE stream is untouched.
      // TODO(perf): brotli would be smaller still but needs zlib rather than CompressionStream.
      .use("*", compress())
      .route("/api/sessions", demoSessionRoutes())
      .use("/api/sessions/:sessionId/*", sessionIdParam())
      .route("/api/health", healthRoutes)
      .route("/versionz", versionRoutes(deps))
      .route("/api/version", versionRoutes(deps))
      .route("/api/stats", statsRoutes(deps))
      .route("/api/sessions", sessionRoutes(deps))
      .route("/api/sessions", frameRoutes(deps))
      .route("/api/sessions", streamRoutes(deps))
      // Unknown API paths must be a JSON 404, never the dashboard's index.html from the
      // single-page fallback below: a client talking to an older server would otherwise
      // get HTML with a 200 and print it.
      .all("/api/*", (c) => errorResponse(c, 404, `no such endpoint: ${c.req.path}`))
      .route("/", installRoutes(deps))
      .route("/", webRoutes(config.webDistDir))
      // Last, so it covers every route above: a handler that throws answers a JSON
      // ErrorResponse and logs its stack through the logger, instead of Hono's default
      // console.error plus a plain-text body the bash client would print verbatim.
      .onError(unhandledError)
  );
}
