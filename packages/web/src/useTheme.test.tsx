// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "./components/ThemeToggle.tsx";
import { THEME_STORAGE_KEY } from "./theme.ts";
import { ThemeProvider, useTheme } from "./useTheme.tsx";

/**
 * jsdom has no `matchMedia`; this stand-in reports one answer for the dark-scheme
 * query and lets a test flip it, firing the change listeners like the browser would.
 */
function stubMatchMedia(prefersDark: boolean) {
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

function Resolved() {
  const { resolved } = useTheme();
  return <output data-testid="resolved">{resolved}</output>;
}

function renderThemed() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
      <Resolved />
    </ThemeProvider>,
  );
}

const appliedTheme = () => document.documentElement.dataset.theme;

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    cleanup();
    // vi.fn on window is not covered by restoreMocks, and jsdom has no original to restore to.
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("follows the operating system by default", () => {
    stubMatchMedia(true);

    renderThemed();

    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(appliedTheme()).toBe("dark");
    expect(screen.getByRole("button", { name: "Theme: system. Switch to dark" })).toBeDefined();
  });

  it("changes with the operating system while the page is open", () => {
    const media = stubMatchMedia(false);
    renderThemed();
    expect(appliedTheme()).toBe("light");

    act(() => media.flip(true));

    expect(appliedTheme()).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
  });

  it("applies an explicit choice, persists it, and ignores the operating system", () => {
    stubMatchMedia(false);
    renderThemed();

    fireEvent.click(screen.getByRole("button", { name: "Theme: system. Switch to dark" }));

    expect(appliedTheme()).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "Theme: dark. Switch to light" })).toBeDefined();
  });

  it("starts from the stored choice", () => {
    stubMatchMedia(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");

    renderThemed();

    expect(appliedTheme()).toBe("light");
  });

  it("falls back to system when the stored value is junk", () => {
    stubMatchMedia(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");

    renderThemed();

    expect(appliedTheme()).toBe("dark");
    expect(screen.getByRole("button", { name: "Theme: system. Switch to dark" })).toBeDefined();
  });

  it("still renders and switches when storage throws", () => {
    stubMatchMedia(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    renderThemed();
    fireEvent.click(screen.getByRole("button", { name: "Theme: system. Switch to dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Theme: dark. Switch to light" }));

    expect(appliedTheme()).toBe("light");
  });
});
