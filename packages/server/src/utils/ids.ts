import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Length of a session id. 22 chars of base62 is ~131 bits of entropy. */
export const SESSION_ID_LENGTH = 22;

/**
 * The shape of every session id this server has ever issued: exactly `SESSION_ID_LENGTH`
 * characters of `ALPHABET`. The route layer (`middleware/session-id.ts`) rejects any
 * `:sessionId` that does not match before storage is consulted, so the length lives
 * here, next to `randomId`, and cannot drift from what is generated.
 */
export const SESSION_ID_PATTERN = new RegExp(`^[A-Za-z0-9]{${SESSION_ID_LENGTH}}$`);

/** True when `value` has the shape of a session id (not whether one exists). */
export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/** URL-safe random id. */
export function randomId(length = SESSION_ID_LENGTH): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** Bearer token for ingest. Distinct from the session id so sharing a dashboard never shares write access. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
