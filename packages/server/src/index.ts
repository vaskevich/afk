import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { DEFAULT_LIMITS } from "./env.ts";
import { createStorageFromEnv } from "./store/create-storage.ts";
import { SessionStore } from "./store/sessions.ts";

const port = Number(process.env.AFK_PORT ?? 4141);
const publicBaseUrl = process.env.AFK_PUBLIC_BASE_URL ?? `http://localhost:${port}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = process.env.AFK_WEB_DIST ?? path.resolve(here, "../../web/dist");

const defaultDataDir = path.resolve(here, "../data");
const storage = createStorageFromEnv(process.env, defaultDataDir);
const limits = {
  maxActiveSessions: Number(
    process.env.AFK_MAX_ACTIVE_SESSIONS ?? DEFAULT_LIMITS.maxActiveSessions,
  ),
  maxStreamsPerSession: Number(
    process.env.AFK_MAX_STREAMS_PER_SESSION ?? DEFAULT_LIMITS.maxStreamsPerSession,
  ),
};
const store = new SessionStore(storage, limits);

/** How often time-based rules (client silent) run and idle ended sessions are evicted. */
const TICK_INTERVAL_MS = 5_000;
store.startTicker(TICK_INTERVAL_MS);

const app = createApp({ publicBaseUrl, webDistDir, limits }, store);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `afk server listening on http://localhost:${info.port} ` +
      `(public base ${publicBaseUrl}, storage ${process.env.AFK_STORAGE ?? "disk"}, ` +
      `limits ${limits.maxActiveSessions} sessions x ${limits.maxStreamsPerSession} streams)`,
  );
});
