import type { Session, SessionStore } from "./store/sessions.ts";

export interface AppConfig {
  /** Public origin used to build dashboard URLs, e.g. https://afk.osv.im */
  publicBaseUrl: string;
}

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
