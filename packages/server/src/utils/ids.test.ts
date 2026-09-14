import { describe, expect, it } from "vitest";
import { SESSION_ID_LENGTH, isSessionId, randomId, randomToken } from "./ids.ts";

describe("randomId", () => {
  it("has the default length of 22 characters", () => {
    expect(randomId()).toHaveLength(22);
  });

  it("uses only base62 characters", () => {
    const id = randomId(200);

    expect(id).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("differs between two calls", () => {
    expect(randomId()).not.toBe(randomId());
  });
});

describe("isSessionId", () => {
  it("accepts what randomId generates", () => {
    expect(isSessionId(randomId())).toBe(true);
  });

  it("rejects an id that is one character short or long", () => {
    expect(isSessionId(randomId(SESSION_ID_LENGTH - 1))).toBe(false);
    expect(isSessionId(randomId(SESSION_ID_LENGTH + 1))).toBe(false);
  });

  it("rejects a character outside base62 even at the right length", () => {
    expect(isSessionId(`${randomId(SESSION_ID_LENGTH - 1)}-`)).toBe(false);
    expect(isSessionId(`${randomId(SESSION_ID_LENGTH - 1)}/`)).toBe(false);
  });
});

describe("randomToken", () => {
  it("returns a non-empty base64url string", () => {
    const token = randomToken();

    expect(token.length).toBeGreaterThan(0);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
