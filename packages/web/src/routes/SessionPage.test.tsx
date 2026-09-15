// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { apiSource } from "../data/apiSource.ts";
import { SessionGoneError } from "../data/source.ts";
import { renderOnSessionRoute } from "../test-helpers.tsx";
import { SessionPage } from "./SessionPage.tsx";

afterEach(() => {
  cleanup();
});

/** The page while it has nothing to draw yet; a loaded session draws on canvas, which jsdom has none of. */
describe("SessionPage while the session loads", () => {
  it("shows a centred status block saying it is loading, with no way out yet", async () => {
    vi.spyOn(apiSource, "load").mockReturnValue(new Promise(() => {}));

    await renderOnSessionRoute(<SessionPage />, "/s/pending");

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Loading session…");
    expect(within(status).getByRole("img", { name: "afk" })).toBeTruthy();
    expect(within(status).queryByRole("link")).toBeNull();
  });
});

/**
 * What matters here is that a link to a session that no longer exists (a chain
 * neighbour's `previousSessionId` after a delete, a stale bookmark) says so, names the
 * id, and offers the landing page, rather than rendering nothing.
 */
describe("SessionPage for a session that is gone", () => {
  it("says the session was deleted when the server remembers deleting it", async () => {
    vi.spyOn(apiSource, "load").mockRejectedValue(new SessionGoneError("earlier", "deleted"));

    await renderOnSessionRoute(<SessionPage />, "/s/earlier");

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Session earlier was deleted.← Back to afk");
    expect(within(status).getByText("earlier").tagName).toBe("CODE");
    expect(within(status).getByRole("link", { name: "← Back to afk" })).toMatchObject({
      pathname: "/",
    });
  });

  it("says the session was not found for an id the server does not know", async () => {
    vi.spyOn(apiSource, "load").mockRejectedValue(new SessionGoneError("gone", "not-found"));

    await renderOnSessionRoute(<SessionPage />, "/s/gone");

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Session gone not found.← Back to afk");
    expect(within(status).getByText("gone").tagName).toBe("CODE");
    expect(within(status).getByRole("link", { name: "← Back to afk" })).toMatchObject({
      pathname: "/",
    });
  });

  // The id comes from the URL; a hand-typed one lands in the message as text, nothing more.
  it("shows a hand-typed id as text, not markup", async () => {
    const typed = "<b>bold</b>";
    vi.spyOn(apiSource, "load").mockRejectedValue(new SessionGoneError(typed, "not-found"));

    await renderOnSessionRoute(<SessionPage />, `/s/${encodeURIComponent(typed)}`);

    const status = await screen.findByRole("status");
    expect(within(status).getByText(typed).tagName).toBe("CODE");
    expect(status.querySelector("b")).toBeNull();
  });

  it("repeats the error's own words for any other failure", async () => {
    vi.spyOn(apiSource, "load").mockRejectedValue(new Error("Server returned 502"));

    await renderOnSessionRoute(<SessionPage />, "/s/unreachable");

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Could not load session: Server returned 502.← Back to afk");
  });
});

/**
 * The demo session, served from the fixture, through the whole page. jsdom draws no
 * canvas (useCanvas stops at a null context) and measures nothing, so the plot is
 * given a width by hand and only the DOM around the canvas is checked: the agents row,
 * its event markers, the anomaly list, and the per-tool details line.
 */
describe("SessionPage for the demo session", () => {
  const PLOT_WIDTH_PX = 900;
  let clientWidth: PropertyDescriptor | undefined;

  beforeEach(() => {
    clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => PLOT_WIDTH_PX,
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    if (clientWidth) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
    }
    vi.unstubAllGlobals();
  });

  it("shows the agents row with a marker for each of its two events", async () => {
    await renderOnSessionRoute(<SessionPage />, "/s/demo");

    expect(await screen.findByLabelText("agents timeline for agents")).toBeTruthy();
    expect(
      screen.getByLabelText(
        "+06:30 agents.waiting: 1 Claude Code agent has been waiting on you for over 2m",
      ).tagName,
    ).toBe("BUTTON");
    expect(
      screen.getByLabelText("+10:00 agents.all-idle: all 3 agents idle for over 60s").tagName,
    ).toBe("BUTTON");
  });

  it("has no GitHub link; that belongs to the landing page", async () => {
    await renderOnSessionRoute(<SessionPage />, "/s/demo");
    await screen.findByLabelText("agents timeline for agents");

    expect(screen.queryByRole("link", { name: "afk on GitHub" })).toBeNull();
  });

  it("lists the all-idle event near the cursor at the end, with both tools idle in the details", async () => {
    await renderOnSessionRoute(<SessionPage />, "/s/demo");
    await screen.findByLabelText("agents timeline for agents");

    const nearby = within(screen.getByRole("region", { name: "Anomalies near the cursor" }));
    expect(nearby.getByText("all 3 agents idle for over 60s")).toBeTruthy();
    expect(nearby.queryByText(/waiting on you/)).toBeNull();
    const details = within(screen.getByRole("region", { name: "Values at cursor" }));
    expect(details.getByText("Claude Code").tagName).toBe("DT");
    expect(details.getByText("2 sessions, 2 idle").tagName).toBe("DD");
    expect(details.getByText("Codex").tagName).toBe("DT");
    expect(details.getByText("1 session, 1 idle").tagName).toBe("DD");
  });

  it("moves the cursor to the waiting event on its marker, where the Codex thread is still working", async () => {
    await renderOnSessionRoute(<SessionPage />, "/s/demo");
    const marker = await screen.findByLabelText(/agents\.waiting/);

    fireEvent.click(marker);

    const nearby = within(screen.getByRole("region", { name: "Anomalies near the cursor" }));
    expect(
      nearby.getByText("1 Claude Code agent has been waiting on you for over 2m"),
    ).toBeTruthy();
    const details = within(screen.getByRole("region", { name: "Values at cursor" }));
    expect(details.getByText("2 sessions, 1 waiting on input, 1 idle").className).toBe(
      "level-warn",
    );
    expect(details.getByText("1 session, 1 working").className).toBe("");
  });
});
