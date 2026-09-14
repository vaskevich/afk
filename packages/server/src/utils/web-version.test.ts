import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_VERSION_FILE, readWebBuildInfo } from "./web-version.ts";

const tempDirs: string[] = [];

async function makeDistDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "afk-web-version-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("readWebBuildInfo", () => {
  it("reads the version and commit Vite wrote into the dist directory", async () => {
    const distDir = await makeDistDir();
    await writeFile(
      join(distDir, WEB_VERSION_FILE),
      JSON.stringify({ version: "0.3.1", commit: "abc1234" }),
    );

    await expect(readWebBuildInfo(distDir)).resolves.toEqual({
      version: "0.3.1",
      commit: "abc1234",
    });
  });

  it("returns null when the dist directory has no version file", async () => {
    const distDir = await makeDistDir();

    await expect(readWebBuildInfo(distDir)).resolves.toBeNull();
  });

  it("returns null when the dist directory itself does not exist", async () => {
    await expect(readWebBuildInfo("/nonexistent/afk-test-dist")).resolves.toBeNull();
  });

  it("rejects a file that is not JSON, naming it", async () => {
    const distDir = await makeDistDir();
    await writeFile(join(distDir, WEB_VERSION_FILE), "{not json");

    await expect(readWebBuildInfo(distDir)).rejects.toThrow(join(distDir, WEB_VERSION_FILE));
  });

  it("rejects a file missing the commit field, naming it", async () => {
    const distDir = await makeDistDir();
    await writeFile(join(distDir, WEB_VERSION_FILE), JSON.stringify({ version: "0.3.1" }));

    await expect(readWebBuildInfo(distDir)).rejects.toThrow(join(distDir, WEB_VERSION_FILE));
  });
});
