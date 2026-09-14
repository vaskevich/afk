import { ServiceStats } from "@afk/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { formatDuration } from "../format.ts";

/** How often the landing page refreshes the service numbers. */
const STATS_REFRESH_MS = 10_000;

async function fetchStats(): Promise<ServiceStats> {
  const res = await fetch("/api/stats");
  if (!res.ok) {
    throw new Error(`stats returned ${res.status}`);
  }
  return ServiceStats.parse(await res.json());
}

function Stats() {
  const query = useQuery({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: STATS_REFRESH_MS,
    retry: false,
  });
  if (query.isPending) {
    return <p className="hint">Loading service status…</p>;
  }
  if (query.isError) {
    return <p className="hint">Service status unavailable.</p>;
  }
  const s = query.data;
  const full = s.activeSessions >= s.maxActiveSessions;
  return (
    <dl className="facts">
      <div>
        <dt>active sessions</dt>
        <dd className={full ? "level-critical" : ""}>
          {s.activeSessions} / {s.maxActiveSessions}
        </dd>
      </div>
      <div>
        <dt>streams per session</dt>
        <dd>up to {s.maxStreamsPerSession}</dd>
      </div>
      <div>
        <dt>in memory</dt>
        <dd>
          {s.sessionsInMemory} sessions, {s.framesInMemory} frames
        </dd>
      </div>
      <div>
        <dt>uptime</dt>
        <dd>{formatDuration(s.uptimeSeconds * 1000)}</dd>
      </div>
      <div>
        <dt>server</dt>
        <dd>v{s.serverVersion}</dd>
      </div>
    </dl>
  );
}

export function LandingPage() {
  return (
    <main className="page landing">
      <div className="landing-top">
        <h1 className="wordmark">afk</h1>
        <ThemeToggle />
      </div>
      <p>
        Away-from-keyboard telemetry. Run <code>afk start</code> on a machine you are about to walk
        away from and get a shareable dashboard URL that shows whether everything is still fine:
        cpu, load, memory pressure, swap, and the commands you left running through{" "}
        <code>afk run</code>. Take a look at{" "}
        <Link to="/s/$sessionId" params={{ sessionId: "demo" }}>
          a demo session
        </Link>
        .
      </p>
      <Stats />
    </main>
  );
}
