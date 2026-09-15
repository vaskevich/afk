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

  it("links to the repository on GitHub in a new tab", async () => {
    withoutStats();

    await renderOnSessionRoute(null, "/", <LandingPage />);

    const link = await screen.findByRole("link", { name: "afk on GitHub" });
    expect(link).toMatchObject({
      href: "https://github.com/vaskevich/afk",
      target: "_blank",
      rel: "noopener noreferrer",
    });
  });
});

describe("LandingPage privacy statement", () => {
  /** The text of the "What leaves your machine?" disclosure. */
  async function statementText(): Promise<string> {
    const summary = await screen.findByText("What leaves your machine?");
    return summary.closest("details")!.textContent ?? "";
  }

  it("names the failed command's output tail and how to turn it off", async () => {
    withoutStats();

    await renderOnSessionRoute(null, "/", <LandingPage />);

    const text = await statementText();
    expect(text).toContain("the last 20 lines of its stdout and stderr");
    expect(text).toContain("AFK_RUN_TAIL_LINES=0");
  });

  it("names the full executable paths of the busiest processes", async () => {
    withoutStats();

    await renderOnSessionRoute(null, "/", <LandingPage />);

    const text = await statementText();
    expect(text).toContain("10 busiest processes");
    expect(text).toContain("full path");
  });

  it("says where a session goes, how long it is kept, and who can read and delete it", async () => {
    withoutStats();

    await renderOnSessionRoute(null, "/", <LandingPage />);

    const text = await statementText();
    expect(text).toContain("afk.osv.im");
    expect(text).toContain("7 days after the session ends");
    expect(text).toContain("anyone holding the link");
    expect(text).toContain("afk delete");
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
