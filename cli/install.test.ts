/**
 * The installer end to end: the real server serving `/install` and `/cli/afk` on a
 * random loopback port, and the real one-liner (`curl ... | sh`) installing the real
 * `cli/afk` into a temp directory. Runs under the contract config (`pnpm test:contract`)
 * because it spawns curl and sh; skipped off macOS, where the installer refuses to run.
 */
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../packages/server/src/app.ts";
import {
  DEFAULT_LIMITS,
  DEFAULT_MINIMUM_VERSIONS,
  DEFAULT_SSE_KEEPALIVE_MS,
} from "../packages/server/src/env.ts";
import { SessionStore } from "../packages/server/src/store/sessions.ts";
import { MemorySessionStorage } from "../packages/server/src/store/storage.ts";

const execFileAsync = promisify(execFile);
const AFK_SCRIPT = fileURLToPath(new URL("./afk", import.meta.url));
const LOOPBACK = "127.0.0.1";
/** Never created; the installer does not need the dashboard. */
const NO_DIST_DIR = "/nonexistent/afk-install-test-dist";
/** The owner-executable bit, which `chmod +x` must have set. */
const OWNER_EXECUTE_BIT = 0o100;

interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** The real app on a random loopback port, serving the repo's own cli/afk. */
async function startServer(): Promise<TestServer> {
  const store = new SessionStore(new MemorySessionStorage(), { limits: DEFAULT_LIMITS });
  // Built once the port is known, since the installer embeds the origin.
  const wiring: { app?: ReturnType<typeof createApp> } = {};
  const server = serve({
    fetch: (request) => {
      if (!wiring.app) {
        throw new Error("request arrived before the app was wired");
      }
      return wiring.app.fetch(request);
    },
    port: 0,
    hostname: LOOPBACK,
    overrideGlobalObjects: false,
  }) as Server;
  await once(server, "listening");
  const url = `http://${LOOPBACK}:${(server.address() as AddressInfo).port}`;
  wiring.app = createApp(
    {
      publicBaseUrl: url,
      webDistDir: NO_DIST_DIR,
      clientScriptPath: AFK_SCRIPT,
      limits: DEFAULT_LIMITS,
      sseKeepaliveMs: DEFAULT_SSE_KEEPALIVE_MS,
      minimumVersions: DEFAULT_MINIMUM_VERSIONS,
    },
    store,
  );

  return {
    url,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

/** Runs the documented one-liner with the install directory and HOME pointed at `dir`. */
async function runInstaller(url: string, dir: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("/bin/sh", ["-c", `curl -fsSL "${url}/install" | sh`], {
    env: { ...process.env, AFK_INSTALL_DIR: dir, HOME: dir },
  });
}

describe.skipIf(process.platform !== "darwin")("curl <origin>/install | sh", () => {
  let server: TestServer;
  let installDir: string;

  beforeEach(async () => {
    installDir = await mkdtemp(join(os.tmpdir(), "afk-install-"));
    server = await startServer();
  });

  afterEach(async () => {
    await server.close();
    await rm(installDir, { recursive: true, force: true });
  });

  it("installs an executable client that defaults to the server it came from", async () => {
    const { stdout } = await runInstaller(server.url, installDir);
    const installed = join(installDir, "afk");

    const mode = (await stat(installed)).mode;
    const { stdout: version } = await execFileAsync(installed, ["version"]);
    const script = await readFile(installed, "utf8");
    const { stdout: repoVersion } = await execFileAsync("/bin/bash", [AFK_SCRIPT, "version"]);

    expect(mode & OWNER_EXECUTE_BIT).toBe(OWNER_EXECUTE_BIT);
    expect(version).toBe(repoVersion);
    expect(script).toContain(
      `AFK_SERVER="\${AFK_SERVER:-${server.url}}" # afk-install: default server`,
    );
    expect(stdout).toContain(
      `installed ${repoVersion.trim()} to ${installed} (server ${server.url})`,
    );
  });

  it("prints the PATH line for a directory that is not on PATH, and the next commands", async () => {
    const { stdout } = await runInstaller(server.url, installDir);

    expect(stdout).toContain(`export PATH="${installDir}:$PATH"`);
    expect(stdout).toContain("afk start");
    expect(stdout).toContain("afk run -- <command>");
  });
});
