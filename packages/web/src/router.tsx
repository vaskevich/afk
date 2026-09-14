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

export function validateLandingSearch(search: Record<string, unknown>): LandingSearch {
  return typeof search.deleted === "string" ? { deleted: search.deleted } : {};
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
