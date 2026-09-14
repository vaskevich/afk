import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClientVersion, readClientVersion } from "./client-version.ts";

/** Enough of cli/afk to carry a version line among the other assignments near its top. */
function clientScript(versionLine: string): string {
  return ["#!/bin/bash", "set -u", versionLine, "AFK_PROTOCOL_VERSION=1", ""].join("\n");
}

describe("parseClientVersion", () => {
  it("returns the version in the AFK_VERSION line", () => {
    expect(parseClientVersion(clientScript('AFK_VERSION="0.2.0"'))).toBe("0.2.0");
  });

  it("keeps a multi-digit part as written", () => {
    expect(parseClientVersion(clientScript('AFK_VERSION="1.10.3"'))).toBe("1.10.3");
  });

  it("returns null when there is no AFK_VERSION line", () => {
    expect(parseClientVersion(clientScript("# nothing to see"))).toBeNull();
  });

  it("returns null when the line's value is not major.minor.patch", () => {
    expect(parseClientVersion(clientScript('AFK_VERSION="latest"'))).toBeNull();
  });

  it("does not match an indented or commented-out assignment", () => {
    expect(parseClientVersion(clientScript('# AFK_VERSION="9.9.9"'))).toBeNull();
    expect(parseClientVersion(clientScript('  AFK_VERSION="9.9.9"'))).toBeNull();
  });
});

describe("readClientVersion", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "afk-client-version-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the version out of the script at the path", async () => {
    const scriptPath = path.join(dir, "afk");
    await writeFile(scriptPath, clientScript('AFK_VERSION="0.3.0"'));

    await expect(readClientVersion(scriptPath)).resolves.toBe("0.3.0");
  });

  it("returns null when there is no file at the path", async () => {
    await expect(readClientVersion(path.join(dir, "missing"))).resolves.toBeNull();
  });

  it("throws, naming the file, when the file has no AFK_VERSION line", async () => {
    const scriptPath = path.join(dir, "afk");
    await writeFile(scriptPath, clientScript("echo not the client"));

    await expect(readClientVersion(scriptPath)).rejects.toThrow(scriptPath);
  });
});
