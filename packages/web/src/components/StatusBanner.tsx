import type { AnomalyEvent, SessionStatus } from "@afk/shared";
import { Link } from "@tanstack/react-router";
import { isOpenEvent, pluralize, worstSeverity } from "../events.ts";
import { OutputTail } from "./OutputTail.tsx";
import { TopProcesses } from "./TopProcesses.tsx";

interface Props {
  status: SessionStatus;
  /** Every event of the session, sorted by start. */
  events: readonly AnomalyEvent[];
  /**
   * The session that continues this one, once it has ended by chaining. Arrives with
   * the `end` stream event while a viewer is watching live, so the banner offers the
   * link rather than navigating: the viewer may be reading this trace.
   */
  nextSessionId: string | null;
  /**
   * The session was deleted while this page was watching it (the stream's `end` said
   * so). What is on the page is all that is left; the server has nothing.
   */
  deleted: boolean;
  /** Move the cursor to an event the viewer clicked. */
  onSelectEvent(event: AnomalyEvent): void;
}

/**
 * Overall verdict for the session, driven entirely by the server's anomaly events. The
 * browser does not interpret raw measurements on purpose: thresholds live on the server
 * so they can change without shipping a new client or dashboard.
 *
 * While the session is active the banner reflects what is wrong right now (open
 * events). Once it is over it summarises what happened, and says where the trace
 * continues when the client chained to a successor. A session deleted under the
 * viewer gets one line saying so instead: there is no verdict left to give.
 */
export function StatusBanner({ status, events, nextSessionId, deleted, onSelectEvent }: Props) {
  if (deleted) {
    return (
      <div className="banner banner-warning" role="status">
        <span className="dot dot-warning" />
        This session was deleted
        <small>the server no longer has it; this page shows what was loaded before</small>
      </div>
    );
  }

  const active = status === "active";
  const listed = active ? events.filter(isOpenEvent) : events;
  const worst = worstSeverity(listed);
  const continuation = !active && nextSessionId !== null && (
    <p className="banner-continued">
      This session continued:{" "}
      <Link to="/s/$sessionId" params={{ sessionId: nextSessionId }}>
        open the next one
      </Link>
    </p>
  );

  if (listed.length === 0) {
    return (
      <div className="banner banner-ok" role="status">
        <span className="dot" />
        All normal
        <small>{active ? "no open anomalies" : "no anomalies during this session"}</small>
        {continuation}
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
            {event.details?.outputTail && <OutputTail tail={event.details.outputTail} />}
          </li>
        ))}
      </ul>
      {continuation}
    </div>
  );
}
