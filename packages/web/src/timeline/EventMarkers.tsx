import type { AnomalyEvent } from "@afk/shared";
import { useMemo, type PointerEvent } from "react";
import { eventEndMs } from "../events.ts";
import { formatOffset } from "../format.ts";
import { clusterEvents, type EventCluster } from "./clusters.ts";

interface Props {
  /** This row's events, in start order. */
  events: readonly AnomalyEvent[];
  /** Session start, for offsets in titles. */
  t0: number;
  /** Where an open event's band ends. */
  latest: number;
  /** Plot width in CSS pixels. */
  width: number;
  x(timeMs: number): number;
  onSelectEvent(event: AnomalyEvent): void;
  onSelectCluster(cluster: EventCluster): void;
}

/** Markers just outside the plot are still drawn so a badge is never cut in half. */
const MARKER_OVERHANG_PX = 8;
const MIN_BAND_WIDTH_PX = 2;

function describe(event: AnomalyEvent, t0: number): string {
  return `+${formatOffset((event.startedAt - t0) / 1000)} ${event.kind}: ${event.message}`;
}

/** Keeps a marker click from also starting a scrub on the row underneath. */
function stopScrub(e: PointerEvent) {
  e.stopPropagation();
}

/**
 * DOM overlay for one row: a translucent band along the top of the row for each
 * event's duration, and a clickable marker (or a count badge for a cluster) at each
 * start. Everything is positioned from the same `x` the canvas uses.
 */
export function EventMarkers({
  events,
  t0,
  latest,
  width,
  x,
  onSelectEvent,
  onSelectCluster,
}: Props) {
  const clusters = useMemo(() => clusterEvents(events, x), [events, x]);
  if (width === 0 || events.length === 0) {
    return null;
  }

  const bands = events.flatMap((event) => {
    const left = Math.max(0, x(event.startedAt));
    const right = Math.min(width, x(eventEndMs(event, latest)));
    if (right < 0 || left > width) {
      return [];
    }
    return [
      <div
        key={event.id}
        className={`event-band event-${event.severity}`}
        style={{ left, width: Math.max(MIN_BAND_WIDTH_PX, right - left) }}
      />,
    ];
  });

  const markers = clusters.flatMap((cluster) => {
    if (cluster.x < -MARKER_OVERHANG_PX || cluster.x > width + MARKER_OVERHANG_PX) {
      return [];
    }
    if (cluster.events.length === 1) {
      const event = cluster.events[0]!;
      return [
        <button
          key={event.id}
          type="button"
          className={`event-marker event-${event.severity}`}
          style={{ left: cluster.x }}
          title={describe(event, t0)}
          aria-label={describe(event, t0)}
          onPointerDown={stopScrub}
          onClick={() => onSelectEvent(event)}
        />,
      ];
    }
    const title = `${cluster.events.length} anomalies:\n${cluster.events
      .map((event) => describe(event, t0))
      .join("\n")}`;
    return [
      <button
        key={cluster.events[0]!.id}
        type="button"
        className={`event-cluster event-${cluster.severity}`}
        style={{ left: cluster.x }}
        title={title}
        aria-label={title}
        onPointerDown={stopScrub}
        onClick={() => onSelectCluster(cluster)}
      >
        {cluster.events.length}
      </button>,
    ];
  });

  return (
    <div className="event-overlay">
      {bands}
      {markers}
    </div>
  );
}
