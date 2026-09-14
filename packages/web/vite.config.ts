import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Written next to index.html so the server can report the dashboard build without parsing the bundle. */
const VERSION_FILE = "version.json";
/** What the commit reads as when neither AFK_BUILD_SHA nor a git checkout can say. */
const UNKNOWN_COMMIT = "unknown";

const WEB_PACKAGE_JSON = new URL("./package.json", import.meta.url);

function webVersion(): string {
  const manifest = JSON.parse(readFileSync(WEB_PACKAGE_JSON, "utf8")) as { version: string };
  return manifest.version;
}

/** The short commit of the checkout this build runs in, or undefined outside one (the Docker build context has no .git). */
function gitShortHead(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The commit this build is of: the Dockerfile passes it in as AFK_BUILD_SHA (from
 * infra/deploy.sh's --build-arg GIT_SHA) because .git is not in the build context;
 * a local build asks git; anything else reads "unknown".
 */
function buildCommit(): string {
  const fromEnv = process.env.AFK_BUILD_SHA;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  return gitShortHead() ?? UNKNOWN_COMMIT;
}

/** Emits dist/version.json, the file packages/server/src/utils/web-version.ts reads. */
function versionFile(version: string, commit: string): Plugin {
  return {
    name: "afk-version-file",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: VERSION_FILE,
        source: `${JSON.stringify({ version, commit })}\n`,
      });
    },
  };
}

const version = webVersion();
const commit = buildCommit();

export default defineConfig({
  plugins: [react(), versionFile(version, commit)],
  define: {
    __AFK_WEB_VERSION__: JSON.stringify(version),
    __AFK_WEB_COMMIT__: JSON.stringify(commit),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:4141",
    },
  },
});
