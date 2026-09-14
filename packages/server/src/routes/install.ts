import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AppDeps } from "../env.ts";

/**
 * The installer and the client, served by the server itself so a deployment is
 * self-contained: `curl -fsSL <origin>/install | sh` fetches `<origin>/cli/afk` from the
 * same server and installs a client whose default `AFK_SERVER` is that origin. The
 * installer is the shell template next to this file with the public origin filled in;
 * the client is the `cli/afk` file at `config.clientScriptPath` (see docs/CONFIGURATION.md).
 */

const INSTALLER_TEMPLATE_PATH = fileURLToPath(new URL("./install.sh", import.meta.url));
/** The line `AFK_ORIGIN="__AFK_ORIGIN__"` in the template; replaced with `publicBaseUrl`. */
const ORIGIN_PLACEHOLDER = "__AFK_ORIGIN__";

const SHELL_SCRIPT_CONTENT_TYPE = "text/x-shellscript; charset=utf-8";
const PLAIN_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
/** Both bodies follow the deployment (its origin, its client release), so nothing may cache them. */
const CACHE_CONTROL = "no-store";

function isFileNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** The client script's text, or undefined when there is no file at the configured path. */
async function readClientScript(clientScriptPath: string): Promise<string | undefined> {
  try {
    return await readFile(clientScriptPath, "utf8");
  } catch (err) {
    if (isFileNotFound(err)) {
      return undefined;
    }
    throw err;
  }
}

/** The installer with the origin filled in. Rendered per request; the template is a few KB. */
export async function renderInstaller(publicBaseUrl: string): Promise<string> {
  const template = await readFile(INSTALLER_TEMPLATE_PATH, "utf8");
  return template.replace(ORIGIN_PLACEHOLDER, publicBaseUrl);
}

export function installRoutes({ config }: AppDeps) {
  const notFound = `The afk client is not available on this server (expected ${config.clientScriptPath}).\n`;

  return new Hono()
    .get("/install", async (c) => {
      // The installer would fail at its download step without the client, so say so up front.
      if ((await readClientScript(config.clientScriptPath)) === undefined) {
        return c.text(notFound, 404);
      }
      c.header("Content-Type", SHELL_SCRIPT_CONTENT_TYPE);
      c.header("Cache-Control", CACHE_CONTROL);
      return c.body(await renderInstaller(config.publicBaseUrl));
    })
    .get("/cli/afk", async (c) => {
      const script = await readClientScript(config.clientScriptPath);
      if (script === undefined) {
        return c.text(notFound, 404);
      }
      c.header("Content-Type", PLAIN_TEXT_CONTENT_TYPE);
      c.header("Cache-Control", CACHE_CONTROL);
      return c.body(script);
    });
}
