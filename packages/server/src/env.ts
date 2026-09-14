import type { Session, SessionStore } from "./store/sessions.ts";

export interface AppConfig {
  /** Public origin used to build dashboard URLs, e.g. https://afk.osv.im */
  publicBaseUrl: string;
  /** Absolute path to the built dashboard (packages/web/dist). */
  webDistDir: string;
  limits: AdmissionLimits;
}

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
}

export const DEFAULT_LIMITS: AdmissionLimits = {
  maxActiveSessions: 20,
  maxStreamsPerSession: 10,
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
  };
};
