import { describe, expect, it } from "vitest";
import { T0_MS, makeEvent } from "@afk/shared/testing";
import { CLUSTER_DISTANCE_PX, clusterEvents } from "./clusters.ts";

const seconds = (n: number) => T0_MS + n * 1000;

/** Maps ms to px with a fixed scale, so tests can simulate zooming by changing it. */
const scaleX =
  (pxPerMs: number) =>
  (timeMs: number): number =>
    (timeMs - T0_MS) * pxPerMs;

describe("clusterEvents", () => {
  it("merges two events into one cluster when their start markers are closer than the threshold", () => {
    const events = [makeEvent({ startedAt: seconds(0) }), makeEvent({ startedAt: seconds(5) })];

    const clusters = clusterEvents(events, scaleX(0.001), CLUSTER_DISTANCE_PX);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.events).toHaveLength(2);
  });

  it("reports the worst severity among a cluster's members", () => {
    const events = [
      makeEvent({ startedAt: seconds(0), severity: "info" }),
      makeEvent({ startedAt: seconds(3), severity: "critical" }),
    ];

    const clusters = clusterEvents(events, scaleX(0.001), CLUSTER_DISTANCE_PX);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.severity).toBe("critical");
  });

  it("keeps two events as separate clusters when they are farther apart than the threshold", () => {
    const events = [makeEvent({ startedAt: seconds(0) }), makeEvent({ startedAt: seconds(20) })];

    const clusters = clusterEvents(events, scaleX(0.001), CLUSTER_DISTANCE_PX);

    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.events.length)).toEqual([1, 1]);
  });

  it("splits a merged cluster apart when zooming in widens the mapping between them", () => {
    const events = [makeEvent({ startedAt: seconds(0) }), makeEvent({ startedAt: seconds(5) })];

    const zoomedOut = clusterEvents(events, scaleX(0.001), CLUSTER_DISTANCE_PX);
    const zoomedIn = clusterEvents(events, scaleX(0.01), CLUSTER_DISTANCE_PX);

    expect(zoomedOut).toHaveLength(1);
    expect(zoomedIn).toHaveLength(2);
  });

  it("does not filter events by position: clustering is blind to any viewport width", () => {
    // clusterEvents takes only an x-mapping, not a width, so it clusters purely by
    // pixel distance and leaves excluding off-screen markers to the caller.
    const events = [
      makeEvent({ startedAt: seconds(-1000) }),
      makeEvent({ startedAt: seconds(1000) }),
    ];

    const clusters = clusterEvents(events, scaleX(1), CLUSTER_DISTANCE_PX);

    expect(clusters.flatMap((c) => c.events)).toHaveLength(2);
  });

  it("returns an empty array for no events", () => {
    expect(clusterEvents([], scaleX(1))).toEqual([]);
  });
});
