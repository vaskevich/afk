import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { DEFAULT_LIMITS, DEFAULT_MINIMUM_VERSIONS } from "./env.ts";
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

// Per-deployment floors for the clients this server talks to (docs/VERSIONING.md). The
// shared constants are the defaults; the env can only raise the protocol floor, since
// the shared schema already rejects anything below MIN_PROTOCOL_VERSION.
const minimumVersions = {
  clientVersion: process.env.AFK_MIN_CLIENT_VERSION ?? DEFAULT_MINIMUM_VERSIONS.clientVersion,
  protocolVersion: Math.max(
    DEFAULT_MINIMUM_VERSIONS.protocolVersion,
    Number(process.env.AFK_MIN_PROTOCOL_VERSION ?? DEFAULT_MINIMUM_VERSIONS.protocolVersion),
  ),
};

/** How often time-based rules (client silent) run and idle ended sessions are evicted. */
const TICK_INTERVAL_MS = 5_000;
store.startTicker(TICK_INTERVAL_MS);

const app = createApp({ publicBaseUrl, webDistDir, limits, minimumVersions }, store);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `afk server listening on http://localhost:${info.port} ` +
      `(public base ${publicBaseUrl}, storage ${process.env.AFK_STORAGE ?? "disk"}, ` +
      `limits ${limits.maxActiveSessions} sessions x ${limits.maxStreamsPerSession} streams, ` +
      `minimum client ${minimumVersions.clientVersion} / protocol ${minimumVersions.protocolVersion})`,
  );
});
