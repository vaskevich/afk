import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_LIMITS } from "../env.ts";
import { createApp } from "../app.ts";
import { SessionStore } from "../store/sessions.ts";
import { MemorySessionStorage } from "../store/storage.ts";
import { makeAppConfig } from "./test-helpers.ts";

function buildApp(webDistDir: string) {
  return createApp(
    makeAppConfig({ webDistDir }),
    new SessionStore(new MemorySessionStorage(), DEFAULT_LIMITS),
  );
}

describe("web routes without a built dashboard", () => {
  /** Never created on disk, so the server sees no index.html at startup. */
  const NO_DIST_DIR = "/nonexistent/afk-test-dist";

  it("returns 503 with a message mentioning pnpm build for /", async () => {
    const app = buildApp(NO_DIST_DIR);

    const res = await app.request("/");

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("pnpm build");
  });

  it("returns 503 with a message mentioning pnpm build for a dashboard path", async () => {
    const app = buildApp(NO_DIST_DIR);

    const res = await app.request("/s/abc");

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("pnpm build");
  });
});

describe("web routes with a built dashboard", () => {
  // serveStatic resolves its `root` relative to process.cwd(). webRoutes computes that
  // relative path itself via `path.relative(process.cwd(), distDir)`, and Node resolves
  // the relative path serveStatic ends up reading from against that same real, unspied
  // process.cwd() at the OS level (spying `process.cwd` only patches the JS-visible
  // function; it does not change what the OS treats as the working directory, so it
  // cannot redirect the actual file lookup -- confirmed by hand: `vi.spyOn(process,
  // "cwd")` followed by `fs.existsSync("relative/path")` still resolves against the real
  // cwd). So the temp dir is left wherever `mkdtemp` puts it and process.cwd is not
  // touched: `path.relative` naturally produces a `../..`-prefixed path from the real
  // cwd to the temp dir, which both the app's own computation and Node's fs calls agree
  // on since both read the same real process.cwd(). If a test ever needs a different
  // process.cwd() value, spy it with `vi.spyOn(process, "cwd")` and restore it in
  // `afterEach` -- never mutate it with `process.chdir`.
  let parentDir: string;
  let distDir: string;

  beforeEach(() => {
    parentDir = mkdtempSync(path.join(tmpdir(), "afk-web-test-"));
    distDir = path.join(parentDir, "dist");
    mkdirSync(path.join(distDir, "assets"), { recursive: true });
    writeFileSync(path.join(distDir, "index.html"), "<!doctype html><body>afk dashboard</body>");
    writeFileSync(path.join(distDir, "assets", "app.js"), "console.log('afk');");
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  it("serves the built index html for a dashboard path", async () => {
    const app = buildApp(distDir);

    const res = await app.request("/s/abc");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("afk dashboard");
  });

  it("serves index.html with the content security policy and the other security headers", async () => {
    const app = buildApp(distDir);

    const res = await app.request("/s/abc");

    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; img-src 'self' data:; style-src 'self'; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'self'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("serves a static asset with a JavaScript content type", async () => {
    const app = buildApp(distDir);

    const res = await app.request("/assets/app.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });
});
