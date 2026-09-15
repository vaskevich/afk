// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { renderOnSessionRoute } from "../test-helpers.tsx";
import { LandingPage } from "./LandingPage.tsx";

afterEach(() => {
  cleanup();
});

/** The landing page asks for service stats; here there is no server to ask. */
function withoutStats(): void {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no server in this test"));
}

describe("LandingPage header", () => {
  it("spells the name out on hover and to screen readers", async () => {
    withoutStats();

    await renderOnSessionRoute(null, "/", <LandingPage />);

    const heading = await screen.findByRole("heading", { level: 1 });
    const name = within(heading).getByTitle("away from keyboard");
    expect(name.tagName).toBe("ABBR");
    expect(name.textContent).toBe("afk");
  });
});

describe("LandingPage after a delete", () => {
  it("says which session was deleted when sent here with ?deleted=", async () => {
    withoutStats();

    await renderOnSessionRoute(null, "/?deleted=D3FzMqK8qOLVva9LoHF9uc", <LandingPage />);

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toBe(
      "Session D3FzMqK8qOLVva9LoHF9uc was deleted, with everything it recorded.",
    );
  });

  // Regression: ?deleted= echoed whatever the URL carried, so a hand-typed
  // `?deleted=<alert>script(1)</script>` put that text in the notice (escaped by React,
  // but still nonsense on the page). Only a well-formed session id gets a notice.
  it("shows no notice when ?deleted= is not a session id", async () => {
    await renderOnSessionRoute(
      null,
      "/?deleted=%3Calert%3Escript(1)%3C/script%3E",
      <LandingPage />,
    );

    // Wait for the settled page (the install line is always there) before asserting absence.
    await screen.findByText(/afk start/);
    expect(screen.queryByText(/was deleted/)).toBeNull();
    expect(document.body.textContent).not.toContain("script(1)");
  });

  it("shows no notice on an ordinary visit", async () => {
    withoutStats();

    await renderOnSessionRoute(null, "/", <LandingPage />);

    await screen.findByText(/Walk away from your laptop/);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
