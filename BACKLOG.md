# afk backlog

Working list of things deliberately deferred to get to an MVP. Roughly ordered by
priority within each section. Migrate to a proper tracker if it outgrows a file.

## Next up (MVP path)

- [x] Server: persist frames to disk (append-only NDJSON per session) instead of memory
- [x] Server: history endpoint + SSE stream with `Last-Event-ID` catch-up
- [x] Web: Vite + React + TanStack scaffold, dark theme, live status page
- [x] Web: timeline with one row per stream, scrubber; follows active sessions live
- [ ] Web: event markers on the timeline once the server emits anomaly events
- [ ] Server: anomaly rules (cpu sustained high, memory pressure warn/critical, client stale)
- [ ] CLI: `afk run -- <cmd>` joins the current session; reports stdout/stderr bytes per tick + exit code
- [ ] CLI: processes collector (pid, parentPid, %cpu, rss, full path) via `ps`
- [ ] CLI: agents collector (running claude / codex process counts)
- [ ] Server rules for runs: exited non-zero, no output for N seconds

## Storage & retention

Decision (Sep 2026): sessions go through the `SessionStorage` interface in
`packages/server/src/store/storage.ts`. Local disk for dev and self-hosting, Lightsail
object storage (S3-compatible API) for the hosted deployment.

- [x] `SessionStorage` interface + disk implementation (`sessions/<id>/session.json` + `frames.ndjson`)
- [x] S3-compatible implementation (one object per frame batch under `sessions/<id>/frames/`); select with `AFK_STORAGE=disk|s3`; works against Lightsail buckets, real S3, MinIO -- `packages/server/src/store/s3-storage.ts` + `create-storage.ts`
- [ ] Expiry: sweeper that deletes sessions 7 days after they end (Lightsail buckets have no lifecycle rules, so the server owns this for every backend)
- [ ] Evict idle ended sessions from the in-memory cache
- [ ] Persist only what the dashboard needs (truncate process lists, drop unused fields)
- [ ] Downsample or window frames for the browser if sessions ever exceed a few MB compressed

## Sessions

- [ ] Auto-chain a new session when the 1 hour cap is hit, print the new URL
- [ ] Mark a session ended after the client goes silent for N minutes
- [ ] Multiple processes joining one session: only the first runs the long-lived collectors
- [ ] Per-collector sampling intervals (not everything needs 1 Hz)
- [ ] Sampling drift: subtract collector runtime from the sleep

## Hardening (server)

- [ ] Minimum client version check using the `X-Afk-Client` header
- [ ] Security headers (Hono `secureHeaders`)
- [ ] Request body size limit on ingest
- [ ] Per-session frame rate limit and global cap on active sessions (admission control)
- [ ] Rate limit session creation; optional shared secret for private/self-hosted servers
- [ ] Decide what to do with batches the server rejects (currently parked in `rejected/`)

## Hardening (client)

- [ ] Spool rotate race: no `flock` on macOS; currently a 100 ms pause after rename
- [ ] Verify behavior across sleep/wake and wifi loss end-to-end (design says it retries; test it)
- [ ] Clock skew between client `timestamp` and server `receivedAt`
- [ ] Linux support for collectors (`/proc`)
- [ ] Plugin collectors: any executable that prints JSON

## Testing

- [ ] vitest for shared schemas and server routes
- [ ] bats tests for the bash client (json helpers, collector output validates against the schema)
- [ ] Contract test: run the real `afk` collector output through the Zod schema

## Deployment

Decision (Sep 2026): deploy as a Lightsail container service rather than an instance.
No persistent volume, so storage is the Lightsail bucket above; TLS and the public
endpoint come from Lightsail; deploys are push-image + new deployment.

- [x] Rework `infra/` for a container service: service + custom domain certificate + DNS validation records + `afk.osv.im` record in the osv.im zone + Lightsail bucket; drop the instance, key pair, static IP, and cloud-init bootstrap. Bucket access is env vars, not Lightsail "resource access" -- see the decision log entry below.
- [x] Dockerfile that builds the dashboard and runs the server -- still runs the server via `tsx` (see the next item), not compiled JS
- [ ] Compile `packages/server` to plain JS instead of running it through `tsx` in the container (the Dockerfile has a TODO for this; `tsx` was moved to `dependencies` in the meantime so it ships in the runtime image)
- [x] `deploy.sh` becomes build image, push to Lightsail, create deployment
- [ ] Confirm SSE passes through the container service load balancer (15 s keepalive is already in place)
- [ ] Actually run `tofu apply`
- [x] Serve the built dashboard from the Node server
- [ ] Installer one-liner that downloads `cli/afk`
