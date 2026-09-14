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
- `store/disk-storage.ts` is the local implementation. An S3-compatible one for
  Lightsail object storage is planned (see BACKLOG.md).
- `log/describe.ts` formats frames for server logs; interpretation constants such as
  memory pressure labels live here or in shared.

Anomaly detection (planned) will be a rules module keyed by collector that turns
frames into events with a start, optional end, severity, and message. Events will be
stored alongside frames and streamed on the same SSE connection.

### Dashboard (`packages/web`)

Vite + React 19 + TanStack Router and Query. Plain CSS, no chart library. The page
talks only to a `SessionSource` interface (`src/data/source.ts`) with two
implementations: the real API and a deterministic fixture for `/s/demo`.

`useSession` loads the whole session into the react-query cache, then, while the
session is active, subscribes over SSE from the last loaded frame index and appends
frames into that same cache. Everything downstream just re-renders from `query.data`.

The timeline is a canvas per stream with a shared time axis and a scrubber. A
registry keyed by collector name maps each collector to a row renderer and a details
component. In follow mode the cursor tracks the current time; scrubbing detaches it.

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
is rebuilt from the frames on load rather than persisted. The bucket layout will be
the same except that each ingested batch becomes its own object, since object stores
cannot append. Retention (delete 7 days after end) is a server-side sweeper so it
works on every backend.

## Deployment

Hosted at `afk.osv.im` on a Lightsail container service with a Lightsail bucket for
storage; the server is one Docker image that builds the dashboard and runs Node. The
`AFK_SERVER` variable points the client at any other server, including one on a
private network. See `infra/` and the Deployment section of BACKLOG.md.

## Decision log

Newest first. Add an entry whenever a direction changes; keep the reasoning short.

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
