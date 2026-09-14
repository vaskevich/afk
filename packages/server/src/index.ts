import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.AFK_PORT ?? 4141);
const publicBaseUrl = process.env.AFK_PUBLIC_BASE_URL ?? `http://localhost:${port}`;

const app = createApp({ publicBaseUrl });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `afk server listening on http://localhost:${info.port} (public base ${publicBaseUrl})`,
  );
});
