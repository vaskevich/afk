import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const indexHtml = readFileSync(path.resolve(import.meta.dirname, "../index.html"), "utf8");

describe("index.html", () => {
  // Regression: the theme initializer was inline, and the deployed content security
  // policy (default-src 'self', no 'unsafe-inline') silently blocked it, so every page
  // load started on the wrong theme. Scripts must be external files.
  it("has no inline script, because the content security policy forbids them", () => {
    const inlineScripts = indexHtml.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? [];

    expect(inlineScripts).toEqual([]);
  });

  it("loads the theme initializer before the app bundle", () => {
    const themeAt = indexHtml.indexOf('src="/theme-init.js"');
    const appAt = indexHtml.indexOf('src="/src/main.tsx"');

    expect(themeAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(themeAt);
  });
});
