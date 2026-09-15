import { describe, expect, it } from "vitest";
import { hashIngestToken, ingestTokenMatches } from "./ingest-token.ts";

describe("hashIngestToken", () => {
  it("is a hex sha256 digest, the same for the same token and different for another", () => {
    const hash = hashIngestToken("token1");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("token1");
    expect(hashIngestToken("token1")).toBe(hash);
    expect(hashIngestToken("token2")).not.toBe(hash);
  });
});

describe("ingestTokenMatches", () => {
  it("matches the token a hash was made from and nothing else", () => {
    const hash = hashIngestToken("the-token");

    expect(ingestTokenMatches("the-token", hash)).toBe(true);
    expect(ingestTokenMatches("the-tokeN", hash)).toBe(false);
    expect(ingestTokenMatches("", hash)).toBe(false);
  });

  it("compares fixed-length digests, so a wrong token of any length is refused the same way", () => {
    const hash = hashIngestToken("the-token");

    expect(ingestTokenMatches("t", hash)).toBe(false);
    expect(ingestTokenMatches("the-token".repeat(50), hash)).toBe(false);
  });

  it("never matches a stored value that is not a digest, such as a clear token or a truncated hash", () => {
    expect(ingestTokenMatches("the-token", "the-token")).toBe(false);
    expect(ingestTokenMatches("the-token", hashIngestToken("the-token").slice(0, 32))).toBe(false);
    expect(ingestTokenMatches("the-token", "")).toBe(false);
  });
});
