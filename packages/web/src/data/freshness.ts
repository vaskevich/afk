import type { ConnectionState } from "./source.ts";

/**
 * How often the server pings an idle stream. The stream does not announce it, so this
 * mirrors the `AFK_SSE_KEEPALIVE_SECONDS` default in docs/CONFIGURATION.md; a server
 * configured with a longer interval makes every live dashboard report lost contact
 * between pings.
 */
export const EXPECTED_KEEPALIVE_MS = 15_000;

/**
 * Silence the browser tolerates before it stops vouching for what is on the page: one
 * missed ping, plus as long again for a late one.
 */
export const CONTACT_LOST_AFTER_MS = 2 * EXPECTED_KEEPALIVE_MS;

interface ContactInput {
  /** Transport state as the source last reported it. */
  connection: ConnectionState;
  /** When anything last came from the server: a frame, a summary, an event, a ping, or the stream opening (unix ms). */
  lastHeardAt: number;
  nowMs: number;
}

/**
 * When the browser last had contact with the server, if that is too long ago to trust
 * the page, or null while contact is fresh. Contact is lost the moment the transport
 * says it is down (`reconnecting`, or `closed` without the stream having ended), and
 * after `CONTACT_LOST_AFTER_MS` of silence on a transport that still claims to be up,
 * which is what a half-open socket looks like: EventSource never notices those.
 *
 * Only for an active session that is being followed. A session that has ended has
 * nothing to be late, and the caller answers for that.
 */
export function contactLostSince({ connection, lastHeardAt, nowMs }: ContactInput): number | null {
  if (connection === "reconnecting" || connection === "closed") {
    return lastHeardAt;
  }
  return nowMs - lastHeardAt >= CONTACT_LOST_AFTER_MS ? lastHeardAt : null;
}
