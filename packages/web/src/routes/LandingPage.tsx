import {
  PROCESSES_TOP_MAX,
  RUN_TAIL_MAX_LINES,
  RUN_TAIL_MAX_LINE_CHARS,
  ServiceStats,
} from "@afk/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AfkMark } from "../components/AfkMark.tsx";
import { GITHUB_URL, GitHubLink } from "../components/GitHubLink.tsx";
import { formatDuration } from "../format.ts";

/** How often the landing page refreshes the service numbers. */
const STATS_REFRESH_MS = 10_000;
/** How long the copy button reports success before returning to its label. */
const COPIED_FEEDBACK_MS = 1_500;
/** Sessions are deleted this long after they end (AFK_RETENTION_DAYS on the server). */
const RETENTION_DAYS = 7;
/** The hosted instance and where it runs (infra/variables.tf), named in the privacy statement. */
const HOSTED_HOST = "afk.osv.im";
const HOSTED_REGION = "us-west-2";
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
            <small className="hint">
              Keep the Mac awake: sleep pauses everything, and a session that goes quiet for ten
              minutes ends.
            </small>
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
        <p>
          Everything below and nothing else: no file contents, no environment variables, no process
          arguments, no agent transcripts, and no output of a command that succeeds. The{" "}
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            client
          </a>{" "}
          is one bash script you can read first.
        </p>
        <ul className="sent">
          <li>
            <strong>At the start:</strong> host name, macOS version, core count, memory size, and
            the afk client version.
          </li>
          <li>
            <strong>Once a second:</strong> cpu percent, load averages, the memory pressure level,
            and memory numbers (free, active, inactive, wired, compressed, swap used and total).
          </li>
          <li>
            <strong>Every five seconds:</strong> the {PROCESSES_TOP_MAX} busiest processes, each as
            pid, parent pid, cpu and memory percent, resident size, and the executable&apos;s full
            path (never its arguments), plus how many processes there were.
          </li>
          <li>
            <strong>Every five seconds:</strong> how many Claude Code and Codex sessions are
            running, working, waiting on you, or idle, and how many subagents are working. Counts
            only: no session names, directories, or transcript contents.{" "}
            <code>AFK_NO_AGENTS=1</code> turns this off.
          </li>
          <li>
            <strong>
              For <code>afk run</code>:
            </strong>{" "}
            the command line as typed, with a URL&apos;s user:password, the value of a{" "}
            <code>KEY=value</code> argument named like a secret, and the value after{" "}
            <code>--password</code>, <code>--token</code> and the like replaced by <code>***</code>{" "}
            before it is sent; then its pid, elapsed time, cpu and memory, how many bytes it wrote
            to stdout and stderr, and its exit code.
          </li>
          <li>
            <strong>When a wrapped command fails:</strong> the last {RUN_TAIL_MAX_LINES} lines of
            its stdout and stderr ({RUN_TAIL_MAX_LINE_CHARS} characters each), so the dashboard can
            say why. A command that exits 0 sends no output. <code>AFK_RUN_TAIL_LINES=0</code> sends
            none at all.
          </li>
        </ul>
        <h2>Where it goes</h2>
        <ul className="sent">
          <li>
            To the server this page came from. <code>{HOSTED_HOST}</code> is one person&apos;s
            server in AWS {HOSTED_REGION}, run best effort with no SLA; a self-hosted server is
            whoever runs it, and <code>AFK_SERVER</code> points the client at one.
          </li>
          <li>
            Kept for {RETENTION_DAYS} days after the session ends (<code>AFK_RETENTION_DAYS</code>{" "}
            on your own server), then deleted.
          </li>
          <li>
            Readable by anyone holding the link. There are no accounts: the session id is the
            secret, and the client&apos;s write token is never in the URL.
          </li>
          <li>
            Deletable by anyone holding the link, at once and with everything it recorded: the
            Delete control on the session page, or <code>afk delete</code> on the machine.
          </li>
          <li>
            Questions and takedowns:{" "}
            <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer">
              open an issue
            </a>
            .
          </li>
        </ul>
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
