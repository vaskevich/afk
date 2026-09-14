import { ServiceStats } from "@afk/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AfkMark } from "../components/AfkMark.tsx";
import { formatDuration } from "../format.ts";

/** How often the landing page refreshes the service numbers. */
const STATS_REFRESH_MS = 10_000;
/** How long the copy button reports success before returning to its label. */
const COPIED_FEEDBACK_MS = 1_500;
/** Sessions are deleted this long after they end (AFK_RETENTION_DAYS on the server). */
const RETENTION_DAYS = 7;

type CopyState = "idle" | "copied" | "selected";

const COPY_BUTTON_LABELS: Record<CopyState, string> = {
  idle: "copy",
  copied: "copied",
  // The clipboard API is unavailable (an http:// self-hosted server); the text is selected instead.
  selected: "press ⌘C",
};

/** Selects the element's text so the user can copy it with the keyboard. */
function selectContents(element: HTMLElement | null): void {
  const selection = window.getSelection();
  if (!element || !selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The one-liner, built from this page's origin so a self-hosted server shows its own URL. */
function InstallLine() {
  const command = `curl -fsSL ${window.location.origin}/install | sh`;
  const codeRef = useRef<HTMLElement>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState !== "copied") {
      return;
    }
    const timer = setTimeout(() => setCopyState("idle"), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      selectContents(codeRef.current);
      setCopyState("selected");
    }
  }

  return (
    <div className="install-line">
      <code ref={codeRef}>{command}</code>
      <button type="button" onClick={copy} aria-label="copy the install command">
        {COPY_BUTTON_LABELS[copyState]}
      </button>
    </div>
  );
}

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
      <header className="landing-header">
        <AfkMark />
        <div>
          <h1 className="wordmark">afk</h1>
          {/* TODO(copy): draft, the owner will refine */}
          <p className="tagline">Walk away from your laptop. Know if something breaks.</p>
        </div>
      </header>

      <InstallLine />
      <p className="hint">macOS only for now. One bash script, no dependencies beyond curl.</p>

      {/* TODO(copy): draft, the owner will refine */}
      <dl className="steps">
        <div>
          <dt>
            <code>afk start</code>
          </dt>
          <dd>
            Prints a dashboard URL for your phone. It shows cpu, load, memory pressure, and the
            busiest processes live, and flags anything that looks wrong.
          </dd>
        </div>
        <div>
          <dt>
            <code>afk run -- &lt;command&gt;</code>
          </dt>
          <dd>
            Wraps a build, a migration, a test run. The dashboard gets a row for it: elapsed time,
            output volume, and whether it finished or failed.
          </dd>
        </div>
      </dl>

      <h2>What leaves your machine</h2>
      {/* TODO(copy): draft, the owner will refine */}
      <p className="privacy">
        Once a second: cpu, load averages, and memory numbers (pressure level, free, wired,
        compressed, swap). Every five seconds: the busiest processes, as pid, cpu, memory, and
        executable path. For a wrapped command: the command line as you typed it, how long it has
        run, how many bytes it wrote, and its exit code, never the output itself. At the start: host
        name, macOS version, core count, and memory size. Anyone with the link can see it; sessions
        are deleted {RETENTION_DAYS} days after they end.
      </p>

      <p>
        Take a look at{" "}
        <Link to="/s/$sessionId" params={{ sessionId: "demo" }}>
          a demo session
        </Link>
        .
      </p>

      <footer className="landing-stats">
        <Stats />
      </footer>
    </main>
  );
}
