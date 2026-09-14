import { Hono } from "hono";
import type { ServiceStats } from "@afk/shared";
import type { AppDeps } from "../env.ts";

const startedAt = Date.now();
const MS_PER_SECOND = 1000;

/** Whole-service numbers for the landing page. Mounted at /api/stats. Unauthenticated, cheap. */
export function statsRoutes({ store, config }: AppDeps) {
  return new Hono().get("/", (c) => {
    const body: ServiceStats = {
      ...store.stats(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / MS_PER_SECOND),
      serverVersion: config.build.version,
      webCommit: config.webBuild?.commit ?? null,
    };
    return c.json(body);
  });
}
