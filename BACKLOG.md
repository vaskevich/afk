# afk backlog

Working list of things deliberately deferred to get to an MVP. Roughly ordered by
priority within each section. Migrate to a proper tracker if it outgrows a file.

## Next up (MVP path)

- [x] Server: persist frames to disk (append-only NDJSON per session) instead of memory
- [x] Server: history endpoint + SSE stream with `Last-Event-ID` catch-up
- [x] Web: Vite + React + TanStack scaffold, dark theme, live status page
- [x] Web: timeline with one row per stream, scrubber; follows active sessions live
- [x] Web: event markers on the timeline once the server emits anomaly events -- `timeline/EventMarkers.tsx` + `clusters.ts`, `StatusBanner`, `NearbyEvents`
- [x] Server: anomaly rules (cpu sustained high, memory pressure warn/critical, client stale) -- `packages/server/src/rules/`
- [x] CLI: `afk run -- <cmd>` joins the current session; reports stdout/stderr bytes per tick + exit code
- [x] CLI: processes collector (pid, parentPid, %cpu, rss, full path) via `ps` -- `collect_processes`, every 5 s on the `processes` stream; `cpu.high` names the top three in `details.topProcesses`. The agents collector is still open, see the wishlist below
- [x] Server rules for runs: exited non-zero, no output for N seconds -- `rules/run.ts` (`run.exited`, `run.stalled`)

## Wishlist: agents collector (claude / codex)

Parked on 2026-09-15. Investigated and cheap to build (about the size of the
processes collector), but it depends on undocumented tool internals and ships session
names off the machine, so it waits for a deliberate decision.

- What is observable today: Claude Code writes `~/.claude/sessions/<pid>.json` per
  running session (`name`, `cwd`, `kind`, `status`, `version`, `startedAt`, `updatedAt`);
  subagent transcripts live under `~/.claude/projects/<project>/<session>/subagents/`
  and a file modified in the last minute is a working subagent; Codex has `codex` /
  `codex app-server` processes and rollouts under `~/.codex/sessions/YYYY/MM/DD/`.
- Shape: a generic `agents` collector, one entry per agent (tool, pid, name, cwd,
  status, kind, lastActivityAt) plus per-tool working-subagent counts, sampled every 5 s.
- The payoff rule: an agent whose transcript has not changed for 10 minutes while its
  process is alive is almost certainly waiting on a person (permission prompt or
  question). Lean on transcript inactivity, not the `status` string, until its
  vocabulary is confirmed across working, idle, and waiting sessions.
- Privacy: send only the directory basename, make the collector opt-in for hosted
  servers (default on for self-hosted).
- Degrade gracefully when the directories are missing or the file shape changes.
- JSON-heavy in bash; a good first collector for a Python client if that port happens
  (see docs/CLIENT.md).

## Storage & retention

Decision (Sep 2026): sessions go through the `SessionStorage` interface in
`packages/server/src/store/storage.ts`. Local disk for dev and self-hosting, Lightsail
object storage (S3-compatible API) for the hosted deployment.

- [x] `SessionStorage` interface + disk implementation (`sessions/<id>/session.json` + `frames.ndjson`)
- [x] S3-compatible implementation (one object per frame batch under `sessions/<id>/frames/`); select with `AFK_STORAGE=disk|s3`; works against Lightsail buckets, real S3, MinIO -- `packages/server/src/store/s3-storage.ts` + `create-storage.ts`
- [x] Expiry: sweeper that deletes sessions 7 days after they end (Lightsail buckets have no lifecycle rules, so the server owns this for every backend) -- `packages/server/src/store/sweeper.ts`, `AFK_RETENTION_DAYS` / `AFK_SWEEP_INTERVAL_SECONDS`; a session that never received an end counts as ended at its cap
- [x] Evict idle ended sessions from the in-memory cache -- `SessionStore.tick()` evicts ended sessions with no listeners after `EVICT_ENDED_AFTER_MS` (10 min); `stats().framesInMemory` is still a frame count, not an actual measurement of memory held, see the hardening item below
- [ ] Persist only what the dashboard needs (truncate process lists, drop unused fields)
- [ ] Downsample or window frames for the browser if sessions ever exceed a few MB compressed
- [ ] Actually measure memory held in the session cache (bytes, not `framesInMemory`'s frame count) so admission control and `GET /api/stats` reflect what they are meant to bound

## Sessions

- [ ] Auto-chain a new session when the 1 hour cap is hit, print the new URL -- `system_sampler_loop` in `cli/afk` just stops and logs "reached the maximum session length"; the `TODO(sessions)` next to it is still open
- [ ] Mark a session ended after the client goes silent for N minutes -- the server has `client.stale` as an anomaly event but does not end the session on it
- [ ] Multiple processes joining one session: only the first runs the long-lived collectors -- `afk run` already distinguishes owner vs joiner (see ARCHITECTURE.md), but no second `afk start` guard exists yet
- [x] Per-collector sampling intervals (not everything needs 1 Hz) -- `sample_once` counts ticks and `due_every` runs a collector every N seconds (`processes` at 5 s)
- [ ] Sampling drift: subtract collector runtime from the sleep
- [ ] Per-collector sampling intervals (not everything needs 1 Hz)
- [x] Sampling drift: subtract collector runtime from the sleep -- `system_sampler_loop` schedules ticks against a deadline; average rate is 1 Hz, single gaps still vary because stock macOS has no sub-second clock (see the hardening item below)

## Hardening (server)

- [x] Global cap on active sessions and per-session frame/stream rate limit (admission control) -- `AdmissionLimits` in `env.ts` (20 sessions x 10 streams by default), 503 + `Retry-After` on create at capacity, 422 on a batch that would exceed the stream cap; see ARCHITECTURE.md
- [x] Configuration: every server tunable (port, storage, limits, session cap, retention, tick/eviction/keepalive intervals) as an `AFK_*` variable parsed and validated once in `packages/server/src/config.ts`, documented in [docs/CONFIGURATION.md](docs/CONFIGURATION.md); a bad value stops startup naming the variable
- [ ] Minimum client version check using the `X-Afk-Client` header -- the header is sent and logged but not enforced
- [ ] Security headers (Hono `secureHeaders`)
- [ ] Request body size limit on ingest -- `TODO(hardening)` in `routes/frames.ts`
- [x] Minimum client version check using the `X-Afk-Client` header -- `middleware/client-version.ts`, 426 with `UpgradeRequiredDetails` on create/frames/end; floors from shared `MIN_CLIENT_VERSION` / `MIN_PROTOCOL_VERSION`, raised per deployment with `AFK_MIN_CLIENT_VERSION` / `AFK_MIN_PROTOCOL_VERSION`; policy in [docs/VERSIONING.md](docs/VERSIONING.md)
- [x] Security headers (Hono `secureHeaders`) -- `middleware/security-headers.ts`, strict CSP verified against the built dashboard in the browser
- [x] Request body size limit on ingest -- `middleware/body-limit.ts`, 1 MiB on ingest and 4 KiB on create, 413 with an `ErrorResponse`
- [ ] Protocol version translation layer (`utils/protocol-v<N>.ts`) -- not needed until `PROTOCOL_VERSION` moves past `MIN_PROTOCOL_VERSION`; the checklist in [docs/VERSIONING.md](docs/VERSIONING.md) says where it goes
- [ ] Rate limit session creation per client address; optional shared secret for private/self-hosted servers -- `TODO(hardening)` in `routes/sessions.ts`
- [ ] Decide what to do with batches the server rejects (currently parked in `rejected/`)

## Hardening (client)

- [x] Spool rotate race: no `flock` on macOS; currently a 100 ms pause after rename -- gone: `emit_frame` writes one file per frame through a temp file and an atomic rename into `queue/<sequence>-<stream>.ndjson`; there is no shared spool file any more
- [x] Cap the on-disk queue so an offline night cannot fill the disk -- `SPOOL_MAX_BYTES` (50 MiB, `AFK_SPOOL_MAX_BYTES`), oldest frames dropped, logged at most once a minute
- [x] Crashed owner leaves `~/.afk/current` behind and makes the next `afk run` wait on the network -- `owner.pid` next to it; a dead owner marks the file stale locally; an EXIT trap removes both on every owner exit path
- [x] `afk status` and `afk stop`; sweep old session directories on `afk start` (a day after the `done` marker, two days without one)
- [x] curl: `--fail-with-body` when supported, `--retry 0` so curl's retries never double up with the sender's; a second Ctrl-C during the final flush exits at once
- [x] shellcheck clean, `pnpm lint:sh`, and a shellcheck step in CI
- [ ] `afk stop` can take up to one request timeout (about 25 s) to take effect while the owner is mid-request, because bash runs a trap only after the command in flight returns; Ctrl-C in the owner's terminal is immediate since curl gets the signal too
- [ ] Frames dropped by the spool cap vanish silently from the dashboard; the server only shows the gap through `client.stale` when it is long enough
- [ ] Unsent frames of a session that ended offline are deleted with its directory a day later; nothing resends them on the next `afk start` (the server would still accept them until the session expires)
- [ ] Sub-second tick scheduling: single gaps still vary by collector runtime (only the average is 1 Hz) because stock macOS `date` has no `%N`; `perl -MTime::HiRes` is on every Mac but is one more dependency
- [ ] `afk status` counts only the owner's queue, not the queues of `afk run` joiners under `runs/<runId>/`
- [ ] Verify behavior across sleep/wake and wifi loss end-to-end (design says it retries; test it) -- the sampler re-bases its schedule after a clock jump rather than bursting, but that is unit-tested with a fake clock only
- [ ] Clock skew between client `timestamp` and server `receivedAt`
- [ ] Linux support for collectors (`/proc`)
- [ ] Plugin collectors: any executable that prints JSON

## Testing

- [x] vitest for shared schemas and server routes -- one config at the repo root, co-located tests; see [docs/TESTING.md](docs/TESTING.md)
- [x] bats tests for the bash client (json helpers, collector output validates against the schema) -- done via Vitest instead of bats: `cli/afk` is sourced with `AFK_SOURCED=1` and its functions called directly, per docs/TESTING.md
- [x] Contract test: run the real `afk` collector output through the Zod schema -- `cli/contract.test.ts` runs the real `cli/afk` against the real server over HTTP (`pnpm test:contract`, macOS only) and validates everything it sends with the shared schemas; see docs/TESTING.md
- [ ] Fix the doc comment in `packages/web/src/data/fixtureSource.ts` (top of file and the `STALE_START`/`STALE_END` comment): it promises "a 90 s stretch with no frames at all", but the measured gap between the last frame before the stretch and the first after it is 91 s, since `STALE_END` itself is excluded from the stretch but still marks the far edge of the gap between samples. `fixtureSource.test.ts`'s "has a gap in frame timestamps for the documented stale stretch" test already documents and asserts the 91 s reality -- only the doc comment is stale.

## Dashboard

- [ ] `timeline/collectors/system.tsx`'s `drawRow` draws the cpu line as one continuous
      path across every frame it is given, including across a gap where the client was
      stale (no frames for a stretch, see the `client.stale` rule and the demo
      fixture's stale stretch) -- it should break the line across a gap instead of
      joining it, so a silent stretch reads as missing data rather than a smooth
      interpolation.
- [ ] Richer `run` output flavors beyond `"volume"`, e.g. parsing progress lines (a
      percentage or a `current/total` pattern) or counting structured JSON records, so
      the run row can show progress instead of only byte volume. See "Adding an output
      flavor for `run`" in [docs/EXTENDING.md](docs/EXTENDING.md).

## Deployment

Decision (Sep 2026): deploy as a Lightsail container service rather than an instance.
No persistent volume, so storage is the Lightsail bucket above; TLS and the public
endpoint come from Lightsail; deploys are push-image + new deployment.

- [x] Rework `infra/` for a container service: service + custom domain certificate + DNS validation records + `afk.osv.im` record in the osv.im zone + Lightsail bucket; drop the instance, key pair, static IP, and cloud-init bootstrap. Bucket access is env vars, not Lightsail "resource access" -- see the decision log entry below.
- [x] Dockerfile that builds the dashboard and runs the server -- still runs the server via `tsx` (see the next item), not compiled JS
- [ ] Compile `packages/server` to plain JS instead of running it through `tsx` in the container (the Dockerfile has a TODO for this; `tsx` was moved to `dependencies` in the meantime so it ships in the runtime image)
- [x] `deploy.sh` becomes build image, push to Lightsail, create deployment; refactored to take bucket config from the environment (falling back to `tofu output`) and the image tag from an argument/env, so both a laptop and CI run the exact same script
- [x] CI: `.github/workflows/ci.yml` (typecheck/lint/format/test/build + `tofu fmt`/`validate` for `infra/`) on every PR and push to main
- [x] CD: `.github/workflows/deploy.yml` (build, push, deploy via `deploy.sh`) on push to main (gated on CI) or manual dispatch, authenticated to AWS via GitHub OIDC (`infra/ci.tf`'s `afk-github-deploy` role) -- no long-lived AWS keys in GitHub
- [ ] Confirm SSE passes through the container service load balancer (15 s keepalive is already in place)
- [ ] Actually run `tofu apply` -- including `ci.tf`'s OIDC provider/role, and then set the GitHub repository secrets/variables and `production` environment `infra/README.md`'s "CI and deploys" section describes, before `deploy.yml` can actually deploy anything
- [x] Serve the built dashboard from the Node server
- [ ] Installer one-liner that downloads `cli/afk`
