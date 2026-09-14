# Wire protocol

Source of truth: `packages/shared/src/protocol.ts`. This page explains it; if they
disagree, the schemas win. Protocol version: 1.

## Session lifecycle

```
POST /api/sessions                      client → server   create
POST /api/sessions/:id/frames           client → server   ingest, repeated (bearer token)
POST /api/sessions/:id/end              client → server   end (bearer token)
GET  /api/sessions/:id/qr               client → server   dashboard URL as a QR code (bearer token)
GET  /api/sessions/:id                  anyone            summary
GET  /api/sessions/:id/frames?after=N   dashboard         history
GET  /api/sessions/:id/stream           dashboard         SSE, live + replay
GET  /api/stats                         anyone            whole-service numbers
GET  /versionz                          anyone            what is running (server, dashboard, protocol)
GET  /api/version                       anyone            the same body as /versionz
GET  /s/:id                             browser           the dashboard itself
```

Ingest endpoints require `Authorization: Bearer <ingestToken>`. Read endpoints have no
auth: the session id is the unguessable share link (22 chars of base62, ~131 bits).
The ingest token never appears in the dashboard URL, so sharing a trace never shares
write access.

Every client request (create, ingest, end, qr) carries `X-Afk-Client: <name>/<semver>`,
`bash/0.2.0` today. The server refuses clients below its minimum version, and requests
on those four endpoints with a missing or malformed header, with `426 Upgrade
Required`; the body is an `ErrorResponse` whose `details` is `UpgradeRequiredDetails`
(`minimumClientVersion`, `minimumProtocolVersion`, `yourVersion`). Read endpoints are
never version-checked. See [VERSIONING.md](VERSIONING.md).

Bodies are capped: 4 KiB on create and 1 MiB on ingest (a full 200-file client batch is
roughly 130 KB). Anything larger gets `413` with an `ErrorResponse` whose `details.limit`
is the cap in bytes.

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

Status codes on create:

| code | meaning                                                                                     | client behaviour                                                            |
| ---- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 201  | session created                                                                             | start sampling                                                              |
| 400  | the body failed validation (`details` is the Zod error, naming the field)                   | give up; a client bug                                                       |
| 413  | the body is larger than the create limit                                                    | give up; a client bug                                                       |
| 426  | this client version or `protocolVersion` is below what the server accepts (`details` above) | print the server's message and the update hint, exit 1                      |
| 503  | at capacity (`Retry-After` in seconds)                                                      | `afk start` waits and retries; `afk run` runs the command without telemetry |

A `protocolVersion` outside `[MIN_PROTOCOL_VERSION, PROTOCOL_VERSION]` is a 426, not a
400, so an old client sees the upgrade message rather than "invalid request".

### Ingest

`Content-Type: application/x-ndjson`, one frame per line. The client queues each
frame as one file in this shape, so a batch is just the oldest files concatenated
(up to 200 of them). Response:

```json
{ "accepted": 12, "duplicates": 0, "latestSequence": { "system": 42 } }
```

Frames whose `sequence` is at or below the server's latest for that stream are
counted as duplicates and ignored. That makes retries idempotent: a batch that was
received but whose acknowledgement was lost is resent and skipped. Status codes:

| code                        | meaning                                              | client behaviour                        |
| --------------------------- | ---------------------------------------------------- | --------------------------------------- |
| 200                         | accepted                                             | delete the batch                        |
| 400 / 401 / 404 / 413       | the server will never accept this batch              | park it in `rejected/`, keep going      |
| 410                         | session ended or past its maximum duration           | stop the session                        |
| 422                         | a frame's stream would exceed `maxStreamsPerSession` | park it in `rejected/`, keep going      |
| 426                         | the server no longer talks to this client version    | stop the session, print the update hint |
| anything else / no response | transient                                            | keep the batch, back off, retry         |

413 means the body is over the ingest cap (1 MiB; `details.limit`), which a
well-behaved client never reaches (see the arithmetic in `routes/frames.ts`). 422 means
the batch was well formed (unlike the 400 row above) but would add a stream past the
session's cap; the error body's `details` names the offending `stream` and the `limit`.
The client cannot fix either by retrying, so the batch is parked the same way as a
permanent rejection. 426 is the version check described under "Session lifecycle": a
client that was fine when it created the session but has since been retired keeps its
queue on disk and stops, like a 410, so nothing sampled is lost.

### End

Marks the session ended and returns the session summary. Sessions that never receive
an end become `expired` once past `maxDurationSeconds`.

### QR code

`GET /api/sessions/:id/qr` renders the session's `dashboardUrl` as a QR code so the
client can put it on the terminal for a phone to scan; the bash client has no QR
library of its own. It takes the bearer ingest token like the other client endpoints:
the URL is the share link, so only the session's owner gets it drawn (the dashboard
renders its own copy in the browser). Like ingest, it answers `410` once the session is
over.

The default response is `text/plain; charset=utf-8`: the code drawn with Unicode
half-block characters (`█`, `▀`, `▄`, and space), two module rows per line, with a
one-module quiet zone on every side, followed by the URL on its own line. Light modules
are the block characters and dark modules are spaces, so the code has the right polarity
on a dark terminal (a light terminal shows it inverted, which phone cameras also read).
Error correction level M, smallest version that fits the URL; the hosted URL with its
22-character session id gives a 33 × 33 code, 35 columns by 18 lines with the quiet zone.

`?format=svg` returns the same code as `image/svg+xml`, scalable (no fixed size), black
modules on white with a four-module quiet zone. Any other `format` is a `400`.

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

When the command exited non-zero, the final frame's `output` also carries `tail`, the
last lines it printed, so the dashboard can say why it failed:

```json
"output": {
  "flavor": "volume",
  "stdoutBytes": 9140,
  "stderrBytes": 71,
  "tail": {
    "stdout": ["processing 299/10000 items", "processing 300/10000 items"],
    "stderr": ["migration-hang: fatal: lost connection to database after item 300"],
    "truncated": true
  }
}
```

| field       | meaning                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `stdout`    | the last lines of stdout, oldest first; at most `RUN_TAIL_MAX_LINES` (20)                                  |
| `stderr`    | the same for stderr                                                                                        |
| `truncated` | true when either stream had more lines than were kept (cut lines do not count)                             |
| each line   | at most `RUN_TAIL_MAX_LINE_CHARS` (200) characters; the client cuts by byte, so never more, possibly fewer |

`tail` is independent of `output.flavor`: every flavor carries it in the same place.
The client sends it only on the final frame, only for a non-zero exit, and only when
its `AFK_RUN_TAIL_LINES` variable is not `0`; that variable (default 20, capped at 20)
is the privacy switch, since the tail is the one place command output leaves the
machine. Output of a command that exits 0 is never sent. Lines are cut to 200 bytes,
ANSI colour sequences and control characters other than tab are dropped, and a line's
text goes through the same escaping as every other string. The schema rejects a tail
over either cap, so a client must apply them before sending.

### Collector: `processes`

The busiest processes, sampled every 5 s (the client's `PROCESSES_INTERVAL_SECONDS`)
on its own `processes` stream. One `ps -Aro pid=,ppid=,%cpu=,%mem=,rss=,comm=` call,
so `top` is in cpu-descending order and `sampledCount` is how many processes there
were in total. `rssBytes` is bytes (converted from ps's KiB); `command` is the full
executable path as ps's `comm` reports it, cut to 512 chars.

```json
{
  "sampledCount": 834,
  "top": [
    {
      "pid": 51234,
      "parentPid": 51200,
      "cpuPercent": 1112.4,
      "memoryPercent": 0.8,
      "rssBytes": 272629760,
      "command": "/opt/homebrew/bin/node"
    }
  ]
}
```

`top` holds at most 10 entries (`PROCESSES_TOP_MAX` in shared). `cpuPercent` is the
per-process `%cpu` from ps, so a process using several cores reports several hundred
percent; the `system` collector's `cpu.percent` is the same numbers summed and divided
by core count.

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
  "message": "cpu above 90% for over 30s (top: node 1112%, WindowServer 9%, Google Chrome Helper 7%)",
  "startedAt": 1789371394000,
  "endedAt": null,
  "details": {
    "topProcesses": [
      { "pid": 51234, "cpuPercent": 1112.4, "command": "/opt/homebrew/bin/node" },
      {
        "pid": 442,
        "cpuPercent": 9.1,
        "command": "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer"
      },
      {
        "pid": 60300,
        "cpuPercent": 7.3,
        "command": "/Applications/Google Chrome.app/…/Google Chrome Helper"
      }
    ]
  }
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
| `details`   | optional structured snapshot the rule captured when the event opened (`AnomalyEventDetails`, below); absent when the rule had nothing to add  |

`details` is a named object so rules can add fields over time without changing the
event envelope. Today it has two fields, each optional:

- `topProcesses`: at most 3 entries of `{ pid, cpuPercent, command }`
  (`EVENT_TOP_PROCESSES_MAX`), taken from the latest `processes` frame at the moment
  the event opened. Set by `cpu.high`.
- `outputTail`: the `output.tail` of a run's final frame (`{ stdout, stderr,
truncated }`, same caps as the frame field above), copied by `run.exited` when the
  frame carries one, i.e. the command failed and the client's output switch was on.

It is a snapshot: while the event stays open the message and severity may be updated
by later verdicts, but `details` keeps what was running when the condition began.

The rule catalogue today:

| kind              | collector | severity           | trigger                                                                                       | shape    |
| ----------------- | --------- | ------------------ | --------------------------------------------------------------------------------------------- | -------- |
| `cpu.high`        | `system`  | warning            | cpu ≥ 90% sustained 30 s; backdated to when it crossed; names the top 3 processes (see below) | spanning |
| `memory.pressure` | `system`  | warning / critical | pressure level ≥ warn (critical if ≥ critical) sustained 5 s                                  | spanning |
| `client.stale`    | `system`  | warning            | no frame from the stream for 60 s; opens on a tick, backdated to 60 s after the last frame    | spanning |
| `run.exited`      | `run`     | info / critical    | the wrapped command exited (critical if non-zero; ends with its last output line, see below)  | instant  |
| `run.stalled`     | `run`     | warning            | still running but output volume unchanged for 60 s; backdated to when it stopped changing     | spanning |

A spanning event opens with `endedAt: null` and later gets an `endedAt` once the
condition clears (or the session ends, which closes everything still open). An instant
event (`run.exited`) is created already closed: `startedAt` equals `endedAt`. See
[ARCHITECTURE.md](ARCHITECTURE.md) for how the rules engine derives these and
[EXTENDING.md](EXTENDING.md) for how to add one.

`cpu.high` looks across streams: when it opens it reads the session's latest
`processes` frame, puts the three busiest by `cpuPercent` into `details.topProcesses`,
and appends them to the message by basename, e.g. "cpu above 90% for over 30s (top:
node 1112%, WindowServer 9%, Google Chrome Helper 7%)". A session without a
`processes` stream gets the plain message and no `details`.

`run.exited` reads the final frame's `output.tail`: when it is there, the failure
message ends with the last non-blank stderr line (stdout's if stderr is empty), e.g.
"command failed with exit code 3 after 12s: fatal: lost connection to database", and
the whole tail is stored in `details.outputTail`. A run whose client sent no tail
(exit 0, or `AFK_RUN_TAIL_LINES=0`) gets the plain message and no `details`.

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
  "serverVersion": "0.1.0",
  "webCommit": "abc1234"
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
| `serverVersion`        | `packages/server`'s package.json version                           |
| `webCommit`            | short git commit of the served dashboard build; null without one   |

## GET /versionz

What is running, for a deploy to verify its rollout and for a bug report to say which
build it is about. Unauthenticated, cheap, no session id. `GET /api/version` returns
the same body under the API prefix the dashboard's dev proxy forwards.

```json
{
  "server": { "version": "0.1.0", "commit": "abc1234", "builtAt": "2026-09-15T10:00:00Z" },
  "web": { "version": "0.1.0", "commit": "abc1234" },
  "protocolVersion": 1
}
```

| field             | meaning                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.version`  | `packages/server`'s package.json version, read at startup                                                                                                          |
| `server.commit`   | short git commit the image was built from (`AFK_BUILD_SHA`, see CONFIGURATION.md); null when not set, as in a local run                                            |
| `server.builtAt`  | when the image was built (`AFK_BUILD_TIME`, ISO 8601); null when not set                                                                                           |
| `web`             | `packages/web`'s package.json version and the commit its build was made from, read from `dist/version.json` (written by Vite); null when no dashboard build exists |
| `web.commit`      | `"unknown"` when the build ran outside a git checkout without `AFK_BUILD_SHA`                                                                                      |
| `protocolVersion` | `PROTOCOL_VERSION` in shared                                                                                                                                       |

`infra/deploy.sh` polls this after a rollout until `server.commit` equals the commit it
built, so a deployment Lightsail accepted but that never served the new code fails
the deploy instead of passing silently. Schemas: `VersionResponse`, `ServerBuildInfo`,
`WebBuildInfo` in `packages/shared/src/protocol.ts`.

## Versioning

Two independent numbers: the **protocol version** (`protocolVersion` in the create
request, an integer, bumped only for an incompatible wire change; the server accepts
`[MIN_PROTOCOL_VERSION, PROTOCOL_VERSION]`) and the **client version** (`clientVersion`
and the `X-Afk-Client` header, semver, bumped on every client release; the server has a
`MIN_CLIENT_VERSION` only for retiring clients with known-bad behaviour). A client the
server will not talk to gets `426 Upgrade Required` with `details` naming both minimums.
The policy, what each bump requires, and the checklist for a protocol bump are in
[VERSIONING.md](VERSIONING.md). Schema drift between server and dashboard is caught by
`safeParse` on the dashboard side and currently ignored per frame (TODO: surface it).
