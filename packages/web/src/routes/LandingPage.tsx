import { ServiceStats } from "@afk/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AfkMark } from "../components/AfkMark.tsx";
import { GitHubLink } from "../components/GitHubLink.tsx";
import { formatDuration } from "../format.ts";

/** How often the landing page refreshes the service numbers. */
const STATS_REFRESH_MS = 10_000;
/** How long the copy button reports success before returning to its label. */
const COPIED_FEEDBACK_MS = 1_500;
/** Sessions are deleted this long after they end (AFK_RETENTION_DAYS on the server). */
const RETENTION_DAYS = 7;
/** Remembers whether the reader opened the details below the fold; absent means closed. */
const DETAILS_STORAGE_KEY = "afk.landing.details";
const DETAILS_OPEN_VALUE = "open";

/** What the name stands for; the wordmark says so on hover and to screen readers. */
const AFK_EXPANSION = "away from keyboard";

const route = getRouteApi("/");

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

/** Storage can be unavailable (private mode, blocked); the details are then closed on every visit. */
function readDetailsOpen(): boolean {
  try {
    return localStorage.getItem(DETAILS_STORAGE_KEY) === DETAILS_OPEN_VALUE;
  } catch {
    return false;
  }
}

function writeDetailsOpen(open: boolean): void {
  try {
    if (open) {
      localStorage.setItem(DETAILS_STORAGE_KEY, DETAILS_OPEN_VALUE);
    } else {
      localStorage.removeItem(DETAILS_STORAGE_KEY);
    }
  } catch {
    // Nothing to remember with; the next visit starts closed.
  }
}

export function LandingPage() {
  const [detailsOpen, setDetailsOpen] = useState(readDetailsOpen);
  const { deleted } = route.useSearch();

  function onDetailsToggle(event: SyntheticEvent<HTMLDetailsElement>): void {
    const open = event.currentTarget.open;
    setDetailsOpen(open);
    writeDetailsOpen(open);
  }

  return (
    <main className="page landing">
      <header className="landing-header">
        <AfkMark />
        <div>
          <h1 className="landing-wordmark">
            <abbr title={AFK_EXPANSION}>afk</abbr>
          </h1>
          {/* TODO(copy): draft, the owner will refine */}
          <p className="tagline">Walk away from your laptop. Know if something breaks.</p>
        </div>
        <div className="header-actions">
          <GitHubLink />
          <ThemeToggle />
        </div>
      </header>

      {deleted !== undefined && (
        <p className="notice" role="status">
          Session <code>{deleted}</code> was deleted, with everything it recorded.
        </p>
      )}

      <InstallLine />
      <p className="hint">macOS only for now. One bash script, curl and nothing else.</p>

      {/* TODO(copy): draft, the owner will refine */}
      <dl className="steps">
        <div>
          <dt>
            <code>afk start</code>
          </dt>
          <dd>
            Prints a dashboard URL for your phone: cpu, load, memory pressure, and the busiest
            processes, live, with anything that looks wrong flagged.
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

      <p className="landing-demo">
        Or look at{" "}
        <Link to="/s/$sessionId" params={{ sessionId: "demo" }}>
          a demo session
        </Link>
        .
      </p>

      <details className="landing-more" open={detailsOpen} onToggle={onDetailsToggle}>
        <summary>What leaves your machine?</summary>
        {/* TODO(copy): draft, the owner will refine */}
        <p>
          Once a second: cpu, load averages, and memory numbers (pressure level, free, wired,
          compressed, swap). Every five seconds: the busiest processes, as pid, cpu, memory, and
          executable path. For a wrapped command: the command line as you typed it, how long it has
          run, how many bytes it wrote, and its exit code, never the output itself. At the start:
          host name, macOS version, core count, and memory size. Anyone with the link can see it,
          and anyone with the link can delete it (the Delete button on the session page, or{" "}
          <code>afk delete</code> on the machine); otherwise sessions are deleted {RETENTION_DAYS}{" "}
          days after they end.
        </p>
        <h2>The demo</h2>
        <p>
          Fifteen recorded minutes on one machine: a three-minute cpu burn with memory pressure
          behind it, a burst of short pressure flaps, a stretch where the client went quiet, and two
          Claude Code sessions and a Codex thread, one of which sits on a question for a few
          minutes, so you can see how each shows up before you run anything yourself.
        </p>
        <h2>This server</h2>
        <Stats />
      </details>
    </main>
  );
}
