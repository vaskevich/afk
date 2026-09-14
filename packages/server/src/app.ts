import { Hono } from "hono";
import type { AppConfig, AppDeps } from "./env.ts";
import { SessionStore } from "./sessions.ts";
import { healthRoutes } from "./routes/health.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { frameRoutes } from "./routes/frames.ts";

// TODO(hardening): secureHeaders, body size limit, rate limiting, admission control,
// minimum client version. See BACKLOG.md.

/** Wires route modules together. Handlers live in ./routes, shared request plumbing in ./middleware. */
export function createApp(config: AppConfig, store = new SessionStore()) {
  const deps: AppDeps = { config, store };
  return new Hono()
    .route("/api/health", healthRoutes)
    .route("/api/sessions", sessionRoutes(deps))
    .route("/api/sessions", frameRoutes(deps));
}
