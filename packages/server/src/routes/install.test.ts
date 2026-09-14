import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
/** What `shasum -a 256` / `sha256sum` print for a file named afk with that content. */
const FAKE_CLIENT_CHECKSUM_LINE = `${createHash("sha256").update(FAKE_CLIENT_SCRIPT).digest("hex")}  afk\n`;

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

  it("verifies the download against the checksum from the same origin before installing", async () => {
    const app = buildApp(clientScriptPath);

    const installer = await (await app.request("/install")).text();

    expect(installer).toContain('"$AFK_ORIGIN/cli/afk.sha256"');
    expect(installer).toContain("shasum -a 256 -c");
    expect(installer).toContain("sha256sum -c");
    expect(installer).toContain("--proto '=https' --tlsv1.2");
    // The download is moved into place only after the check; nothing is written there before.
    expect(installer.indexOf("verify_checksum afk.sha256")).toBeLessThan(
      installer.indexOf('"$AFK_BIN"'),
    );
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

  it("serves the client's SHA-256 in sha256sum format, uncached", async () => {
    const app = buildApp(clientScriptPath);

    const res = await app.request("/cli/afk.sha256");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(FAKE_CLIENT_CHECKSUM_LINE);
  });

  it("serves a checksum that shasum accepts for the served script", async () => {
    const app = buildApp(clientScriptPath);
    const served = await (await app.request("/cli/afk")).text();
    const checksum = await (await app.request("/cli/afk.sha256")).text();
    writeFileSync(path.join(tempDir, "afk"), served);
    writeFileSync(path.join(tempDir, "afk.sha256"), checksum);

    await expect(
      execFileAsync("shasum", ["-a", "256", "-c", "afk.sha256"], { cwd: tempDir }),
    ).resolves.toMatchObject({ stdout: "afk: OK\n" });
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

  it("answers 404 for the checksum", async () => {
    const app = buildApp(NO_CLIENT_SCRIPT);

    const res = await app.request("/cli/afk.sha256");

    expect(res.status).toBe(404);
    expect(await res.text()).toContain(NO_CLIENT_SCRIPT);
  });
});
