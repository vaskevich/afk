import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(path.resolve(import.meta.dirname, "./styles.css"), "utf8");

/** The declarations of the first rule whose selector matches, whitespace collapsed. */
function ruleBody(selector: string): string {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  return (pattern.exec(styles)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

describe("styles.css", () => {
  // Regression: the step hints are <small>, which is inline, so "Keep the Mac awake…"
  // ran on directly after the step's description instead of starting its own line;
  // a margin alone does nothing for an inline box. jsdom does no layout, so this
  // guards the declaration rather than the rendered geometry.
  it("lays a step's hint out as a block, so it starts on its own line", () => {
    expect(ruleBody(".steps .hint")).toContain("display: block");
  });
});
