import { describe, expect, it } from "vitest";
import { compareSemver, parseSemver } from "./semver.ts";

describe("parseSemver", () => {
  it("parses major.minor.patch into numbers", () => {
    expect(parseSemver("1.20.3")).toEqual({ major: 1, minor: 20, patch: 3 });
  });

  it("ignores a pre-release or build suffix", () => {
    expect(parseSemver("1.2.0-beta.1")).toEqual({ major: 1, minor: 2, patch: 0 });
    expect(parseSemver("1.2.0+build.7")).toEqual({ major: 1, minor: 2, patch: 0 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseSemver(" 0.1.0 ")).toEqual({ major: 0, minor: 1, patch: 0 });
  });

  it("returns null for two components, a leading v, words, or an empty string", () => {
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("v1.2.3")).toBeNull();
    expect(parseSemver("latest")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("compareSemver", () => {
  const parse = (text: string) => parseSemver(text)!;

  it("orders numerically rather than lexically", () => {
    expect(compareSemver(parse("0.10.0"), parse("0.9.0"))).toBeGreaterThan(0);
    expect(compareSemver(parse("0.1.10"), parse("0.1.9"))).toBeGreaterThan(0);
  });

  it("weighs major over minor over patch", () => {
    expect(compareSemver(parse("2.0.0"), parse("1.99.99"))).toBeGreaterThan(0);
    expect(compareSemver(parse("1.1.0"), parse("1.0.99"))).toBeGreaterThan(0);
    expect(compareSemver(parse("1.0.1"), parse("1.0.0"))).toBeGreaterThan(0);
  });

  it("returns zero for equal versions", () => {
    expect(compareSemver(parse("0.1.0"), parse("0.1.0"))).toBe(0);
  });

  it("returns a negative number when the first is older", () => {
    expect(compareSemver(parse("0.0.9"), parse("0.1.0"))).toBeLessThan(0);
  });
});
