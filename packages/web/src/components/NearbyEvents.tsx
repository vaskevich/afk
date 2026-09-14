import type { AnomalyEvent } from "@afk/shared";
import { eventEndMs } from "../events.ts";
import { formatDuration, formatOffset } from "../format.ts";
import { TopProcesses } from "./TopProcesses.tsx";

interface Props {
  /** Every event of the session, sorted by start. */
  events: readonly AnomalyEvent[];
  /** Session start and the live edge. */
  t0: number;
  latest: number;
  cursor: number;
  /** How far from the cursor still counts as "near", in ms. */
  radiusMs: number;
  onSelectEvent(event: AnomalyEvent): void;
}

function isNear(event: AnomalyEvent, cursor: number, latest: number, radiusMs: number): boolean {
  return event.startedAt - radiusMs <= cursor && cursor <= eventEndMs(event, latest) + radiusMs;
}

function EventList({ events, t0, onSelectEvent }: Pick<Props, "events" | "t0" | "onSelectEvent">) {
  return (
    <ul className="event-list">
      {events.map((event) => (
        <li key={event.id}>
          <button type="button" className="event-row" onClick={() => onSelectEvent(event)}>
            <span className={`dot dot-${event.severity}`} />
            <span className="event-row-stream">{event.stream}</span>
            <span className="event-row-kind">{event.kind}</span>
            <span className="event-row-message">
              {event.message}
              {event.details?.topProcesses && (
                <TopProcesses processes={event.details.topProcesses} />
              )}
            </span>
            <span className="event-row-when">
              +{formatOffset((event.startedAt - t0) / 1000)}
              <small>
                {event.endedAt === null
                  ? "ongoing"
                  : formatDuration(event.endedAt - event.startedAt)}
              </small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Anomalies whose span comes within `radiusMs` of the cursor, so the viewer can see
 * what was going on around the moment they are looking at. Falls back to the full list
 * when nothing is nearby so any event is still one click away.
 */
export function NearbyEvents({ events, t0, latest, cursor, radiusMs, onSelectEvent }: Props) {
  if (events.length === 0) {
    return null;
  }
  const nearby = events.filter((event) => isNear(event, cursor, latest, radiusMs));
  const listed = nearby.length > 0 ? nearby : events;
  const heading =
    nearby.length > 0 ? "Anomalies near the cursor" : `All anomalies (${events.length})`;

  return (
    <section className="nearby" aria-label="Anomalies near the cursor">
      {nearby.length === 0 && <p className="hint nearby-empty">No anomalies near the cursor.</p>}
      <h2>{heading}</h2>
      <EventList events={listed} t0={t0} onSelectEvent={onSelectEvent} />
    </section>
  );
}
