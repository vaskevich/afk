# Architecture

afk records what a machine is doing while its owner is away and shows it on a
shareable dashboard. Three pieces, one shared contract.

```
  laptop                                   server (afk.osv.im or self-hosted)          phone / browser
  ┌──────────────────────────┐             ┌──────────────────────────────────┐        ┌──────────────┐
  │ cli/afk (bash)           │  NDJSON     │ packages/server (Node + Hono)    │  SSE   │ packages/web │
  │  sampler ─▶ spool ─▶ sender ──POST──▶  │  validate ─▶ store ─▶ storage    │ ─────▶ │ React        │
  │  collectors (system, …)  │             │  (memory cache)  (disk | bucket) │  JSON  │ timeline     │
  └──────────────────────────┘             └──────────────────────────────────┘        └──────────────┘
                                  packages/shared: Zod schemas = the wire contract
```

## Principles

- **Dumb client, smart server.** The client ships raw measurements. Every
  interpretation (what counts as high cpu, what memory pressure level means, which
  events to flag) lives on the server so it can improve without users downloading a
  new CLI. The dashboard does not interpret raw numbers either.
- **One contract.** `packages/shared` holds Zod schemas; TypeScript types are inferred
  from them so the server and dashboard cannot drift. The bash client is held to the
  same schemas by validation on ingest.
- **Resilient by construction.** The client spools to disk and retries forever; the
  server de-duplicates by sequence; the dashboard resumes from an index. Sleep, wifi
  loss, and server restarts all reduce to "retry".
- **Readable over clever.** Explicit field names, async/await, braces on every
  control statement, small commits. See [CLAUDE.md](../CLAUDE.md).

## Components

### Client (`cli/afk`)

A single bash 3.2 script (what macOS ships) with only curl and stock tools as
dependencies, so it can be downloaded, read, and run. Two loops:

- **Sampler**: runs each collector on its interval and appends one frame per line to
  `~/.afk/sessions/<id>/current.ndjson`.
- **Sender** (background subshell): atomically renames `current.ndjson` into
  `queue/`, ships the oldest queued batches in one request, deletes them on a 2xx,
  and backs off up to 30 s on anything else. Nothing sent is kept; nothing unsent is
  dropped. A 410 from the server ends the session; a 4xx moves the batch to
  `rejected/` so it cannot stall the queue.

Collectors are shell functions that print one JSON object. That is also the
intended plugin protocol: any executable that prints JSON can become a collector.
See [EXTENDING.md](EXTENDING.md).

`afk start` writes `~/.afk/current` so later processes (`afk run`, more collectors)
can join the same session. A session is machine-wide; the first process that created
it owns the long-running system collectors.

#### `afk run`

`afk run -- <cmd>` wraps one command and reports its progress as its own `run:<runId>`
stream. It reads `~/.afk/current`; whoever finds no session there becomes the
**owner** and creates one (with machine telemetry, for the lifetime of the command),
everyone else **joins** the session already running. A joiner keeps its own spool and
queue under `sessions/<id>/runs/<runId>/` so it never races the owner's sender for
`current.ndjson`.

The wrapped command runs in the foreground (not backgrounded) so Ctrl-C, stdin, and
exit status behave the way they would unwrapped; `tee` mirrors stdout/stderr to the
run's own files so the run collector can size them. A final frame with
`state: "exited"` and the exit code closes the row.

Telemetry must never get in the way of the command: if the server is at capacity, or
the session it would join already has `maxStreams` streams, `afk run` logs it and
`exec`s the command directly with no session at all, rather than delaying or failing
it.

### Server (`packages/server`)

Hono on Node. Layout is documented at the top of `src/app.ts`:

- `routes/` one Hono sub-app per resource: `sessions` (create, inspect, end),
  `frames` (ingest), `stream` (history + SSE), `web` (built dashboard).
- `middleware/ingest-auth.ts` resolves the session, checks the bearer ingest token,
  rejects non-active sessions with 410.
- `store/sessions.ts` is the in-memory working set: active sessions, per-stream
  sequence bookkeeping, SSE listeners. It writes through to `store/storage.ts`, the
  `SessionStorage` interface, and lazily loads sessions it does not have in memory.
  Frames are persisted **before** in-memory state advances, so a failed write is
  retried by the client rather than being counted as a duplicate.
- `store/disk-storage.ts` is the local implementation; `store/s3-storage.ts` is the
  S3-compatible one used against Lightsail object storage in production.
  `store/create-storage.ts` picks between them from `AFK_STORAGE=disk|s3`.
- `log/describe.ts` formats frames for server logs; interpretation constants such as
  memory pressure labels live here or in shared.
- `rules/` is the anomaly-detection engine, described below.

#### Rules engine

Each session holds its own `RuleEngine` (`rules/engine.ts`), instantiated fresh in
`SessionStore.hydrate`. It creates one `RuleInstance` per (stream, rule kind) the
first time a stream produces a frame that rule's collector applies to, then feeds that
instance every frame of the stream in index order. A rule's `onFrame` returns a
`Verdict` — active or not, a severity, a message, and optionally `since` (backdating
the start to when the condition first held rather than when the rule became sure) or
`instant` (a point-in-time event, created already closed, for something like a
command exiting). The engine turns verdicts into `AnomalyEvent`s: a new active verdict
opens one, an unpacked verdict with a changed message or severity updates it in place,
and `active: false` closes it. `Sustain` is the shared helper for "condition held for
at least N ms."

Events are **derived, never persisted** — they live only in the engine's `events` and
`open` maps, keyed by `<stream> <kind>`, and are recomputed from stored frames whenever
a session is loaded (`hydrate` calls `engine.onFrames(frames)` before the session is
usable). That means an improved rule, or a new one, applies retroactively to every
past session the next time it is loaded — there is nothing to migrate. A non-active
session is immediately replayed through `engine.closeAll` so nothing is left open past
the point the session actually stopped.

Two rules are time-based rather than purely frame-driven (`client.stale`, which needs
to notice _silence_, and any future rule like it): their `RuleInstance` also
implements `onTick`, called with the current time so they can open or update an event
even when no frame has arrived. `SessionStore.startTicker` runs a periodic tick
(`TICK_INTERVAL_MS`, 5 s) across every session in memory; during replay the engine
ticks with each frame's own timestamp instead, so history and a live viewer see the
same events.

The rule catalogue lives in `RULES` (`rules/engine.ts`): `cpu.high` and
`memory.pressure` (`rules/system.ts`), `client.stale` (`rules/stale.ts`), and
`run.exited` / `run.stalled` (`rules/run.ts`). Field-level detail and the current
thresholds are in [PROTOCOL.md](PROTOCOL.md). Adding a rule is described in
[EXTENDING.md](EXTENDING.md).

#### Admission control

The server bounds two things: how many sessions it holds in memory at once
(`maxActiveSessions`), and how many streams one session may accumulate
(`maxStreamsPerSession`). Both live in `AdmissionLimits` (`env.ts`), default 20 and
10, overridable via `AFK_MAX_ACTIVE_SESSIONS` / `AFK_MAX_STREAMS_PER_SESSION`.

The 20 × 10 default is sized for the smallest Lightsail container node (0.25 vCPU,
512 MB): active sessions keep every frame in memory for replay and SSE, and a one-hour
stream at 1 Hz is roughly 5 MB of JS objects, so 20 sessions × 10 streams worst case
stays under 300 MB with headroom for Node itself; typical sessions (one or two
streams) use a fraction of that.

`POST /api/sessions` checks `store.hasCapacity()` before creating a session; at
capacity it returns 503 with `Retry-After`, and `create_session_or_wait` in the client
polls until there is room. `store.ingest` checks the per-session stream cap as it
processes a batch and throws `TooManyStreamsError` for the frame that would add an
eleventh stream, which the frames route turns into 422 — the batch itself is
well-formed, just over the limit, so a different status than a generic bad request.

Ended sessions with no active SSE listeners are evicted from the in-memory cache after
`EVICT_ENDED_AFTER_MS` (10 minutes) of no access, in the same `tick()` pass that runs
the time-based rules — this keeps memory bounded without a separate sweep. What is
_not_ done yet: `framesInMemory` in `GET /api/stats` is a frame **count**, not an
actual measurement of bytes held, so it is only a proxy for the memory the admission
limits are meant to bound.

`GET /api/stats` (`routes/stats.ts`) exposes `ServiceStats` — active/max sessions,
max streams per session, sessions and frames currently in memory, uptime, and the
server version — unauthenticated and cheap, for the landing page and for operators
checking headroom.

### Dashboard (`packages/web`)

Vite + React 19 + TanStack Router and Query. Plain CSS, no chart library. The page
talks only to a `SessionSource` interface (`src/data/source.ts`) with two
implementations: the real API and a deterministic fixture for `/s/demo`.

`useSession` loads the whole session into the react-query cache, then, while the
session is active, subscribes over SSE from the last loaded frame index and appends
frames into that same cache. Everything downstream just re-renders from `query.data`.

The timeline is a canvas per stream with a shared time axis and a scrubber. A
registry keyed by collector name (`timeline/registry.ts`, `CollectorUi`) maps each
collector to a row renderer (`drawRow`, imperative canvas drawing) and a `Details`
component for the frame under the scrubber. In follow mode the cursor tracks the
current time; scrubbing detaches it. Adding a collector to the shared `Frame` union
makes the registry fail to type check until an entry is added, which is the point.

Anomaly events are drawn as a DOM overlay on top of each row's canvas, not baked into
the canvas drawing itself (`timeline/EventMarkers.tsx`): a translucent band along a
spanning event's duration, plus a clickable marker at its start. `timeline/clusters.ts`
merges markers whose start x-position would land within `CLUSTER_DISTANCE_PX` (12px)
of each other into one badge showing a count and the worst severity among its members
— pure geometry, recomputed from the current `x(timeMs)` mapping, so zooming in splits
a cluster back into individual markers naturally. `timeline/viewport.ts` owns the
zoom/pan/follow state as pure functions over a `TimeWindow` (`clampWindow`,
`zoomWindow`, `panWindow`, `resolveWindow`): zoomed-in while following live keeps the
window's width but pins its right edge to the latest frame, so new data stays in view
as the session grows; `windowAround` frames a window around an event when a marker is
clicked.

Two components read the same session-wide event list: `StatusBanner` shows the
overall verdict (open events while a session is active, everything that happened once
it has ended, coloured by worst severity) and `NearbyEvents` lists anomalies whose
span comes within a radius of the current cursor, falling back to the full list when
nothing is nearby. Neither interprets raw measurements — they only render what the
server's `AnomalyEvent`s already say.

The server serves the built dashboard so the URL the client prints works directly.
For UI work the Vite dev server proxies `/api` to the server.

## Data model

- A **session** is one `afk start` on one machine: unguessable id (also the share
  link), a separate write-only ingest token, host info, start and end times, and a
  server-owned maximum duration (one hour).
- A **stream** is one time series within a session and one row on the timeline.
  Singleton collectors use their own name (`system`); per-instance collectors append
  an id (`run:3f2a`). Sequence numbers are per stream.
- A **frame** is one sample: `stream`, `collector`, `sequence`, client `timestamp`,
  and collector-specific `data`. Stored frames gain a session-wide `index` and a
  server `receivedAt`. Full field definitions are in [PROTOCOL.md](PROTOCOL.md).

## Storage

`sessions/<id>/session.json` holds the session record; `sessions/<id>/frames.ndjson`
is append-only, one stored frame per line, in index order. Per-stream sequence state
is rebuilt from the frames on load rather than persisted. The bucket layout
(`store/s3-storage.ts`) is the same except that each ingested batch becomes its own
object under `sessions/<id>/frames/`, since object stores cannot append. Retention
(delete 7 days after end) is a server-side sweeper so it works on every backend.

## Deployment

Hosted at `afk.osv.im` on a Lightsail container service with a Lightsail bucket for
storage; the server is one Docker image that builds the dashboard and runs Node. The
`AFK_SERVER` variable points the client at any other server, including one on a
private network. See `infra/` and the Deployment section of BACKLOG.md.

## Decision log

Newest first. Add an entry whenever a direction changes; keep the reasoning short.

- **2026-09-14** Tests are Vitest, one config at the repo root, co-located with the
  code they cover (`foo.test.ts` next to `foo.ts`), builders (`makeSystemFrame`,
  `makeEvent`, …) over literals, real implementations (`MemorySessionStorage`,
  `app.request()`) over mocks. See [TESTING.md](TESTING.md). The bash client is tested
  by sourcing it with `AFK_SOURCED=1` and calling functions directly from Vitest.
- **2026-09-14** Admission control caps active sessions (20) and streams per session
  (10), sized for the smallest Lightsail container node (0.25 vCPU, 512 MB): a
  one-hour stream at 1 Hz is roughly 5 MB of JS objects, so the worst case stays under
  300 MB with headroom for Node itself. Creating a session at capacity returns 503
  with `Retry-After`; a batch that would exceed the per-session stream cap returns 422.
- **2026-09-14** The `run` collector's `output` field carries a `flavor` discriminator
  (`"volume"` today: cumulative stdout/stderr byte counts) instead of a fixed shape, so
  richer parsers (progress lines, structured JSON records) can be added later without
  changing the envelope or bumping the protocol version.
- **2026-09-14** Anomaly events are derived from frames on the server and never
  persisted; a loaded session replays its frames through a fresh `RuleEngine`. Means an
  improved or new rule applies to every past session automatically, at the cost of
  recomputing events on every load — acceptable since sessions are capped at an hour.
- **2026-09-14** Lightsail bucket credentials reach the container as plain
  environment variables (`AFK_S3_ACCESS_KEY_ID`/`AFK_S3_SECRET_ACCESS_KEY`), set by
  `deploy.sh` from `tofu output`. Lightsail's "resource access" feature (granting
  compute direct, keyless access to a bucket) only supports instances, not
  container services, so there's no keyless option here; an access key is the
  only mechanism available.
- **2026-09-14** Deploy as a Lightsail container service, not an instance. Removes the
  cloud-init bootstrap, rsync deploys, and Caddy at about +$2/month. Consequence: no
  local disk in production, so storage goes through an interface.
- **2026-09-14** Storage interface with disk locally and Lightsail object storage
  (S3-compatible) in production. Keeps the project portable to real S3 or MinIO for
  self-hosters. Server owns expiry because Lightsail buckets have no lifecycle rules.
- **2026-09-14** Dashboard follows live sessions over SSE by appending into the
  react-query cache; the initial load and the stream share `StoredFrame.index` as the
  resume cursor.
- **2026-09-13** Sessions capped at one hour by the server so a whole trace stays a
  few MB and loads quickly in the browser. Auto-chaining a new session is a backlog item.
- **2026-09-13** Anomaly detection lives on the server; collectors stay dumb.
- **2026-09-13** Client is a bash 3.2 script with point-in-time sampling commands
  only (no long-lived `top`), so it stays readable and dependency-free.
- **2026-09-13** Wire protocol uses explicit, readable field names over terse ones.
- **2026-09-13** Node + Hono server and a TypeScript monorepo so types are shared
  between server and dashboard; SSE for live updates.
