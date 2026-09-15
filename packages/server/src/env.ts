import { MIN_CLIENT_VERSION, MIN_PROTOCOL_VERSION } from "@afk/shared";
import type { ServerBuildInfo, WebBuildInfo } from "@afk/shared";
import type { Session, SessionStore } from "./store/sessions.ts";

/**
 * What route modules need at request time. `index.ts` builds it from the validated
 * `ServerConfig` (config.ts); tests build it by hand with an in-memory store.
 */
export interface AppConfig {
  /** Public origin used to build dashboard URLs, e.g. https://afk.osv.im */
  publicBaseUrl: string;
  /** Absolute path to the built dashboard (packages/web/dist). */
  webDistDir: string;
  /** Absolute path to the client script (cli/afk) served at /cli/afk and by the installer. */
  clientScriptPath: string;
  limits: AdmissionLimits;
  /** How often an SSE stream sends a comment so proxies and browsers keep it open. */
  sseKeepaliveMs: number;
  minimumVersions: MinimumVersions;
  /** What this server was built from, reported by /versionz and /api/stats. */
  build: ServerBuildInfo;
  /** What the served dashboard was built from (`dist/version.json`), or null without a build. */
  webBuild: WebBuildInfo | null;
  /**
   * The version of the client served at /cli/afk (its `AFK_VERSION` line, read at
   * startup), or null without a client script. Reported by /versionz and, as
   * `latestClientVersion`, on every session create so clients can tell they are behind.
   */
  latestClientVersion: string | null;
}

export const DEFAULT_SSE_KEEPALIVE_MS = 15_000;

/**
 * The oldest client and protocol this deployment talks to; anything older gets 426
 * Upgrade Required (see docs/VERSIONING.md). The shared constants are the defaults;
 * `AFK_MIN_CLIENT_VERSION` / `AFK_MIN_PROTOCOL_VERSION` raise them per deployment,
 * e.g. to retire one client release with a known-bad retry loop.
 */
export interface MinimumVersions {
  /** Semver string; compared numerically against the `X-Afk-Client` header. */
  clientVersion: string;
  /** Integer; the create request's `protocolVersion` must be at least this. */
  protocolVersion: number;
}

export const DEFAULT_MINIMUM_VERSIONS: MinimumVersions = {
  clientVersion: MIN_CLIENT_VERSION,
  protocolVersion: MIN_PROTOCOL_VERSION,
};

/**
 * Admission control. Sized for the smallest Lightsail container node (0.25 vCPU,
 * 512 MB): memory is the constraint, since active sessions keep every frame in memory
 * for replay and SSE. A one-hour stream at 1 Hz is roughly 5 MB of JS objects, so
 * 20 sessions x 10 streams worst case stays under 300 MB with headroom for Node itself;
 * typical sessions (one or two streams) use a fraction of that. Ended sessions are
 * evicted from memory after a few minutes without viewers so they do not count.
 */
export interface AdmissionLimits {
  maxActiveSessions: number;
  maxStreamsPerSession: number;
  /**
   * Hard ceiling on stored frames per session. Streams and sessions are capped, but
   * without this one anonymous session could push thousands of frames per request and
   * exhaust memory. 15 000 is about four hours of one 1 Hz stream, or the one-hour cap
   * with the system, processes, and a couple of run streams, at roughly 20 MB in memory.
   */
  maxFramesPerSession: number;
  /**
   * Hard ceiling on stored bytes per session, measured as the NDJSON the frames are
   * persisted as. The frame cap was sized for 350-byte system frames, but a `processes`
   * frame with ten long commands is ~6 KB and a `run` frame with a full tail ~8.5 KB,
   * so 15 000 of those would be over 100 MB; this bounds a session whatever it sends.
   * 8 MiB is an hour of every collector at 1 Hz with headroom.
   */
  maxBytesPerSession: number;
  /**
   * Open SSE connections (`GET /api/sessions/:id/stream`) one session may have, and
   * the whole process may have. Each replays every frame and holds a listener for as
   * long as the socket lives, so without a bound whoever holds one large session's link
   * could open hundreds and spend the node's CPU and egress. Beyond either the route
   * answers 503 with `Retry-After`. 20 viewers of one session is far more than a share
   * link sees; 200 is ten per active session at the session cap.
   */
  maxSseConnectionsPerSession: number;
  maxSseConnections: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_LIMITS: AdmissionLimits = {
  maxActiveSessions: 20,
  maxStreamsPerSession: 10,
  maxFramesPerSession: 15_000,
  maxBytesPerSession: 8 * MIB,
  maxSseConnectionsPerSession: 20,
  maxSseConnections: 200,
};

/** Everything route modules need. Passed in explicitly so tests can build an app with a fresh store. */
export interface AppDeps {
  config: AppConfig;
  store: SessionStore;
}

/** Hono environment: variables that middleware can set on the request context. */
export type AppEnv = {
  Variables: {
    /** Set by `ingestAuth` once the bearer token has been checked. */
    session: Session;
    /** Set by `clientVersion` from the `X-Afk-Client` header once it has passed the minimum. */
    clientVersion: string;
  };
};
