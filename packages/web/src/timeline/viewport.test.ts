import { describe, expect, it } from "vitest";
import { T0_MS } from "@afk/shared/testing";
import { MIN_WINDOW_MS, panWindow, resolveWindow, zoomWindow } from "./viewport.ts";

const seconds = (n: number) => T0_MS + n * 1000;
const range = { t0: T0_MS, t1: seconds(600) };

describe("zoomWindow", () => {
  it("halves the window around the anchor when zooming in", () => {
    const window = { v0: seconds(100), v1: seconds(200) };

    const zoomed = zoomWindow(window, seconds(150), 2, range);

    expect(zoomed.v1 - zoomed.v0).toBe(50_000);
    expect(zoomed.v0).toBe(seconds(125));
    expect(zoomed.v1).toBe(seconds(175));
  });

  it("does not zoom in past the 30 second minimum window", () => {
    const window = { v0: seconds(100), v1: seconds(140) }; // 40s wide

    const zoomed = zoomWindow(window, seconds(120), 2, range);

    expect(zoomed.v1 - zoomed.v0).toBe(MIN_WINDOW_MS);
  });

  it("doubles the window when zooming out", () => {
    const window = { v0: seconds(100), v1: seconds(130) }; // 30s wide

    const zoomed = zoomWindow(window, seconds(115), 0.5, range);

    expect(zoomed.v1 - zoomed.v0).toBe(60_000);
  });

  it("clamps to the session range when zooming out would overflow the start", () => {
    const window = { v0: seconds(0), v1: seconds(30) };

    const zoomed = zoomWindow(window, seconds(0), 0.1, range);

    expect(zoomed.v0).toBe(range.t0);
  });

  it("clamps to the session range when zooming out would overflow the end", () => {
    const window = { v0: seconds(570), v1: seconds(600) };

    const zoomed = zoomWindow(window, seconds(600), 0.1, range);

    expect(zoomed.v1).toBe(range.t1);
  });
});

describe("panWindow", () => {
  it("shifts the window by the given delta", () => {
    const window = { v0: seconds(100), v1: seconds(160) };

    const panned = panWindow(window, 10_000, range);

    expect(panned).toEqual({ v0: seconds(110), v1: seconds(170) });
  });

  it("clamps at the start of the range instead of panning past it", () => {
    const window = { v0: seconds(10), v1: seconds(70) };

    const panned = panWindow(window, -50_000, range);

    expect(panned.v0).toBe(range.t0);
    expect(panned.v1 - panned.v0).toBe(60_000);
  });

  it("clamps at the end of the range instead of panning past it", () => {
    const window = { v0: seconds(540), v1: seconds(600) };

    const panned = panWindow(window, 50_000, range);

    expect(panned.v1).toBe(range.t1);
    expect(panned.v1 - panned.v0).toBe(60_000);
  });
});

describe("resolveWindow", () => {
  const model = { t0: range.t0, t1: range.t1, latest: seconds(300) };

  it("returns the full session range when there is no zoom (fit)", () => {
    const resolved = resolveWindow(model, null, false);

    expect(resolved).toEqual({ v0: model.t0, v1: model.t1 });
  });

  it("returns the clamped zoom window unchanged when not following live", () => {
    const zoom = { v0: seconds(100), v1: seconds(160) };

    const resolved = resolveWindow(model, zoom, false);

    expect(resolved).toEqual(zoom);
  });

  it("keeps the zoomed window's width but pins its right edge to latest when following", () => {
    const zoom = { v0: seconds(100), v1: seconds(160) }; // 60s wide

    const resolved = resolveWindow(model, zoom, true);

    expect(resolved.v1 - resolved.v0).toBe(60_000);
    expect(resolved.v1).toBe(model.latest);
  });
});
