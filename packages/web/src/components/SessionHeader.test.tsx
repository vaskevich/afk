// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { makeSessionSummary } from "@afk/shared/testing";
import { renderOnSessionRoute } from "../test-helpers.tsx";
import { SessionHeader } from "./SessionHeader.tsx";

afterEach(() => {
  cleanup();
});

describe("SessionHeader chain links", () => {
  it("links to the previous and the next session when the summary names them", async () => {
    const session = makeSessionSummary({
      sessionId: "current",
      status: "ended",
      previousSessionId: "earlier",
      nextSessionId: "later",
    });

    await renderOnSessionRoute(<SessionHeader session={session} connection={null} />);

    const previous = await screen.findByRole("link", { name: "← previous session" });
    const next = await screen.findByRole("link", { name: "next session →" });
    expect(previous.getAttribute("href")).toBe("/s/earlier");
    expect(next.getAttribute("href")).toBe("/s/later");
    expect(screen.getByText("continues")).toBeDefined();
    expect(screen.getByText("continued in")).toBeDefined();
  });

  it("shows neither link for a session that stands on its own", async () => {
    await renderOnSessionRoute(
      <SessionHeader session={makeSessionSummary({ sessionId: "current" })} connection="live" />,
    );

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

    await renderOnSessionRoute(<SessionHeader session={session} connection="live" />);

    expect(await screen.findByRole("link", { name: "← previous session" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "next session →" })).toBeNull();
  });
});
