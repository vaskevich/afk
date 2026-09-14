import { Hono } from "hono";
import type { AppConfig, AppDeps } from "./env.ts";
import type { SessionStore } from "./store/sessions.ts";
import { healthRoutes } from "./routes/health.ts";
import { statsRoutes } from "./routes/stats.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { frameRoutes } from "./routes/frames.ts";
import { streamRoutes } from "./routes/stream.ts";
import { webRoutes } from "./routes/web.ts";

// TODO(hardening): secureHeaders, body size limit, rate limiting, admission control,
// minimum client version. See BACKLOG.md.

// Layout of src/:
//   app.ts, index.ts   - entry point and app wiring (this file)
//   env.ts             - app-level config/deps types shared across routes and middleware
//   routes/            - one Hono sub-app per resource, mounted here
//   middleware/         - request plumbing shared by routes (e.g. ingest auth)
//   store/             - sessions (in-memory cache written through to SessionStorage: disk or bucket)
//   http/              - generic HTTP helpers (error responses)
//   log/               - server-side log formatting
//   utils/             - small standalone helpers (ids, ndjson parsing)

/** Wires route modules together. Handlers live in ./routes, shared request plumbing in ./middleware. */
export function createApp(config: AppConfig, store: SessionStore) {
  const deps: AppDeps = { config, store };
  return new Hono()
    .route("/api/health", healthRoutes)
    .route("/api/stats", statsRoutes(deps))
    .route("/api/sessions", sessionRoutes(deps))
    .route("/api/sessions", frameRoutes(deps))
    .route("/api/sessions", streamRoutes(deps))
    .route("/", webRoutes(config.webDistDir));
}
