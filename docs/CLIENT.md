# Client implementation tradeoffs

A running list. The client is the part of afk people download onto machines we do not
control, so the language choice is mostly a distribution question, then a
maintainability one. Add to this whenever a new fact or constraint turns up.

## What the client must do

- Sample the machine once a second (cpu, memory pressure, processes) with stock tools.
- Spool to disk, retry forever with backoff, never lose or duplicate a frame. Without
  `flock` on macOS the only safe handoff between a sampler and a sender is one file
  per frame and an atomic rename; a shared append-only file races.
- Bound its own disk use during an outage (the queue is capped, oldest frames go).
- Keep the sampling rate honest without a sub-second clock: schedule ticks against
  deadlines rather than sleeping a fixed interval after the collectors.
- Know whether the process that owns the session is alive without a network round
  trip (a pid file), leave no state behind on any exit path, and sweep old state on
  startup.
- Wrap a foreground command, pass signals and stdin through, count its output, report
  its exit code.
- Print readable errors for capacity, version, and network problems, including curl's
  own reason when the server cannot be reached.
- Be something a stranger can inspect before running.
- Today: macOS only. Wanted: Linux.

## Current decision

Bash 3.2, single file, curl only. Chosen for the download-and-read story and zero
install. Revisit when any of these happens: a Linux port starts, a second person
contributes collectors, the script passes roughly a thousand lines, or a bug traces
back to shell quoting or subshell state.

## Decisions

Things the client deliberately does not do, with the reason, so they are not
re-proposed as hardening items. Reopen one when its reason stops holding.

- **Not doing: sub-second tick scheduling through `perl -MTime::HiRes`.** Stock macOS
  `date` has no `%N`, so the sampler schedules ticks against whole-second deadlines:
  the average rate is exactly 1 Hz, and only the gap between two particular frames
  varies by the collectors' runtime (tens of milliseconds). `perl` is on every Mac
  today, but it would be the first dependency beyond bash and curl, it is the kind of
  tool Apple has removed before (Python), and nothing downstream needs the precision:
  every server rule works on frame timestamps in whole seconds and the dashboard
  draws at that resolution. A client that needs a real clock is the Python or Go
  client of the table above, not this one with one more tool bolted on.
- **Not doing: clock skew handling on the client.** The client stamps frames with its
  own wall clock and the server records `receivedAt`; a laptop clock minutes off puts
  frames visibly early or late on the timeline. Correcting that client-side would
  mean estimating the offset from the server's `Date` header or a round trip, and
  then rewriting timestamps the client has already spooled, all to guess at a clock
  the server already sees the truth of. The server has both clocks for every frame it
  stores, so any correction (and the live `client.stale` comparison, which is the one
  place skew causes real trouble, see the SRE review in BACKLOG.md) belongs there, in
  keeping with "dumb client, smart server". The client stays honest: it reports its
  clock as it is.

## Options

|                                         | bash                                       | Python                                                                         | TypeScript (Node)                              | Go binary                               |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------- |
| Present on a fresh Mac                  | yes, 3.2                                   | no: `python3` is a stub until Xcode Command Line Tools are installed; then 3.9 | no                                             | n/a, self-contained                     |
| Present on a developer's Mac            | yes                                        | yes, if CLT or Homebrew (3.9 floor via CLT)                                    | almost always, version varies                  | n/a                                     |
| Present on Linux                        | yes, 4 or 5                                | nearly always, 3.8+                                                            | often                                          | n/a                                     |
| Inspectable before running              | best                                       | good, one file                                                                 | fair, a bundled `afk.mjs` is readable but long | source only                             |
| JSON, HTTP, subprocess, threads         | none built in: awk, curl, subshells, files | all in the standard library                                                    | all built in                                   | all built in                            |
| Shares the Zod contract                 | no, validated on ingest only               | no, validated on ingest only                                                   | yes, same types as the server                  | no                                      |
| Unit testing                            | coarse: spawn a shell per test             | pytest or unittest, fast                                                       | Vitest, fast, same runner as the repo          | go test, fast                           |
| Signal and stdin handling for `afk run` | subtle, workable                           | good                                                                           | good                                           | best                                    |
| Linux port cost                         | rewrite collectors, keep structure         | rewrite collectors, `/proc` is easy                                            | same                                           | same, cross-compile                     |
| Distribution                            | curl the file                              | curl the file                                                                  | curl the bundle or `npx`; needs Node 20+       | curl a binary per platform, or Homebrew |
| Install-time surprises                  | none                                       | CLT prompt on a bare Mac; 3.9 syntax floor                                     | "node: command not found"                      | see signing below                       |

## Distribution facts

- **macOS Gatekeeper and Go binaries.** Signing is only forced by the quarantine
  attribute, which browsers and Finder set on downloads and `curl` does not. A binary
  fetched with `curl` and run from a terminal works unsigned. Apple Silicon requires a
  signature but accepts an ad hoc one, and the Go linker ad hoc signs `darwin/arm64`
  binaries automatically. Homebrew bottles also run without notarization. What needs
  a paid Developer ID and notarization is the "download a zip from GitHub Releases in
  a browser and double-click it" path, and any distribution to non-technical users.
  So "Go needs signing" is true for browser downloads, false for `curl | sh` and brew.
- **Python on macOS.** Apple removed the bundled Python in 12.3. `python3` on a bare
  machine triggers the Command Line Tools install prompt. Every developer machine has
  CLT, which ships Python 3.9, so a Python client must stay on 3.9 syntax (no `match`,
  no `X | Y` type unions at runtime) unless it requires Homebrew Python.
- **Node.** Never preinstalled. Present on essentially every machine that runs the
  workloads afk is for (dev servers, coding agents), but not on a bare server or a
  colleague's laptop.
- **Bash.** Everywhere, but macOS is frozen at 3.2 for licensing reasons: no
  associative arrays, no `mapfile`, no `${var,,}`, no `$BASHPID`.
- **A bootstrapper decouples the two questions.** A ten-line shell installer that
  downloads the real client keeps the curl-able entry point whatever the client is
  written in.

## Assessment as of 2026-09-15

- Python is the strongest "no install, still readable" option: standard-library JSON,
  HTTP, subprocess, and threading remove most of what makes the bash client fragile,
  it is on every developer Mac and nearly every Linux box, and one file stays
  inspectable. The 3.9 floor is the main cost.
- TypeScript is the strongest engineering option (shared contract, best tests) and
  the weakest distribution option.
- Go is the best portability option and fine for curl and brew, at the cost of the
  inspect-before-run story and a release pipeline.
- Bash remains acceptable while the client stays small and macOS-only. The contract
  test (`pnpm test:contract`) is what makes any later port safe: it checks the wire
  behaviour, not the implementation.
