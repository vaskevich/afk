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
- [ ] CLI: processes collector (pid, parentPid, %cpu, rss, full path) via `ps`
- [ ] CLI: agents collector (running claude / codex process counts)
- [x] Server rules for runs: exited non-zero, no output for N seconds -- `rules/run.ts` (`run.exited`, `run.stalled`)

## Storage & retention

Decision (Sep 2026): sessions go through the `SessionStorage` interface in
`packages/server/src/store/storage.ts`. Local disk for dev and self-hosting, Lightsail
object storage (S3-compatible API) for the hosted deployment.

- [x] `SessionStorage` interface + disk implementation (`sessions/<id>/session.json` + `frames.ndjson`)
- [x] S3-compatible implementation (one object per frame batch under `sessions/<id>/frames/`); select with `AFK_STORAGE=disk|s3`; works against Lightsail buckets, real S3, MinIO -- `packages/server/src/store/s3-storage.ts` + `create-storage.ts`
- [ ] Expiry: sweeper that deletes sessions 7 days after they end (Lightsail buckets have no lifecycle rules, so the server owns this for every backend)
- [x] Evict idle ended sessions from the in-memory cache -- `SessionStore.tick()` evicts ended sessions with no listeners after `EVICT_ENDED_AFTER_MS` (10 min); `stats().framesInMemory` is still a frame count, not an actual measurement of memory held, see the hardening item below
- [ ] Persist only what the dashboard needs (truncate process lists, drop unused fields)
- [ ] Downsample or window frames for the browser if sessions ever exceed a few MB compressed
- [ ] Actually measure memory held in the session cache (bytes, not `framesInMemory`'s frame count) so admission control and `GET /api/stats` reflect what they are meant to bound

## Sessions

- [ ] Auto-chain a new session when the 1 hour cap is hit, print the new URL -- `system_sampler_loop` in `cli/afk` just stops and logs "reached the maximum session length"; the `TODO(sessions)` next to it is still open
- [ ] Mark a session ended after the client goes silent for N minutes -- the server has `client.stale` as an anomaly event but does not end the session on it
- [ ] Multiple processes joining one session: only the first runs the long-lived collectors -- `afk run` already distinguishes owner vs joiner (see ARCHITECTURE.md), but no second `afk start` guard exists yet
- [ ] Per-collector sampling intervals (not everything needs 1 Hz)
- [ ] Sampling drift: subtract collector runtime from the sleep

## Hardening (server)

- [x] Global cap on active sessions and per-session frame/stream rate limit (admission control) -- `AdmissionLimits` in `env.ts` (20 sessions x 10 streams by default), 503 + `Retry-After` on create at capacity, 422 on a batch that would exceed the stream cap; see ARCHITECTURE.md
- [ ] Minimum client version check using the `X-Afk-Client` header -- the header is sent and logged but not enforced
- [ ] Security headers (Hono `secureHeaders`)
- [ ] Request body size limit on ingest -- `TODO(hardening)` in `routes/frames.ts`
- [ ] Rate limit session creation per client address; optional shared secret for private/self-hosted servers -- `TODO(hardening)` in `routes/sessions.ts`
- [ ] Decide what to do with batches the server rejects (currently parked in `rejected/`)

## Hardening (client)

- [ ] Spool rotate race: no `flock` on macOS; currently a 100 ms pause after rename
- [ ] Verify behavior across sleep/wake and wifi loss end-to-end (design says it retries; test it)
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
