// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { apiSource } from "../data/apiSource.ts";
import { renderOnSessionRoute } from "../test-helpers.tsx";
import { SessionPage } from "./SessionPage.tsx";

afterEach(() => {
  cleanup();
});

/**
 * The page's error path only; a loaded session draws on canvas, which jsdom has none
 * of. What matters here is that a link to a session that no longer exists (a chain
 * neighbour's `previousSessionId` after a delete, a stale bookmark) renders a message
 * rather than nothing.
 */
describe("SessionPage for a session that is gone", () => {
  it("says the session was deleted when the server remembers deleting it", async () => {
    vi.spyOn(apiSource, "load").mockRejectedValue(new Error('Session "earlier" was deleted'));

    await renderOnSessionRoute(<SessionPage />, "/s/earlier");

    expect((await screen.findByText(/Could not load session/)).textContent).toBe(
      'Could not load session: Session "earlier" was deleted',
    );
  });

  it("says the session was not found for an id the server does not know", async () => {
    vi.spyOn(apiSource, "load").mockRejectedValue(new Error('Session "gone" not found'));

    await renderOnSessionRoute(<SessionPage />, "/s/gone");

    expect((await screen.findByText(/Could not load session/)).textContent).toBe(
      'Could not load session: Session "gone" not found',
    );
  });
});
