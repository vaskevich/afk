# afk backlog

Working list of things deliberately deferred to get to an MVP. Roughly ordered by
priority within each section. Migrate to a proper tracker if it outgrows a file.

## Next up (MVP path)

- [ ] Server: persist frames to disk (append-only NDJSON per session) instead of memory
- [ ] Server: history endpoint + SSE stream with `Last-Event-ID` catch-up
- [ ] Web: Vite + React + TanStack scaffold, dark theme, live status page
- [ ] Web: timeline with one row per stream, scrubber, event markers
- [ ] Server: anomaly rules (cpu sustained high, memory pressure warn/critical, client stale)
- [ ] CLI: `afk run -- <cmd>` joins the current session; reports stdout/stderr bytes per tick + exit code
- [ ] CLI: processes collector (pid, parentPid, %cpu, rss, full path) via `ps`
- [ ] CLI: agents collector (running claude / codex process counts)
- [ ] Server rules for runs: exited non-zero, no output for N seconds

## Storage & retention

- [ ] Store session files in S3 with a lifecycle expiration policy (7 days)
- [ ] Local sweeper for expired sessions until S3 lands
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

- [ ] Lightsail, cheapest instance; Caddy for TLS; Route53 `afk.osv.im` record via existing terraform
- [ ] Serve the built dashboard from the Node server
- [ ] Installer one-liner that downloads `cli/afk`
