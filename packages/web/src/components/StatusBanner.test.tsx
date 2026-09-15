// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { makeEvent } from "@afk/shared/testing";
import { renderOnSessionRoute } from "../test-helpers.tsx";
import { StatusBanner } from "./StatusBanner.tsx";

afterEach(() => {
  cleanup();
});

describe("StatusBanner continuation", () => {
  it("offers the next session once an ended session names one, without navigating", async () => {
    await renderOnSessionRoute(
      <StatusBanner
        status="ended"
        events={[]}
        nextSessionId="later"
        deleted={false}
        contactLostSince={null}
        onSelectEvent={() => {}}
      />,
    );

    const link = await screen.findByRole("link", { name: "open the next one" });
    expect(link.getAttribute("href")).toBe("/s/later");
    expect(screen.getByText(/This session continued/)).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("All normal");
  });

  it("keeps the offer under the anomaly list when there were anomalies", async () => {
    await renderOnSessionRoute(
      <StatusBanner
        status="ended"
        events={[makeEvent({ endedAt: makeEvent().startedAt + 5_000 })]}
        nextSessionId="later"
        deleted={false}
        contactLostSince={null}
        onSelectEvent={() => {}}
      />,
    );

    expect(await screen.findByRole("link", { name: "open the next one" })).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("1 anomaly during this session");
  });

  it("shows no continuation for an ended session without a successor", async () => {
    await renderOnSessionRoute(
      <StatusBanner
        status="ended"
        events={[]}
        nextSessionId={null}
        deleted={false}
        contactLostSince={null}
        onSelectEvent={() => {}}
      />,
    );

    await screen.findByRole("status");
    expect(screen.queryByRole("link", { name: "open the next one" })).toBeNull();
  });
});

describe("StatusBanner for a deleted session", () => {
  it("says the session was deleted instead of any verdict, even with anomalies and a successor", async () => {
    await renderOnSessionRoute(
      <StatusBanner
        status="ended"
        events={[makeEvent()]}
        nextSessionId="later"
        deleted={true}
        contactLostSince={null}
        onSelectEvent={() => {}}
      />,
    );

    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("This session was deleted");
    expect(banner.textContent).not.toContain("anomaly");
    expect(screen.queryByRole("link", { name: "open the next one" })).toBeNull();
  });
});

/**
 * Lost contact means this browser cannot reach the server, which is not the same as
 * `client.stale` (the server cannot hear the machine): the first replaces the verdict
 * with a neutral line, the second is an anomaly like any other.
 */
describe("StatusBanner while contact with the server is lost", () => {
  /** Real clock: the banner only reads the time, so 42 s ago stays 42 s ago through a render. */
  // A fixed clock: the age is rendered from Date.now(), and a real clock ticking
  // between this line and the render turned "42s ago" into "43s ago" under load.
  const NOW = new Date("2026-09-15T00:00:00Z").getTime();
  const LOST_AT = NOW - 42_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says there is no fresh data, naming the server and how long ago, in place of the verdict", async () => {
    const open = makeEvent({ kind: "client.stale", severity: "warning", endedAt: null });

    await renderOnSessionRoute(
      <StatusBanner
        status="active"
        events={[open]}
        nextSessionId={null}
        deleted={false}
        contactLostSince={LOST_AT}
        onSelectEvent={() => {}}
      />,
    );

    const banner = await screen.findByRole("status");
    expect(banner.className).toBe("banner banner-neutral");
    expect(banner.textContent).toBe(
      `No fresh datalost contact with ${window.location.host} 42s ago, reconnecting…`,
    );
    expect(banner.textContent).not.toContain("anomaly");
  });

  it("keeps the verdict for a session that has ended, which has nothing to be late", async () => {
    await renderOnSessionRoute(
      <StatusBanner
        status="ended"
        events={[]}
        nextSessionId={null}
        deleted={false}
        contactLostSince={LOST_AT}
        onSelectEvent={() => {}}
      />,
    );

    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("All normal");
  });

  it("still says the session was deleted, which outranks everything", async () => {
    await renderOnSessionRoute(
      <StatusBanner
        status="active"
        events={[]}
        nextSessionId={null}
        deleted={true}
        contactLostSince={LOST_AT}
        onSelectEvent={() => {}}
      />,
    );

    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("This session was deleted");
  });
});
