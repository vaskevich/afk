// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { T0_MS, makeEvent } from "@afk/shared/testing";
import { NearbyEvents } from "./NearbyEvents.tsx";

afterEach(() => {
  cleanup();
});

const minutes = (n: number) => n * 60 * 1000;

describe("NearbyEvents", () => {
  // Regression: an ongoing event used to show only its start offset and the word
  // "ongoing", so a pressure warning present since the session began read "+00:00
  // ongoing" for the whole hour instead of saying how long it had been going on.
  it("shows how long an ongoing event has lasted, not just when it started", () => {
    const event = makeEvent({ startedAt: T0_MS, endedAt: null });

    render(
      <NearbyEvents
        events={[event]}
        t0={T0_MS}
        latest={T0_MS + minutes(10) + 15_000}
        cursor={T0_MS + minutes(10)}
        radiusMs={5_000}
        onSelectEvent={vi.fn()}
      />,
    );

    expect(screen.getByText("+00:00")).toBeTruthy();
    expect(screen.getByText("ongoing for 10m 15s")).toBeTruthy();
  });

  it("shows a closed event's duration", () => {
    const event = makeEvent({ startedAt: T0_MS + minutes(1), endedAt: T0_MS + minutes(3) });

    render(
      <NearbyEvents
        events={[event]}
        t0={T0_MS}
        latest={T0_MS + minutes(10)}
        cursor={T0_MS + minutes(2)}
        radiusMs={5_000}
        onSelectEvent={vi.fn()}
      />,
    );

    expect(screen.getByText("2m 00s")).toBeTruthy();
  });
});
