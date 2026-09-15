# Client implementation tradeoffs

A running list. The client is the part of afk people download onto machines we do not
control, so the language choice is mostly a distribution question, then a
maintainability one. Add to this whenever a new fact or constraint turns up.

## What the client must do

- Sample the machine once a second (cpu, memory pressure, processes) with stock tools.
- Count the coding agents on the machine without saying who they are. `collect_agents`
  reads Claude Code's per-session records (`~/.claude/sessions/<pid>.json`: the pid is
  checked with `kill -0`, and only `status`, `cwd`, and `sessionId` are looked at, the
  last two just to find the transcript) and the mtimes of the session's transcript and
  its subagents' transcripts under `~/.claude/projects/`; it never opens a Claude Code
  transcript, never opens the `.key` files beside the records, and never runs
  anything of Claude Code's. For Codex it asks `lsof` which files under
  `~/.codex/thread-writer-locks/` a process named `codex` holds open (a lock file on
  its own outlives a crash, and the ChatGPT app keeps a `codex app-server` running
  whether or not a thread is open, so only the two together mean a live thread), and
  in each live thread's rollout under `~/.codex/sessions/` it looks for three literal
  event tags (`task_started`, `task_complete`, `turn_aborted`) to tell a turn in
  progress from one that is over, and at the file's mtime; nothing else in the
  rollout is read, and each is read whole once per session and then only what was
  appended (the byte count it got to is kept per thread under the session directory
  and goes with it). What goes on the wire is `available` plus five counts per tool
  found (sessions, working, waiting on input, idle, working subagents); no name, id,
  directory, or timestamp of any session or thread leaves the machine, which is a
  decision, not an omission (see the decision log in
  [ARCHITECTURE.md](ARCHITECTURE.md)). Codex's waiting-on-input reading is weaker
  than Claude Code's: it is a turn in progress whose rollout has been quiet for 120 s,
  since Codex writes no approval or question event. A machine with neither
  `~/.claude/sessions` nor `~/.codex/thread-writer-locks` sends one `available: false`
  frame per session and nothing more on that stream.
- Spool to disk, retry forever with backoff, never lose or duplicate a frame. Without
  `flock` on macOS the only safe handoff between a sampler and a sender is one file
  per frame and an atomic rename; a shared append-only file races.
- Bound its own disk use during an outage (the queue is capped, oldest frames go).
- Keep the sampling rate honest without a sub-second clock: schedule ticks against
  deadlines rather than sleeping a fixed interval after the collectors, and stamp
  each frame with the second its tick was scheduled for, so consecutive samples of
  a stream are exactly one interval apart.
- Know whether the process that owns the session is alive without a network round
  trip (a pid file), leave no state behind on any exit path, and sweep old state on
  startup.
- Wrap a foreground command, pass signals and stdin through, count its output, report
  its exit code.
- Print readable errors for capacity, version, and network problems, including curl's
  own reason when the server cannot be reached.
- Keep its own lines apart from a wrapped command's. `afk run` passes the command's
  stdout and stderr through on their own descriptors, unchanged and unbuffered (`tee`
  mirrors each into the run capture; the tests check that both streams arrive in order
  on the right descriptor and that the exit code is the command's). Everything afk says
  for itself goes to stderr through `log`: on a terminal with a bold yellow `afk ▸`
  tag, otherwise (a pipe, a log file, or `NO_COLOR` set, per <https://no-color.org>)
  with the plain `afk: ` prefix a script can grep for. The dashboard URL is the one
  thing on stdout, bare, because it is meant to be captured.
- Be something a stranger can inspect before running.
- Notice when the server it talks to serves a newer copy of itself (the create
  response says so), tell the user, and on a terminal offer to run the server's
  installer, without ever holding up a start nobody is watching or a wrapped command;
  `afk update` does the same on demand and `afk version --check` just asks. See
  "The latest client" in [VERSIONING.md](VERSIONING.md).
- Stop cleanly when the session is deleted under it, and let the user delete one.
  A `404` on ingest or end means the server no longer has the session (it never
  forgets a live one for any other reason; see "Delete" in [PROTOCOL.md](PROTOCOL.md)):
  the sender leaves a `deleted` marker next to `stop`, drops the queue, and prints
  `afk: session <id> was deleted on the server; telemetry stopped` once; the sampler
  loops stop on the marker; nothing chains, which is what sets it apart from the `410`
  that means "over, continue in a successor". `afk start` then exits 0. `afk run`
  keeps its command running with stdout and stderr flowing exactly as before and still
  exits with the command's status; only the telemetry stops, no final frame, flush, or
  end is sent, and a joiner whose owner's session was deleted stops the same way
  inside its own run directory. `afk delete [session-id]` deletes the session running
  on this machine, or the one named, sending the ingest token when this machine still
  has it (`~/.afk/current` or the session's own `session.json`) and nothing otherwise,
  since holding the id is enough; a running `afk start` or `afk run` on that session
  notices on its next send. The server refuses to delete the demo session by name, and
  `afk delete demo` reports that refusal as it does any other (`<server> refused to
delete session demo (HTTP 403): the demo session cannot be deleted`).
- Today: macOS only. Wanted: Linux.

## Concurrent runs

Several `afk run`s on one machine share one session (the one `afk start` owns, or the
one the first `afk run` created) and are each their own `run:<runId>` stream in it.
Checked end to end by the contract test (five runs joined to an `afk start`, an
owning run outlived by its joiners, two runs racing for the last slot under the cap,
two runs started in the same instant with no session), and what holds them apart:

- **Queues are per process, never shared.** The owner spools under
  `sessions/<id>/queue/` and each joined run under `sessions/<id>/runs/<runId>/queue/`,
  each with a sender of its own, so no two senders ever list, send, or delete the
  same files: a batch is the oldest files of one process's queue, and only that
  process deletes them, on a 2xx. (Two senders on one directory would race between
  listing and `cat`, and between a failed send and the other's deletion.) What is
  shared is the session on the server, whose ingest admits one batch at a time per
  session, so session-wide indexes stay distinct however many senders are in flight
  (see admission control in [ARCHITECTURE.md](ARCHITECTURE.md)).
- **Two `afk run`s started in the same instant, no session running.** Both find no
  `current`. `owner.pid` is claimed atomically (noclobber) before the create request
  (`claim_session_ownership`), so exactly one creates the session; the other waits
  for its `current` (at most 15 s, one create request's worth; less if the winner's
  create fails) and joins it. A second `afk start` in that window is refused, naming
  the pid.
- **The stream cap.** `maxStreamsPerSession` is 10 and the owner takes three
  (`system`, `processes`, `agents`), so a session has room for seven runs. A joiner
  checks `streamCount` against `maxStreams` before joining and runs without telemetry
  when the session is already full. Several runs started in the same second all pass
  that check and fill the session between it and their first batch; the ones past the
  cap learn from a 422 on that batch, which the server keeps nothing of since every
  frame in it was theirs (see "Ingest" in [PROTOCOL.md](PROTOCOL.md)). The sender
  then leaves a `no-room` marker next to `stop`, drops the run's queue, and prints
  once `session <id> has no room for another run (the server allows 10 streams per
session); running without telemetry`; the run sampler stops on the marker and the
  main process skips the final frame, the flush, and the end. The command runs on
  exactly as it would have, and the owner's streams and the other runs are untouched,
  since the joiner's queue and markers are its own. An owner's batch mixes streams
  and the server keeps the known ones, naming the others in `rejectedStreams`; only a
  cap below the owner's own three could turn an owner's batch away whole, and that
  batch is parked in `rejected/` like any permanent rejection.
- **Ownership when the owner's command finishes first.** `afk start` ends its session
  on Ctrl-C whatever is joined to it: that is a decision. An `afk run` that owns its
  session (no `afk start` was running) has no such moment: its command exiting is not
  a decision to end the session, and ending it would leave the runs joined to it
  sending into 410 for the rest of their lives, their final frames lost. So the owner
  sends its own final frame at once and then keeps the session open, samplers and
  sender running, until the last joined run's afk process is gone
  (`runs/<runId>/afk.pid`, not the command's pid: a run still flushes after its
  command has exited). One line says `N joined afk run(s) still going; keeping
session <id> open until they finish (Ctrl-C or 'afk stop' ends it now)`, the exit
  status stays the command's, and Ctrl-C or `afk stop` ends the session at once as
  usual. This holds the terminal (a pipeline or `&&` chain waits with it), which is
  the honest trade: the alternative, a caretaker left running in the background,
  would hold open the pipe the command's stdout went to and print into a terminal
  that has moved on. Reopen if the wait turns out to bite in scripts.

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
  What the whole-second schedule does need is that frames be stamped by it, not by
  the clock after the collectors: the collectors take a good part of a second
  between them (`ps` for the processes list is most of it), so a tick that runs
  past its second is followed by its catch-up tick inside the next one, and read
  off the wall clock after the collectors the two frames shared a timestamp while
  the second in between had none, which the dashboard drew as a slit. Each frame
  now carries the deadline its tick was due at (`sample_once` is handed it by
  `system_sampler_loop`), so system frames are consecutive seconds and processes
  frames exact multiples of their interval; a deadline more than
  `SAMPLE_MAX_CATCHUP_SECONDS` behind is re-based to now, so a stamp is never
  further than that from when the sample was taken, and since the deadline only
  moves forward, timestamps are strictly increasing within a stream. Run frames,
  which are not on that schedule, keep the wall clock.
- **Not doing: re-exec into the new copy after an in-session update.** When `afk start`
  installs an update at its prompt, the process carries on running the code it loaded
  and the new copy is used from the next `afk start`. Re-executing would mean handing
  a live session (its id, token, spool, sender, and the sampler's chain timer) to a
  script whose state layout may have changed, exactly the kind of transition the
  version bump exists to warn about; the prompt happens once, right after the session
  is created, so the cost of waiting is one session on the old code, and the user is
  told so on the same line. Reopen if updates start carrying fixes a running session
  cannot wait for, which so far would be a 426 from the server, not a notice.
- **Not doing: the update question in `afk run`.** An `afk run` that starts its own
  session prints the notice only. Its command is about to get stdin, and a question
  that waits ten seconds (or eats the first line the user meant for the command)
  would make telemetry get in the way of the command, which `afk run` promises not
  to do. `afk update` is one command away.
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
