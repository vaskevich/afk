import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { DiskSessionStorage } from "./store/disk-storage.ts";
import { SessionStore } from "./store/sessions.ts";

const port = Number(process.env.AFK_PORT ?? 4141);
const publicBaseUrl = process.env.AFK_PUBLIC_BASE_URL ?? `http://localhost:${port}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = process.env.AFK_WEB_DIST ?? path.resolve(here, "../../web/dist");

// TODO(storage): pick DiskSessionStorage or the S3-compatible storage from AFK_STORAGE=disk|s3.
const dataDir = process.env.AFK_DATA_DIR ?? path.resolve(here, "../data");
const store = new SessionStore(new DiskSessionStorage(dataDir));

/** How often time-based rules (client silent) get to run on live sessions. */
const RULE_TICK_INTERVAL_MS = 5_000;
store.startTicker(RULE_TICK_INTERVAL_MS);

const app = createApp({ publicBaseUrl, webDistDir }, store);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `afk server listening on http://localhost:${info.port} ` +
      `(public base ${publicBaseUrl}, sessions stored in ${dataDir})`,
  );
});
