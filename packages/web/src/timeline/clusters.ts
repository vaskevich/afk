import type { AnomalyEvent, EventSeverity } from "@afk/shared";
import { worstSeverity } from "../events.ts";

/** Markers whose starts are closer than this on screen merge into one badge. */
export const CLUSTER_DISTANCE_PX = 12;

/** One or more events whose start markers would overlap at the current zoom. */
export interface EventCluster {
  /** Members in start order; always at least one. */
  events: AnomalyEvent[];
  severity: EventSeverity;
  /** x of the first member's start, CSS pixels. */
  x: number;
}

/**
 * Walks the events in start order and merges each one into the current cluster when
 * its start x is within `distancePx` of the previous member's. Depends on the current
 * window and width, so zooming in splits clusters naturally.
 */
export function clusterEvents(
  events: readonly AnomalyEvent[],
  x: (timeMs: number) => number,
  distancePx = CLUSTER_DISTANCE_PX,
): EventCluster[] {
  const sorted = [...events].sort((a, b) => a.startedAt - b.startedAt);
  const clusters: EventCluster[] = [];
  let current: AnomalyEvent[] = [];
  let previousX = Number.NEGATIVE_INFINITY;

  const flush = () => {
    if (current.length > 0) {
      clusters.push({
        events: current,
        severity: worstSeverity(current) ?? "info",
        x: x(current[0]!.startedAt),
      });
    }
    current = [];
  };

  for (const event of sorted) {
    const startX = x(event.startedAt);
    if (startX - previousX > distancePx) {
      flush();
    }
    current.push(event);
    previousX = startX;
  }
  flush();
  return clusters;
}
