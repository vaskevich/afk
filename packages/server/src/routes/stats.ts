import { Hono } from "hono";
import type { ServiceStats } from "@afk/shared";
import type { AppDeps } from "../env.ts";

const startedAt = Date.now();

// TODO(version): read from package.json at build time.
const SERVER_VERSION = "0.1.0";

/** Whole-service numbers for the landing page. Mounted at /api/stats. Unauthenticated, cheap. */
export function statsRoutes({ store }: AppDeps) {
  return new Hono().get("/", (c) => {
    const body: ServiceStats = {
      ...store.stats(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      serverVersion: SERVER_VERSION,
    };
    return c.json(body);
  });
}
