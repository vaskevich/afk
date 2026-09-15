import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The ingest token at rest. `session.json` holds `sha256(token)` (hex), never the
 * token, so whoever can read the store (the bucket key, another user of a disk-storage
 * self-host) cannot write into a live session with it. The token itself exists in two
 * places only: the create response, once, and the client's own spool.
 */
const HASH_ALGORITHM = "sha256";
const HASH_ENCODING = "hex";

/** The stored form of an ingest token. */
export function hashIngestToken(token: string): string {
  return createHash(HASH_ALGORITHM).update(token).digest(HASH_ENCODING);
}

/**
 * Whether `presented` is the token `storedHash` was made from. Compares the two
 * digests with `timingSafeEqual`, so a wrong token of any length takes the same time
 * as a right one and nothing about the stored hash leaks through timing. A stored hash
 * that is not a digest of the right length (a corrupt record) simply never matches.
 */
export function ingestTokenMatches(presented: string, storedHash: string): boolean {
  const presentedDigest = Buffer.from(hashIngestToken(presented), HASH_ENCODING);
  const storedDigest = Buffer.from(storedHash, HASH_ENCODING);
  if (storedDigest.length !== presentedDigest.length) {
    return false;
  }
  return timingSafeEqual(presentedDigest, storedDigest);
}
