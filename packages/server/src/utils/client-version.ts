import { readFile } from "node:fs/promises";
import { parseSemver } from "./semver.ts";

/**
 * The version of the client the server serves: the `AFK_VERSION="x.y.z"` line near
 * the top of cli/afk (docs/VERSIONING.md). Read once at startup, like the dashboard's
 * version.json, and reported by /versionz as `client.version` and by a session create
 * as `latestClientVersion`, so a running client can tell it is behind the copy its
 * own server would install.
 */

/** The line as cli/afk writes it; the version is the one capturing group. */
const AFK_VERSION_LINE = /^AFK_VERSION="([^"\n]*)"\s*$/m;

/** True for the error `readFile` throws when the path does not exist. */
function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/** The version in `script`'s `AFK_VERSION` line, or null when it has none a client could compare. */
export function parseClientVersion(script: string): string | null {
  const match = AFK_VERSION_LINE.exec(script);
  if (match === null || parseSemver(match[1]!) === null) {
    return null;
  }
  return match[1]!;
}

/**
 * Reads the `AFK_VERSION` line of the client script at `clientScriptPath`. Null when
 * there is no file there, which is what a checkout run with `AFK_CLIENT_SCRIPT` pointing
 * nowhere looks like and what the install routes answer 404 for; a file that is there
 * but has no such line is not a client this server should be serving and throws,
 * naming the file.
 */
export async function readClientVersion(clientScriptPath: string): Promise<string | null> {
  let script: string;
  try {
    script = await readFile(clientScriptPath, "utf8");
  } catch (err) {
    if (isMissingFile(err)) {
      return null;
    }
    throw err;
  }
  const version = parseClientVersion(script);
  if (version === null) {
    throw new Error(
      `${clientScriptPath}: no AFK_VERSION="major.minor.patch" line; is it the afk client?`,
    );
  }
  return version;
}
