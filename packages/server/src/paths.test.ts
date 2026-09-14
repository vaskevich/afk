import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, repoPaths } from "./paths.ts";

describe("repoPaths", () => {
  it("lays every default out under the given root the way the repo and the image are", () => {
    expect(repoPaths("/opt/afk")).toEqual({
      webDistDir: "/opt/afk/packages/web/dist",
      clientScriptPath: "/opt/afk/cli/afk",
      dataDir: "/opt/afk/packages/server/data",
      serverPackageJson: "/opt/afk/packages/server/package.json",
    });
  });
});

describe("REPO_ROOT", () => {
  it("is an absolute path", () => {
    expect(path.isAbsolute(REPO_ROOT)).toBe(true);
  });

  it("is the checkout this test runs from: its server package.json is @afk/server", () => {
    const manifest = JSON.parse(readFileSync(repoPaths(REPO_ROOT).serverPackageJson, "utf8"));

    expect(manifest).toMatchObject({ name: "@afk/server" });
  });
});
