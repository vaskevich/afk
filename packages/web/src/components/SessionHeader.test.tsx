// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { makeSessionSummary } from "@afk/shared/testing";
import { DEMO_SESSION_ID } from "../data/source.ts";
import { renderOnSessionRoute } from "../test-helpers.tsx";
import { SessionHeader } from "./SessionHeader.tsx";

afterEach(() => {
  cleanup();
});

/** The header with nothing deleted and a deletion nobody expects. */
function header(session = makeSessionSummary({ sessionId: "current" }), deleted = false) {
  return (
    <SessionHeader session={session} connection={null} deleted={deleted} onDeleted={() => {}} />
  );
}

describe("SessionHeader chain links", () => {
  it("links to the previous and the next session when the summary names them", async () => {
    const session = makeSessionSummary({
      sessionId: "current",
      status: "ended",
      previousSessionId: "earlier",
      nextSessionId: "later",
    });

    await renderOnSessionRoute(header(session));

    const previous = await screen.findByRole("link", { name: "← previous session" });
    const next = await screen.findByRole("link", { name: "next session →" });
    expect(previous.getAttribute("href")).toBe("/s/earlier");
    expect(next.getAttribute("href")).toBe("/s/later");
    expect(screen.getByText("continues")).toBeDefined();
    expect(screen.getByText("continued in")).toBeDefined();
  });

  it("shows neither link for a session that stands on its own", async () => {
    await renderOnSessionRoute(header());

    await screen.findByText("test-host");
    expect(screen.queryByRole("link", { name: "← previous session" })).toBeNull();
    expect(screen.queryByRole("link", { name: "next session →" })).toBeNull();
  });

  it("shows only the previous link while a chained session is still active", async () => {
    const session = makeSessionSummary({
      sessionId: "current",
      status: "active",
      previousSessionId: "earlier",
    });

    await renderOnSessionRoute(header(session));

    expect(await screen.findByRole("link", { name: "← previous session" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "next session →" })).toBeNull();
  });
});

describe("SessionHeader actions", () => {
  it("reads Share, then the theme toggle, then Delete, left to right", async () => {
    await renderOnSessionRoute(header());

    const share = await screen.findByRole("button", { name: "Share" });
    const actions = share.parentElement!.parentElement!;

    const names = within(actions)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(names).toEqual(["Share", expect.stringMatching(/^Theme:/), "Delete session"]);
  });
});

describe("SessionHeader delete control", () => {
  it("offers Delete next to Share for an ordinary session", async () => {
    await renderOnSessionRoute(header());

    const remove = await screen.findByRole("button", { name: "Delete session" });
    const share = screen.getByRole("button", { name: "Share" });
    expect(remove.parentElement?.parentElement).toBe(share.parentElement?.parentElement);
  });

  it("offers it for an ended session too, since retention is otherwise the only way out", async () => {
    await renderOnSessionRoute(
      header(makeSessionSummary({ sessionId: "current", status: "ended" })),
    );

    expect(await screen.findByRole("button", { name: "Delete session" })).toBeDefined();
  });

  it("hides it for the demo session, which the server refuses to delete anyway", async () => {
    await renderOnSessionRoute(
      header(makeSessionSummary({ sessionId: DEMO_SESSION_ID, status: "ended" })),
      `/s/${DEMO_SESSION_ID}`,
    );

    await screen.findByRole("button", { name: "Share" });
    expect(screen.queryByRole("button", { name: "Delete session" })).toBeNull();
  });

  it("hides it once the session has been deleted under the viewer", async () => {
    await renderOnSessionRoute(header(makeSessionSummary({ sessionId: "current" }), true));

    await screen.findByRole("button", { name: "Share" });
    expect(screen.queryByRole("button", { name: "Delete session" })).toBeNull();
  });
});
