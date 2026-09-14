import type { SessionSummary } from "@afk/shared";
import type { ConnectionState } from "../data/source.ts";
import { Link } from "@tanstack/react-router";
import { formatDateTime, formatDuration, formatGiB } from "../format.ts";
import { useNow } from "../useNow.ts";
import { SharePanel } from "./SharePanel.tsx";

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  closed: "disconnected",
};

interface Props {
  session: SessionSummary;
  /** Live transport state, or null when not following (ended sessions, the demo). */
  connection: ConnectionState | null;
}

export function SessionHeader({ session, connection }: Props) {
  // Ended sessions have a fixed duration; an active one keeps counting.
  const now = useNow(session.status === "active");
  const durationMs = (session.endedAt ?? now) - session.startedAt;
  return (
    <header className="session-header">
      <span className="wordmark">
        <Link to="/">afk</Link>
      </span>
      <h1>
        {session.host.hostname}
        <span className={`pill pill-${session.status}`}>{session.status}</span>
        {connection && (
          <span className={`pill pill-connection pill-connection-${connection}`}>
            {CONNECTION_LABELS[connection]}
          </span>
        )}
      </h1>
      <SharePanel url={window.location.href} />
      <dl className="facts">
        <div>
          <dt>started</dt>
          <dd>{formatDateTime(session.startedAt)}</dd>
        </div>
        <div>
          <dt>duration</dt>
          <dd>{formatDuration(durationMs)}</dd>
        </div>
        <div>
          <dt>cpus</dt>
          <dd>{session.host.cpuCount}</dd>
        </div>
        <div>
          <dt>memory</dt>
          <dd>{formatGiB(session.host.memoryTotalBytes)}</dd>
        </div>
        <div>
          <dt>os</dt>
          <dd>
            {session.host.platform} {session.host.osVersion}
          </dd>
        </div>
        <div>
          <dt>client</dt>
          <dd>v{session.clientVersion}</dd>
        </div>
      </dl>
    </header>
  );
}
