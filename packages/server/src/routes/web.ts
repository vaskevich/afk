import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Serves the built dashboard (packages/web/dist) so the URL the client prints works
 * straight off the server. Static assets are served as files; every other path is
 * the single-page app's index.html so the router can handle /s/:sessionId.
 * For UI development use the Vite dev server instead, which proxies /api here.
 */
export function webRoutes(distDir: string) {
  const indexFile = path.join(distDir, "index.html");
  const built = existsSync(indexFile);
  // serveStatic wants a root relative to the working directory, absolute paths are not supported.
  const root = path.relative(process.cwd(), distDir) || ".";

  const app = new Hono();
  if (!built) {
    return app.get("*", (c) =>
      c.text(
        `The dashboard has not been built (expected ${indexFile}).\n` +
          `Run "pnpm build" and restart the server, or use the Vite dev server (pnpm dev:web).\n`,
        503,
      ),
    );
  }

  // TODO(hardening): cache headers (hashed assets are immutable, index.html is not).
  return app.use("*", serveStatic({ root })).get("*", (c) => {
    return c.html(readFileSync(indexFile, "utf8"));
  });
}
