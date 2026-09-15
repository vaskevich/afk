/**
 * The installer end to end: the real server serving `/install`, `/cli/afk`, and
 * `/cli/afk.sha256` on a random loopback port, and the real one-liner (`curl ... | sh`)
 * installing the real `cli/afk` into a temp directory. Runs under the contract config
 * (`pnpm test:contract`) because it spawns curl and sh; skipped off macOS, where the
 * installer refuses to run.
 */
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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
/** A well-formed checksum line that matches no script. */
const WRONG_CHECKSUM_LINE = `${"0".repeat(64)}  afk\n`;

/** Answers a request in place of the app, or undefined to let the app handle it. */
type Intercept = (request: Request) => Response | undefined;

interface TestServer {
  url: string;
  close(): Promise<void>;
}

/**
 * The real app on a random loopback port, serving the repo's own cli/afk. `intercept`
 * stands in for a broken transfer: it answers chosen requests instead of the app.
 */
async function startServer(intercept: Intercept = () => undefined): Promise<TestServer> {
  const store = new SessionStore(new MemorySessionStorage(), { limits: DEFAULT_LIMITS });
  // Built once the port is known, since the installer embeds the origin.
  const wiring: { app?: ReturnType<typeof createApp> } = {};
  const server = serve({
    fetch: (request) => {
      if (!wiring.app) {
        throw new Error("request arrived before the app was wired");
      }
      return intercept(request) ?? wiring.app.fetch(request);
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

interface InstallerOptions {
  /** AFK_INSTALL_DIR; the HOME directory itself when omitted. */
  installDir?: string;
  /** The caller's PATH; the test process's own (which has no temp directory on it) when omitted. */
  path?: string;
}

/** Runs the documented one-liner with HOME pointed at `home` and the install directory at `installDir`. */
async function runInstaller(
  url: string,
  home: string,
  { installDir = home, path = process.env.PATH }: InstallerOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("/bin/sh", ["-c", `curl -fsSL "${url}/install" | sh`], {
    env: { ...process.env, AFK_INSTALL_DIR: installDir, HOME: home, PATH: path },
  });
}

/** Serves `body` for `pathname` and leaves every other request to the app. */
function serveInstead(pathname: string, body: string): Intercept {
  return (request) =>
    new URL(request.url).pathname === pathname
      ? new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } })
      : undefined;
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

  // Regression: the closing "Next: afk start" assumed `afk` resolved, right after the
  // installer had said the directory was not on PATH (it is not, on a stock Mac).
  it("spells the next commands with the full path, and the one-shot PATH line, when the directory is not on PATH", async () => {
    const { stdout } = await runInstaller(server.url, installDir, {
      installDir: join(installDir, ".local/bin"),
      path: "/usr/bin:/bin",
    });

    expect(stdout).toContain("~/.local/bin is not on your PATH.");
    expect(stdout).toContain('  export PATH="$HOME/.local/bin:$PATH"\n');
    expect(stdout).toContain("  fish_add_path ~/.local/bin\n");
    expect(stdout).toContain("\n  ~/.local/bin/afk start ");
    expect(stdout).toContain("\n  ~/.local/bin/afk run -- <command> ");
    expect(stdout).toContain('\n  export PATH="$HOME/.local/bin:$PATH"; afk start\n');
    expect(stdout).not.toContain("\n  afk start");
  });

  it("keeps the short next commands, with no PATH hint, when the directory is on PATH", async () => {
    const { stdout } = await runInstaller(server.url, installDir, {
      path: `${installDir}:/usr/bin:/bin`,
    });

    expect(stdout).toContain("\n  afk start ");
    expect(stdout).toContain("\n  afk run -- <command> ");
    expect(stdout).not.toContain("not on your PATH");
    expect(stdout).not.toContain("export PATH=");
  });

  it("refuses a download that does not match the served checksum and installs nothing", async () => {
    await server.close();
    server = await startServer(serveInstead("/cli/afk.sha256", WRONG_CHECKSUM_LINE));

    await expect(runInstaller(server.url, installDir)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `does not match ${server.url}/cli/afk.sha256; nothing was installed`,
      ),
    });
    expect(await readdir(installDir)).toEqual([]);
  });

  it("refuses a corrupted script even when the checksum itself arrives intact", async () => {
    await server.close();
    const repoScript = await readFile(AFK_SCRIPT, "utf8");
    server = await startServer(serveInstead("/cli/afk", `${repoScript}\ntrue # one more line\n`));

    await expect(runInstaller(server.url, installDir)).rejects.toMatchObject({ code: 1 });
    expect(await readdir(installDir)).toEqual([]);
  });
});
