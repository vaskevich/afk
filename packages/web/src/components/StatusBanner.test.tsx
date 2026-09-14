// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
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
      <StatusBanner status="ended" events={[]} nextSessionId="later" onSelectEvent={() => {}} />,
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
        onSelectEvent={() => {}}
      />,
    );

    expect(await screen.findByRole("link", { name: "open the next one" })).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("1 anomaly during this session");
  });

  it("shows no continuation for an ended session without a successor", async () => {
    await renderOnSessionRoute(
      <StatusBanner status="ended" events={[]} nextSessionId={null} onSelectEvent={() => {}} />,
    );

    await screen.findByRole("status");
    expect(screen.queryByRole("link", { name: "open the next one" })).toBeNull();
  });
});
