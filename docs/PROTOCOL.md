# Wire protocol

Source of truth: `packages/shared/src/protocol.ts`. This page explains it; if they
disagree, the schemas win. Protocol version: 1.

## Session lifecycle

```
POST /api/sessions                      client → server   create
POST /api/sessions/:id/frames           client → server   ingest, repeated (bearer token)
POST /api/sessions/:id/end              client → server   end (bearer token)
GET  /api/sessions/:id                  anyone            summary
GET  /api/sessions/:id/frames?after=N   dashboard         history
GET  /api/sessions/:id/stream           dashboard         SSE, live + replay
GET  /api/stats                         anyone            whole-service numbers
GET  /s/:id                             browser           the dashboard itself
```

Ingest endpoints require `Authorization: Bearer <ingestToken>`. Read endpoints have no
auth: the session id is the unguessable share link (22 chars of base62, ~131 bits).
The ingest token never appears in the dashboard URL, so sharing a trace never shares
write access.

Every client request carries `X-Afk-Client: bash/<version>` so the server can refuse
clients below a minimum version (planned; the header is sent and logged but not yet
enforced).

### Create

Request:

```json
{
  "protocolVersion": 1,
  "clientVersion": "0.1.0",
  "host": {
    "hostname": "telesto-ii",
    "platform": "darwin",
    "osVersion": "26.5.2",
    "cpuCount": 8,
    "memoryTotalBytes": 17179869184
  }
}
```

Response (201). The server owns session policy, so the client reads the cap from here
rather than hardcoding it:

```json
{
  "sessionId": "D3FzMqK8qOLVva9LoHF9uc",
  "ingestToken": "…",
  "dashboardUrl": "https://afk.osv.im/s/D3FzMqK8qOLVva9LoHF9uc",
  "maxDurationSeconds": 3600
}
```

The response is compact JSON with no whitespace; the bash client extracts fields with
`sed`, so keep it that way.

At capacity (`maxActiveSessions` active sessions already, see admission control below)
the server returns 503 with a `Retry-After` header (seconds) instead of creating a
session. `afk start` waits and retries until it gets in or gives up after a few
minutes; `afk run` falls back to running the command without telemetry rather than
block it. See [ARCHITECTURE.md](ARCHITECTURE.md) for the limits and why they are sized
the way they are.

### Ingest

`Content-Type: application/x-ndjson`, one frame per line. The client's spool file is
already in this shape, so a batch is just the file body. Response:

```json
{ "accepted": 12, "duplicates": 0, "latestSequence": { "system": 42 } }
```

Frames whose `sequence` is at or below the server's latest for that stream are
counted as duplicates and ignored. That makes retries idempotent: a batch that was
received but whose acknowledgement was lost is resent and skipped. Status codes:

| code                        | meaning                                              | client behaviour                   |
| --------------------------- | ---------------------------------------------------- | ---------------------------------- |
| 200                         | accepted                                             | delete the batch                   |
| 400 / 401 / 404 / 413       | the server will never accept this batch              | park it in `rejected/`, keep going |
| 410                         | session ended or past its maximum duration           | stop the session                   |
| 422                         | a frame's stream would exceed `maxStreamsPerSession` | park it in `rejected/`, keep going |
| anything else / no response | transient                                            | keep the batch, back off, retry    |

422 means the batch was well formed (unlike the 400 row above) but would add a stream
past the session's cap; the error body's `details` names the offending `stream` and
the `limit`. The client cannot fix this by retrying, so the batch is parked the same
way as a permanent rejection.

### End

Marks the session ended and returns the session summary. Sessions that never receive
an end become `expired` once past `maxDurationSeconds`.

## Frames

```json
{
  "stream": "system",
  "collector": "system",
  "sequence": 42,
  "timestamp": 1789371364,
  "data": { "…collector specific…": "…" }
}
```

| field       | meaning                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `stream`    | time series id; one row on the timeline. Singleton collectors use their name; per-instance collectors append an id, e.g. `run:3f2a` |
| `collector` | which collector produced `data`; discriminates the Zod union                                                                        |
| `sequence`  | per-stream counter from 1; de-duplication key                                                                                       |
| `timestamp` | client wall clock, unix **seconds** (macOS `date` has no sub-second output)                                                         |
| `data`      | validated against the collector's schema                                                                                            |

The server stores frames as:

```json
{ "index": 7, "receivedAt": 1789371371010, "frame": { "…as above…": "…" } }
```

`index` is session-wide, 1-based, monotonic across all streams, and doubles as the
SSE event id. `receivedAt` is the server clock in milliseconds.

### Collector: `system`

Sampled at 1 Hz. All memory values are bytes.

```json
{
  "cpu": { "percent": 31.2 },
  "loadAverage": { "oneMinute": 4.1, "fiveMinutes": 3.8, "fifteenMinutes": 3.2 },
  "memory": {
    "pressureLevel": 1,
    "totalBytes": 17179869184,
    "freeBytes": 62222336,
    "activeBytes": 3216670720,
    "inactiveBytes": 3198353408,
    "wiredBytes": 3089006592,
    "compressedBytes": 6442450944,
    "swapUsedBytes": 9625600000,
    "swapTotalBytes": 10737418240
  }
}
```

`cpu.percent` is the sum of per-process `%cpu` from `ps` divided by core count, so
100 means every core busy. It is the kernel's decayed average and lags a spike by a
second or two. `memory.pressureLevel` is the raw `kern.memorystatus_vm_pressure_level`
value (1 normal, 2 warn, 4 critical, `MemoryPressureLevel` in shared); the schema
accepts any integer so an unknown level from a newer macOS still gets recorded.

### Collector: `run`

One wrapped command (`afk run -- <cmd>`), sampled at ~1 Hz for as long as it runs,
plus one final frame with `state: "exited"`. Stream id is `run:<runId>` so every
wrapped command gets its own row.

```json
{
  "command": "npm test",
  "pid": 5821,
  "state": "running",
  "exitCode": null,
  "elapsedSeconds": 12,
  "process": { "cpuPercent": 4.2, "rssBytes": 41943040 },
  "output": { "flavor": "volume", "stdoutBytes": 1204, "stderrBytes": 0 }
}
```

| field            | meaning                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `command`        | the command line as typed, truncated to 256 chars for display         |
| `pid`            | the wrapped process's pid (0 once it is gone)                         |
| `state`          | `"running"` or `"exited"`                                             |
| `exitCode`       | set on the final frame only; `null` while running                     |
| `elapsedSeconds` | since the command started                                             |
| `process`        | the wrapped process itself: cpu percent, rss bytes (both 0 once gone) |
| `output`         | how the client looked at stdout/stderr, see `output.flavor` below     |

`output.flavor` names how the client looked at the output, so richer parsers can be
added later without changing the rest of the frame. Today there is one flavor:

- `"volume"`: `stdoutBytes` and `stderrBytes`, cumulative byte counts. Enough to tell
  "still going" from "hung"; the dashboard derives a bytes/second rate between frames.

The final frame (`state: "exited"`) carries the same shape with `exitCode` set and is
what closes the row: `elapsedSeconds` is the command's total wall time and `output` is
its final cumulative counts.

## Reading a session

### History

`GET /api/sessions/:id/frames?after=N` returns the summary, every stored frame with
`index > N` (default 0), and the session's current anomaly events:

```json
{
  "session": { "sessionId": "…", "status": "active", "…": "…" },
  "frames": ["…"],
  "events": ["…"]
}
```

`status` is `active`, `ended`, or `expired`. `events` (`AnomalyEvent[]`, see below) is
always the complete current set, not just what changed since `after` — there are few
enough of them that resending the set is simpler than a second cursor.

`SessionSummary` also carries `streamCount` (distinct streams seen so far) and
`maxStreams` (the server's per-session cap, see admission control in
[ARCHITECTURE.md](ARCHITECTURE.md)). `afk run` checks these before joining a session
so it can fall back to running without telemetry instead of sending a batch the server
will reject.

### Stream

`GET /api/sessions/:id/stream` is `text/event-stream`. Events, in order of appearance:

```
event: session   data: SessionSummary   on connect, and whenever status changes
event: event     data: AnomalyEvent     every existing event as a snapshot after
                                         `session`, then one per open/update/close
event: frame     data: StoredFrame      id: <index>, replayed then live
: keepalive                             every 15 s
event: end       data: SessionSummary   once the session is over; stream closes
```

Resume with the `Last-Event-ID` header (browsers send it automatically on reconnect)
or `?after=<index>`; the header wins. `event: event` frames carry no SSE id, so they
never disturb frame resumption. On an already-ended session the server replays
everything and sends `end` immediately, which is exactly the completed-trace view.

### Anomaly events

`AnomalyEvent` is something a server-side rule decided is worth calling out. Events are
derived from frames on the server — never persisted, recomputed on session load — and
belong to a stream, i.e. a timeline row.

```json
{
  "id": "system:cpu.high:1789371394000",
  "stream": "system",
  "kind": "cpu.high",
  "severity": "warning",
  "message": "cpu above 90% for over 30s",
  "startedAt": 1789371394000,
  "endedAt": null
}
```

| field       | meaning                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | stable across recomputation: `<stream>:<kind>:<startedAt>`; live updates upsert by this id                                                    |
| `stream`    | which timeline row the event belongs to                                                                                                       |
| `kind`      | dotted rule identifier, e.g. `cpu.high`, `memory.pressure`                                                                                    |
| `severity`  | `info`, `warning`, or `critical`                                                                                                              |
| `message`   | one readable sentence, e.g. "cpu above 90% for 45s (peak 97%)"                                                                                |
| `startedAt` | unix milliseconds, derived from frame timestamps — backdated to when the condition first held, not when the rule became sure                  |
| `endedAt`   | `null` while the condition is still ongoing (a spanning event); set immediately, equal to `startedAt`, for a point-in-time event (an instant) |

The rule catalogue today:

| kind              | collector | severity           | trigger                                                                                    | shape    |
| ----------------- | --------- | ------------------ | ------------------------------------------------------------------------------------------ | -------- |
| `cpu.high`        | `system`  | warning            | cpu ≥ 90% sustained 30 s; backdated to when it crossed                                     | spanning |
| `memory.pressure` | `system`  | warning / critical | pressure level ≥ warn (critical if ≥ critical) sustained 5 s                               | spanning |
| `client.stale`    | `system`  | warning            | no frame from the stream for 60 s; opens on a tick, backdated to 60 s after the last frame | spanning |
| `run.exited`      | `run`     | info / critical    | the wrapped command exited (critical if non-zero)                                          | instant  |
| `run.stalled`     | `run`     | warning            | still running but output volume unchanged for 60 s; backdated to when it stopped changing  | spanning |

A spanning event opens with `endedAt: null` and later gets an `endedAt` once the
condition clears (or the session ends, which closes everything still open). An instant
event (`run.exited`) is created already closed: `startedAt` equals `endedAt`. See
[ARCHITECTURE.md](ARCHITECTURE.md) for how the rules engine derives these and
[EXTENDING.md](EXTENDING.md) for how to add one.

## GET /api/stats

Whole-service numbers for the landing page and for operators. Unauthenticated, cheap,
no session id.

```json
{
  "activeSessions": 3,
  "maxActiveSessions": 20,
  "maxStreamsPerSession": 10,
  "sessionsInMemory": 5,
  "framesInMemory": 48213,
  "uptimeSeconds": 401222,
  "serverVersion": "0.1.0"
}
```

| field                  | meaning                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `activeSessions`       | sessions currently accepting frames                                |
| `maxActiveSessions`    | the admission cap (see ARCHITECTURE.md)                            |
| `maxStreamsPerSession` | per-session stream cap                                             |
| `sessionsInMemory`     | sessions held in the in-memory cache, active or recently viewed    |
| `framesInMemory`       | frames summed across sessions in memory (a count, not a byte size) |
| `uptimeSeconds`        | since the process started                                          |
| `serverVersion`        | the running server's version string                                |

## Versioning

`protocolVersion` is a literal in the create request; a server that does not
understand it rejects the session with 400. Adding a collector or an optional field is
backwards compatible. Renaming or removing a field, or changing a meaning, bumps the
version. Schema drift between server and dashboard is caught by `safeParse` on the
dashboard side and currently ignored per frame (TODO: surface it).
