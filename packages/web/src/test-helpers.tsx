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
import { vi } from "vitest";
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

/**
 * jsdom has no `matchMedia`; this stand-in reports one answer for the dark-scheme
 * query and lets a test flip it, firing the change listeners like the browser would.
 * Remove it in `afterEach` with `delete window.matchMedia`: `vi.fn` on `window` is not
 * covered by `restoreMocks`, and jsdom has no original to restore to.
 */
export function stubMatchMedia(prefersDark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: prefersDark,
    addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  };
  window.matchMedia = vi.fn(() => query as unknown as MediaQueryList);
  return {
    flip(nowPrefersDark: boolean) {
      query.matches = nowPrefersDark;
      for (const listener of listeners) {
        listener({ matches: nowPrefersDark } as MediaQueryListEvent);
      }
    },
  };
}
