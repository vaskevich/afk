// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { stubMatchMedia } from "../test-helpers.tsx";
import { THEME_STORAGE_KEY } from "../theme.ts";
import { ThemeProvider } from "../useTheme.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

const MOUSE = { pointerType: "mouse" };

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
      <button type="button">elsewhere</button>
    </ThemeProvider>,
  );
}

const appliedTheme = () => document.documentElement.dataset.theme;
const summary = () => screen.getByRole("button", { name: /^Theme:/ });
const menu = () => summary().parentElement!;
/** The choices are hidden from the accessibility tree until the control expands. */
const option = (name: string) => screen.queryByRole("button", { name });

describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    stubMatchMedia(false);
  });

  afterEach(() => {
    cleanup();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("applies and stores a choice clicked from a hovered menu, then closes it", () => {
    renderToggle();
    fireEvent.pointerEnter(menu(), MOUSE);
    expect(option("Force dark")).not.toBeNull();

    // The press must not hide the menu, or the release never lands on the option.
    fireEvent.pointerDown(option("Force dark")!, MOUSE);
    fireEvent.mouseDown(option("Force dark")!);
    expect(option("Force dark")).not.toBeNull();
    fireEvent.click(option("Force dark")!);

    expect(appliedTheme()).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(summary().getAttribute("aria-expanded")).toBe("false");
    expect(option("Force dark")).toBeNull();
  });

  it("closes a hover-opened menu on Escape wherever focus is", () => {
    renderToggle();
    fireEvent.pointerEnter(menu(), MOUSE);
    expect(option("Force dark")).not.toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(option("Force dark")).toBeNull();
  });

  it("closes a focus-opened menu when the pointer goes down outside it", () => {
    renderToggle();
    act(() => summary().focus());
    expect(option("Force dark")).not.toBeNull();

    fireEvent.pointerDown(document.body, MOUSE);

    expect(option("Force dark")).toBeNull();
  });

  it("keeps a menu open when the pointer goes down inside it", () => {
    renderToggle();
    act(() => summary().focus());

    fireEvent.pointerDown(option("Force light")!, MOUSE);

    expect(option("Force light")).not.toBeNull();
  });

  it("hands focus back to the summary after a keyboard choice, without reopening", () => {
    renderToggle();
    act(() => summary().focus());
    act(() => option("Force light")!.focus());

    fireEvent.click(option("Force light")!);

    expect(appliedTheme()).toBe("light");
    expect(document.activeElement).toBe(summary());
    expect(option("Force light")).toBeNull();
  });

  it("does not open when the pointer entering it is a finger", () => {
    renderToggle();

    fireEvent.pointerEnter(menu(), { pointerType: "touch" });

    expect(option("Force dark")).toBeNull();
  });
});
