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
GET  /s/:id                             browser           the dashboard itself
```

Ingest endpoints require `Authorization: Bearer <ingestToken>`. Read endpoints have no
auth: the session id is the unguessable share link (22 chars of base62, ~131 bits).
The ingest token never appears in the dashboard URL, so sharing a trace never shares
write access.

Every client request carries `X-Afk-Client: bash/<version>` so the server can refuse
clients below a minimum version (planned).

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

### Ingest

`Content-Type: application/x-ndjson`, one frame per line. The client's spool file is
already in this shape, so a batch is just the file body. Response:

```json
{ "accepted": 12, "duplicates": 0, "latestSequence": { "system": 42 } }
```

Frames whose `sequence` is at or below the server's latest for that stream are
counted as duplicates and ignored. That makes retries idempotent: a batch that was
received but whose acknowledgement was lost is resent and skipped. Status codes:

| code                        | meaning                                    | client behaviour                   |
| --------------------------- | ------------------------------------------ | ---------------------------------- |
| 200                         | accepted                                   | delete the batch                   |
| 400 / 401 / 404 / 413       | the server will never accept this batch    | park it in `rejected/`, keep going |
| 410                         | session ended or past its maximum duration | stop the session                   |
| anything else / no response | transient                                  | keep the batch, back off, retry    |

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

## Reading a session

### History

`GET /api/sessions/:id/frames?after=N` returns the summary and every stored frame with
`index > N` (default 0):

```json
{ "session": { "sessionId": "…", "status": "active", "…": "…" }, "frames": ["…"] }
```

`status` is `active`, `ended`, or `expired`.

### Stream

`GET /api/sessions/:id/stream` is `text/event-stream`. Events in order:

```
event: session          data: SessionSummary        on connect
event: frame            data: StoredFrame           id: <index>, replayed then live
: keepalive                                         every 15 s
event: end              data: SessionSummary        once the session is over; stream closes
```

Resume with the `Last-Event-ID` header (browsers send it automatically on reconnect)
or `?after=<index>`; the header wins. On an already-ended session the server replays
everything and sends `end` immediately, which is exactly the completed-trace view.

Planned: `event: event` for server-detected anomalies (see EXTENDING.md).

## Versioning

`protocolVersion` is a literal in the create request; a server that does not
understand it rejects the session with 400. Adding a collector or an optional field is
backwards compatible. Renaming or removing a field, or changing a meaning, bumps the
version. Schema drift between server and dashboard is caught by `safeParse` on the
dashboard side and currently ignored per frame (TODO: surface it).
