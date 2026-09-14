import { Link } from "@tanstack/react-router";

export function LandingPage() {
  return (
    <main className="page landing">
      <h1 className="wordmark">afk</h1>
      <p>
        Away-from-keyboard telemetry. Run <code>afk start</code> on a machine you are about to walk
        away from and get a shareable dashboard URL that shows whether everything is still fine:
        cpu, load, memory pressure, swap, and (soon) the commands you left running. Take a look at{" "}
        <Link to="/s/$sessionId" params={{ sessionId: "demo" }}>
          a demo session
        </Link>
        .
      </p>
    </main>
  );
}
