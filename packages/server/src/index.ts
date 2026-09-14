import { serve } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";

const port = Number(process.env.AFK_PORT ?? 4141);
const publicBaseUrl = process.env.AFK_PUBLIC_BASE_URL ?? `http://localhost:${port}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = process.env.AFK_WEB_DIST ?? path.resolve(here, "../../web/dist");

const app = createApp({ publicBaseUrl, webDistDir });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `afk server listening on http://localhost:${info.port} (public base ${publicBaseUrl})`,
  );
});
