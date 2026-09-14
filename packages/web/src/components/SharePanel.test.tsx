// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SharePanel, qrSvgPath } from "./SharePanel.tsx";

const URL = "https://afk.test/s/D3FzMqK8qOLVva9LoHF9uc";

afterEach(() => {
  cleanup();
});

describe("qrSvgPath", () => {
  it("draws dark modules as unit squares inside a quiet zone", () => {
    const { size, path } = qrSvgPath(URL);

    // Every square is offset by the quiet zone, so no module sits on the edge.
    expect(path).toMatch(/^(M\d+,\d+h1v1h-1z)+$/);
    expect(path).not.toContain("M0,");
    expect(size).toBeGreaterThan(21);
  });
});

describe("SharePanel", () => {
  it("shows nothing but the button until it is opened", () => {
    render(<SharePanel url={URL} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeDefined();
  });

  it("opens a panel with the URL and a QR code", () => {
    const { container } = render(<SharePanel url={URL} />);

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(screen.getByRole("dialog")).toBeDefined();
    expect((screen.getByLabelText("Session URL") as HTMLInputElement).value).toBe(URL);
    expect(container.querySelector("svg path")?.getAttribute("d")).toMatch(/^M\d+,\d+h1v1h-1z/);
  });

  it("copies the URL to the clipboard and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom has no clipboard; the browser API is the true edge here.
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SharePanel url={URL} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeDefined());
    expect(writeText).toHaveBeenCalledWith(URL);
  });

  it("closes when the pointer goes down anywhere outside it", () => {
    render(<SharePanel url={URL} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByRole("dialog")).toBeDefined();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Share" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("stays open when the pointer goes down inside it", () => {
    render(<SharePanel url={URL} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    fireEvent.pointerDown(screen.getByLabelText("Session URL"));

    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("closes on Escape", () => {
    render(<SharePanel url={URL} />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still toggles closed from its own button while open", () => {
    render(<SharePanel url={URL} />);
    const button = screen.getByRole("button", { name: "Share" });
    fireEvent.click(button);

    // A real click is a pointer press on the button first; the press must not close
    // the panel, or the click that follows would reopen it.
    fireEvent.pointerDown(button);
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.click(button);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
