// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "./components/ThemeToggle.tsx";
import { stubMatchMedia } from "./test-helpers.tsx";
import { THEME_STORAGE_KEY } from "./theme.ts";
import { ThemeProvider, useTheme } from "./useTheme.tsx";

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
const summary = () => screen.getByRole("button", { name: /^Theme:/ });
/** The choices are hidden from the accessibility tree until the control expands. */
const option = (name: string) => screen.queryByRole("button", { name });

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

  it("follows the operating system by default and says so", () => {
    stubMatchMedia(true);

    renderThemed();

    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(appliedTheme()).toBe("dark");
    expect(summary().getAttribute("aria-label")).toBe("Theme: dark, following the system");
  });

  it("changes with the operating system while the page is open", () => {
    const media = stubMatchMedia(false);
    renderThemed();
    expect(appliedTheme()).toBe("light");

    act(() => media.flip(true));

    expect(appliedTheme()).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
  });

  it("keeps the choices hidden until tapped, then applies, persists, and marks a choice", () => {
    stubMatchMedia(false);
    renderThemed();
    expect(option("Force dark")).toBeNull();

    fireEvent.click(summary());
    expect(summary().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(option("Force dark")!);

    expect(appliedTheme()).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(summary().getAttribute("aria-label")).toBe(
      "Theme: dark, set here instead of following the system",
    );
    expect(summary().classList.contains("theme-menu-overriding")).toBe(true);
    // Choosing closes what the tap opened; the next tap shows the choice as pressed.
    expect(summary().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary());
    expect(option("Force dark")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("reveals the choices on keyboard focus and hides them when focus leaves", () => {
    stubMatchMedia(true);
    renderThemed();

    act(() => summary().focus());
    expect(option("Follow the system")).not.toBeNull();
    act(() => summary().blur());

    expect(option("Follow the system")).toBeNull();
  });

  it("starts from the stored choice", () => {
    stubMatchMedia(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");

    renderThemed();

    expect(appliedTheme()).toBe("light");
    expect(summary().classList.contains("theme-menu-overriding")).toBe(true);
  });

  it("falls back to system when the stored value is junk", () => {
    stubMatchMedia(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");

    renderThemed();

    expect(appliedTheme()).toBe("dark");
    expect(summary().getAttribute("aria-label")).toBe("Theme: dark, following the system");
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
    fireEvent.click(summary());
    fireEvent.click(option("Force light")!);

    expect(appliedTheme()).toBe("light");
  });
});
