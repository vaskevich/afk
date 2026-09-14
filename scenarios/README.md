# Scenarios

Small, reproducible workloads for exercising afk. Each one is a single executable
file (Node 20+, ES modules, no dependencies, no `pnpm install`, no build) that runs with sensible
defaults and documents its flags under `--help`. Start the client first, then launch
a scenario and watch the dashboard react.

```bash
AFK_SERVER=http://localhost:4141 ./cli/afk start   # in one terminal
scenarios/cpu-burn                                 # in another
```

Wrap them with `afk run -- <cmd>` so stdout/stderr volume and the exit code are
reported alongside machine health. This is the primary way to use `migration-hang`:
it is the wrapper scenario, producing `run.stalled` when it goes quiet and a critical
`run.exited` with `--crash`, while `cpu-burn` produces `cpu.high` and an info
`run.exited` on its clean exit.

```bash
afk run -- scenarios/cpu-burn
afk run -- scenarios/migration-hang
```

## cpu-burn

Pins every core for a configurable duration, then exits 0.

Expected signal: cpu climbs to ~100% x cores (one worker thread per core, sha256 in
a tight loop) within a second or two, holds there for 2 minutes, then drops back to
baseline when the process exits cleanly. Load average rises accordingly. The process
prints a progress line every 5 seconds, so under `afk run` stdout should show a small
steady trickle and a zero exit. This is the "sustained high cpu" anomaly, and also a
useful check that a clean exit clears it.

```bash
scenarios/cpu-burn                 # all cores, 120 s
scenarios/cpu-burn -d 30 -w 2      # two cores, 30 s
CPU_BURN_DURATION=600 scenarios/cpu-burn
```

Flags: `--duration/-d` seconds (120), `--workers/-w` threads (cores),
`--interval/-i` seconds between progress lines (5). Env: `CPU_BURN_DURATION`,
`CPU_BURN_WORKERS`, `CPU_BURN_INTERVAL`. Ctrl-C stops the workers and exits 130.

## migration-hang

A fake migration job: prints `processing N/10000 items` at ~20 lines/s, then after
item 300 (about 15 s in) it stops printing and hangs forever, alive but idle.

Expected signal: steady stdout that stops abruptly while the process is still
running and using no cpu. Machine health stays boring; the only tell is the output
rate going to zero without an exit. This is the "command stopped producing output"
anomaly. Ctrl-C (or SIGTERM) kills it like any other hung job.

Variants:

```bash
scenarios/migration-hang                      # hang after item 300
scenarios/migration-hang --hang-after 30      # hang 30 s in, whichever trigger fires first
scenarios/migration-hang --crash 3            # exit 3 (with a stderr line) instead of hanging
scenarios/migration-hang --never --total 500  # healthy control: finishes all items, exit 0
scenarios/migration-hang --rate 5 --hang-at 50
```

`--crash` produces the other run-level anomaly: a non-zero exit. `--never` is the
control case that should raise nothing.

Flags: `--total/-t` items (10000), `--rate/-r` lines per second (20),
`--hang-at/-a` item (300; 0 disables), `--hang-after/-s` seconds (off),
`--crash/-c [code]` (1), `--never/-n`. Env: `MIGRATION_TOTAL`, `MIGRATION_RATE`,
`MIGRATION_HANG_AT`, `MIGRATION_HANG_AFTER`, `MIGRATION_CRASH=<code>`.

## Adding one

Keep each scenario to one executable file with a shebang, no dependencies, defaults
that need no arguments, a `--help`, and a short note here on the signal it is meant
to produce. Aim for one anomaly per scenario so a dashboard reading is unambiguous.
