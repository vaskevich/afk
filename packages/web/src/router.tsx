import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { LandingPage } from "./routes/LandingPage.tsx";
import { SessionPage } from "./routes/SessionPage.tsx";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

/**
 * `/?deleted=<id>` is where the session page sends a viewer who deleted the session
 * from it; the landing page says so once. Anything else in the query is dropped.
 */
export interface LandingSearch {
  deleted?: string;
}

/** The shape of every session id the server issues: 22 base62 characters (utils/ids.ts). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

/**
 * `?deleted=<id>` is set by this app after a delete, but anyone can type the URL, so the
 * value is only echoed when it looks like a session id; anything else shows no notice.
 * The router merges a route's validated search over its parent's raw search, so an
 * unwanted key has to be overridden with `undefined`, not just left out.
 */
export function validateLandingSearch(search: Record<string, unknown>): LandingSearch {
  return typeof search.deleted === "string" && SESSION_ID_PATTERN.test(search.deleted)
    ? { deleted: search.deleted }
    : { deleted: undefined };
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validateLandingSearch,
  component: LandingPage,
});

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$sessionId",
  component: SessionPage,
});

const routeTree = rootRoute.addChildren([indexRoute, sessionRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
