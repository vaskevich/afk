/**
 * Where the server finds the rest of the repository at runtime.
 *
 * Every default path the server needs (the built dashboard, the client script, the
 * data directory, its own package.json for the version) hangs off one repo root, and
 * that root is derived once, from this file's own location. This file sits at the same
 * depth in both layouts the server runs in:
 *
 *   dev, under tsx (`pnpm dev:server`):   <root>/packages/server/src/paths.ts
 *   built (`pnpm build`, the Docker image): <root>/packages/server/dist/paths.js
 *
 * so the root is always three directories up. The Docker image keeps the repo's
 * `packages/` and `cli/` layout under /app for exactly this reason: nothing else is
 * needed for the same defaults to hold there. `AFK_WEB_DIST`, `AFK_CLIENT_SCRIPT`, and
 * `AFK_DATA_DIR` override the individual defaults (docs/CONFIGURATION.md).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository (or image) root: three directories above this file, see above. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Everything the server locates by convention rather than configuration. */
export interface RepoPaths {
  /** The built dashboard, served at `/`. */
  webDistDir: string;
  /** The client script, served at `/cli/afk` and by `/install`. */
  clientScriptPath: string;
  /** Where `disk` storage writes sessions when `AFK_DATA_DIR` is unset. */
  dataDir: string;
  /** The server's own manifest, whose `version` is what /versionz and /api/stats report. */
  serverPackageJson: string;
}

/** The conventional paths under a repo root laid out like this one. */
export function repoPaths(repoRoot: string): RepoPaths {
  return {
    webDistDir: path.join(repoRoot, "packages", "web", "dist"),
    clientScriptPath: path.join(repoRoot, "cli", "afk"),
    dataDir: path.join(repoRoot, "packages", "server", "data"),
    serverPackageJson: path.join(repoRoot, "packages", "server", "package.json"),
  };
}
