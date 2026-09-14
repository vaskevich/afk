import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { NO_CLIENT_SCRIPT, makeAppConfig } from "./test-helpers.ts";

const execFileAsync = promisify(execFile);

const PUBLIC_BASE_URL = "https://afk.test";
/** A stand-in for cli/afk: only the line the installer rewrites matters here. */
const FAKE_CLIENT_SCRIPT =
  '#!/bin/bash\nAFK_SERVER="${AFK_SERVER:-https://afk.osv.im}" # afk-install: default server\n';

function buildApp(clientScriptPath: string) {
  return createApp(
    makeAppConfig({ publicBaseUrl: PUBLIC_BASE_URL, clientScriptPath }),
    new SessionStore(new MemorySessionStorage(), { limits: DEFAULT_LIMITS }),
  );
}

describe("install routes with a client script", () => {
  let tempDir: string;
  let clientScriptPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "afk-install-test-"));
    clientScriptPath = path.join(tempDir, "afk");
    writeFileSync(clientScriptPath, FAKE_CLIENT_SCRIPT);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves the installer as an uncached shell script", async () => {
    const app = buildApp(clientScriptPath);

    const res = await app.request("/install");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toMatch(/^#!\/bin\/sh\n/);
  });

  it("embeds the public origin as the download source and the client's default server", async () => {
    const app = buildApp(clientScriptPath);

    const installer = await (await app.request("/install")).text();

    expect(installer).toContain(`AFK_ORIGIN="${PUBLIC_BASE_URL}"`);
    expect(installer).toContain('"$AFK_ORIGIN/cli/afk"');
    expect(installer).not.toContain("__AFK_ORIGIN__");
  });

  it("installs to ~/.local/bin unless AFK_INSTALL_DIR overrides it", async () => {
    const app = buildApp(clientScriptPath);

    const installer = await (await app.request("/install")).text();

    expect(installer).toContain('AFK_INSTALL_DIR="${AFK_INSTALL_DIR:-$HOME/.local/bin}"');
  });

  it("is valid POSIX sh", async () => {
    const app = buildApp(clientScriptPath);
    const installer = await (await app.request("/install")).text();
    const installerPath = path.join(tempDir, "install.sh");
    writeFileSync(installerPath, installer);

    await expect(execFileAsync("/bin/sh", ["-n", installerPath])).resolves.toBeDefined();
  });

  it("serves the client script as plain text without caching", async () => {
    const app = buildApp(clientScriptPath);

    const res = await app.request("/cli/afk");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(FAKE_CLIENT_SCRIPT);
  });
});

describe("install routes without a client script", () => {
  it("answers 404 for the installer, naming the expected path", async () => {
    const app = buildApp(NO_CLIENT_SCRIPT);

    const res = await app.request("/install");

    expect(res.status).toBe(404);
    expect(await res.text()).toContain(NO_CLIENT_SCRIPT);
  });

  it("answers 404 for the client script", async () => {
    const app = buildApp(NO_CLIENT_SCRIPT);

    const res = await app.request("/cli/afk");

    expect(res.status).toBe(404);
    expect(await res.text()).toContain(NO_CLIENT_SCRIPT);
  });
});
