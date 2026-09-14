import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** URL-safe random id. 22 chars of base62 is ~131 bits of entropy. */
export function randomId(length = 22): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Bearer token for ingest. Distinct from the session id so sharing a dashboard never shares write access. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
