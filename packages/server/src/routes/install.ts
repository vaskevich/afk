import { Hono } from "hono";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AppDeps } from "../env.ts";

/**
 * The installer and the client, served by the server itself so a deployment is
 * self-contained: `curl -fsSL <origin>/install | sh` fetches `<origin>/cli/afk` from the
 * same server and installs a client whose default `AFK_SERVER` is that origin. The
 * installer is the shell template next to this file with the public origin filled in;
 * the client is the `cli/afk` file at `config.clientScriptPath` (see docs/CONFIGURATION.md).
 * `<origin>/cli/afk.sha256` is the client's SHA-256 in `sha256sum` format, which the
 * installer checks the download against before installing it. Same origin as the script,
 * so it catches a corrupted transfer or a stale cached copy, not a compromised server.
 */

const INSTALLER_TEMPLATE_PATH = fileURLToPath(new URL("./install.sh", import.meta.url));
/** The line `AFK_ORIGIN="__AFK_ORIGIN__"` in the template; replaced with `publicBaseUrl`. */
const ORIGIN_PLACEHOLDER = "__AFK_ORIGIN__";

/** The file name in the checksum line; the installer downloads the script under this name. */
const CLIENT_FILE_NAME = "afk";

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

/** `<hex>  afk`, the line `sha256sum -c` and `shasum -a 256 -c` accept, over the script's UTF-8 bytes. */
export function checksumLine(script: string): string {
  const hex = createHash("sha256").update(script, "utf8").digest("hex");
  return `${hex}  ${CLIENT_FILE_NAME}\n`;
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
    })
    .get("/cli/afk.sha256", async (c) => {
      const script = await readClientScript(config.clientScriptPath);
      if (script === undefined) {
        return c.text(notFound, 404);
      }
      c.header("Content-Type", PLAIN_TEXT_CONTENT_TYPE);
      c.header("Cache-Control", CACHE_CONTROL);
      return c.body(checksumLine(script));
    });
}
