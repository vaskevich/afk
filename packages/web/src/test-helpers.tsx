/**
 * Shared helpers for component tests that need the app's providers: components that
 * render a router `Link` need a router, and the header's theme toggle needs the theme
 * context. Import only from tests.
 */
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ThemeProvider } from "./useTheme.tsx";

/**
 * Renders `element` as the component of a `/s/$sessionId` route in a router that
 * lives in memory, at `path`. Links resolve to real hrefs without a browser history.
 */
export async function renderOnSessionRoute(element: ReactNode, path = "/s/current") {
  const rootRoute = createRootRoute();
  const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/s/$sessionId",
    component: () => element,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([sessionRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const rendered = render(
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
  await router.load();
  return rendered;
}
