import { Hono } from "hono";
import { PROTOCOL_VERSION } from "@afk/shared";
import type { VersionResponse } from "@afk/shared";
import type { AppDeps } from "../env.ts";

/**
 * What is running: the server's package version and build identity, the dashboard
 * build it serves, and the protocol version. Mounted at /versionz (the operator's
 * path, next to /api/health for the load balancer) and at /api/version (the same body
 * under the API prefix the dashboard's dev proxy forwards). Unauthenticated and cheap:
 * infra/deploy.sh polls it after a rollout to check the new commit is live.
 */
export function versionRoutes({ config }: AppDeps) {
  return new Hono().get("/", (c) => {
    const body: VersionResponse = {
      server: config.build,
      web: config.webBuild,
      protocolVersion: PROTOCOL_VERSION,
    };
    return c.json(body);
  });
}
