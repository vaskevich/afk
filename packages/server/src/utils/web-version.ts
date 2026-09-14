import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebBuildInfo } from "@afk/shared";

/**
 * Written into the dashboard build by the `afk-version-file` plugin in
 * packages/web/vite.config.ts, next to index.html, so the server can say which
 * dashboard build it serves without parsing the bundle.
 */
export const WEB_VERSION_FILE = "version.json";

/** True for the error `readFile` throws when the path does not exist. */
function isMissingFile(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/**
 * Reads `<distDir>/version.json`. Null when the file is missing, which is what a
 * checkout without `pnpm build` looks like; anything else wrong with the file is a
 * build bug and throws, naming the file.
 */
export async function readWebBuildInfo(distDir: string): Promise<WebBuildInfo | null> {
  const file = path.join(distDir, WEB_VERSION_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isMissingFile(err)) {
      return null;
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${file}: not valid JSON: ${reason}`, { cause: err });
  }
  const result = WebBuildInfo.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${file}: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}
