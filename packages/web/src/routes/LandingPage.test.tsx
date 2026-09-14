// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderOnSessionRoute } from "../test-helpers.tsx";
import { LandingPage } from "./LandingPage.tsx";

afterEach(() => {
  cleanup();
});

/** The landing page asks for service stats; here there is no server to ask. */
function withoutStats(): void {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no server in this test"));
}

describe("LandingPage after a delete", () => {
  it("says which session was deleted when sent here with ?deleted=", async () => {
    withoutStats();

    await renderOnSessionRoute(null, "/?deleted=D3FzMqK8qOLVva9LoHF9uc", <LandingPage />);

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toBe(
      "Session D3FzMqK8qOLVva9LoHF9uc was deleted, with everything it recorded.",
    );
  });

  it("shows no notice on an ordinary visit", async () => {
    withoutStats();

    await renderOnSessionRoute(null, "/", <LandingPage />);

    await screen.findByText(/Walk away from your laptop/);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
