import type { AnomalyEvent, SessionStatus } from "@afk/shared";
import { isOpenEvent, pluralize, worstSeverity } from "../events.ts";
import { TopProcesses } from "./TopProcesses.tsx";

interface Props {
  status: SessionStatus;
  /** Every event of the session, sorted by start. */
  events: readonly AnomalyEvent[];
  /** Move the cursor to an event the viewer clicked. */
  onSelectEvent(event: AnomalyEvent): void;
}

/**
 * Overall verdict for the session, driven entirely by the server's anomaly events. The
 * browser does not interpret raw measurements on purpose: thresholds live on the server
 * so they can change without shipping a new client or dashboard.
 *
 * While the session is active the banner reflects what is wrong right now (open
 * events). Once it is over it summarises what happened.
 */
export function StatusBanner({ status, events, onSelectEvent }: Props) {
  const active = status === "active";
  const listed = active ? events.filter(isOpenEvent) : events;
  const worst = worstSeverity(listed);

  if (listed.length === 0) {
    return (
      <div className="banner banner-ok" role="status">
        <span className="dot" />
        All normal
        <small>{active ? "no open anomalies" : "no anomalies during this session"}</small>
      </div>
    );
  }

  // Active sessions colour the whole banner by the worst open event; ended ones keep a
  // neutral banner and only tint the dot, since nothing is wrong any more.
  const tone = active ? `banner-${worst}` : "banner-neutral";
  const headline = active
    ? `${pluralize(listed.length, "anomaly", "anomalies")} now`
    : `${pluralize(listed.length, "anomaly", "anomalies")} during this session`;

  return (
    <div className={`banner ${tone}`} role="status">
      <div className="banner-headline">
        <span className={`dot dot-${worst}`} />
        {headline}
      </div>
      <ul className="banner-events">
        {listed.map((event) => (
          <li key={event.id}>
            <button
              type="button"
              className="banner-event"
              onClick={() => onSelectEvent(event)}
              title={`${event.stream} ${event.kind}: jump to this anomaly`}
            >
              <span className={`dot dot-${event.severity}`} />
              <span className="banner-event-text">
                {event.message}
                {event.details?.topProcesses && (
                  <TopProcesses processes={event.details.topProcesses} />
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
