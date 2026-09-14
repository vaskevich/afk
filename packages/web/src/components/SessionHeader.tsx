import type { SessionSummary } from "@afk/shared";
import { DEMO_SESSION_ID, type ConnectionState } from "../data/source.ts";
import { Link } from "@tanstack/react-router";
import { formatDateTime, formatDuration, formatGiB } from "../format.ts";
import { useNow } from "../useNow.ts";
import { DeleteSession } from "./DeleteSession.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";
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
  /** The session was deleted while this page was open; there is nothing left to delete. */
  deleted: boolean;
  /** The viewer deleted the session from here. */
  onDeleted(): void;
}

export function SessionHeader({ session, connection, deleted, onDeleted }: Props) {
  // Ended sessions have a fixed duration; an active one keeps counting.
  const now = useNow(session.status === "active");
  const durationMs = (session.endedAt ?? now) - session.startedAt;
  // The demo lives in this bundle, not on the server, and is the one link everyone has.
  const deletable = session.sessionId !== DEMO_SESSION_ID && !deleted;
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
      <div className="header-actions">
        <ThemeToggle />
        <SharePanel url={window.location.href} />
        {deletable && <DeleteSession sessionId={session.sessionId} onDeleted={onDeleted} />}
      </div>
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
        {session.previousSessionId !== null && (
          <div>
            <dt>continues</dt>
            <dd>
              <Link to="/s/$sessionId" params={{ sessionId: session.previousSessionId }}>
                ← previous session
              </Link>
            </dd>
          </div>
        )}
        {session.nextSessionId !== null && (
          <div>
            <dt>continued in</dt>
            <dd>
              <Link to="/s/$sessionId" params={{ sessionId: session.nextSessionId }}>
                next session →
              </Link>
            </dd>
          </div>
        )}
      </dl>
    </header>
  );
}
