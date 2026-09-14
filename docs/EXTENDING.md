# Extending afk

The seams that are meant to be extended, and the steps for each.

## Adding a collector

A collector is a named kind of measurement. Four places, in this order:

1. **Shared schema** (`packages/shared/src/protocol.ts`): add a `<Name>CollectorData`
   Zod object, a `<Name>Frame` that extends `FrameBase` with `collector: z.literal("<name>")`,
   and add it to the `Frame` discriminated union. Prefer explicit field names and raw
   values; interpretation belongs on the server.
2. **Client** (`cli/afk`): add a `collect_<name>()` function that prints one compact
   JSON object matching the schema, and call it from `sample_once` with its own
   sequence counter. Bash 3.2 only: no associative arrays, no `${var,,}`, no `mapfile`.
   Numbers can be printed directly; strings must go through `json_string`. Keep it a
   point-in-time command, not a long-lived process.
3. **Server**: add a `case` to `describeFrame` in `packages/server/src/log/describe.ts`
   for readable logs, and (once rules exist) a rules module for the events this
   collector can raise. Interpretation constants such as label maps are `const`s at the
   top of the file or, if they are protocol semantics, enums in shared.
4. **Dashboard** (`packages/web/src/timeline/collectors/`): add a row renderer and a
   details component and register them in `timeline/registry.ts` keyed by collector
   name. The `system` collector is the template. Extend the fixture in
   `data/fixtureSource.ts` so `/s/demo` exercises the new row.

Per-instance collectors (a wrapped command, a watched log file) use a stream id of
`<collector>:<shortId>` so each instance gets its own row and sequence space.

Planned collectors: `processes` (top processes with pid, parent pid, cpu, rss, full
path), `agents` (running claude / codex counts), `run` (`afk run -- <cmd>`: stdout and
stderr bytes per tick and the exit code).

### External collectors (planned)

The collector protocol is "print one JSON object". The intended plugin path is for
`afk` to run any executable on a schedule and wrap its output in a frame envelope with
`collector: "<plugin name>"`, with the server accepting a generic `custom` collector
whose `data` is an open object. Until then, collectors are shell functions.

## Adding a server-side rule (planned shape)

Rules turn frames into **events**: `{ id, stream, kind, severity, message, startedAt,
endedAt? }`. They live in the server, keyed by collector, and run on every accepted
frame with access to that stream's recent history. Events are persisted next to frames
and delivered to the dashboard as `event: event` on the same SSE stream. The status
banner shows currently open events; the timeline marks them on the relevant row.

First rules to write: cpu above 90% for 30 s, memory pressure at warn or critical,
client silent for 60 s, a run exiting non-zero, a run producing no output for 60 s.

## Adding a storage backend

Implement `SessionStorage` in `packages/server/src/store/storage.ts`:

| method           | disk                            | object store                                                 |
| ---------------- | ------------------------------- | ------------------------------------------------------------ |
| `putSession`     | write `session.json` atomically | put `sessions/<id>/session.json`                             |
| `getSession`     | read it                         | get it                                                       |
| `appendFrames`   | append lines to `frames.ndjson` | put `sessions/<id>/frames/<first index, zero padded>.ndjson` |
| `readFrames`     | read the file                   | list the prefix, get each object in key order, concatenate   |
| `listSessionIds` | readdir                         | list `sessions/` with delimiter                              |
| `deleteSession`  | rm -rf                          | delete every key under the prefix                            |

Frames always arrive in index order and are never rewritten, which is what makes the
object-store variant simple. `store/s3-storage.ts` is the S3-compatible
implementation (Lightsail buckets, real S3, MinIO); `store/create-storage.ts`
exports `createStorageFromEnv`, which picks a backend from `AFK_STORAGE=disk|s3`
(and the `AFK_S3_*` variables for the latter) for `src/index.ts` to use.

## Adding a dashboard data source

`SessionSource` in `packages/web/src/data/source.ts` is `load` plus `subscribe`. The
fixture implementation shows the minimum. A source for a static exported trace file,
or for a self-hosted server on another origin, slots in here without touching the
page.

## Self-hosting

`AFK_SERVER` on the client and `AFK_PUBLIC_BASE_URL` plus `AFK_DATA_DIR` on the server
are the whole configuration today. A server on a private network (Tailscale MagicDNS,
for instance) works unchanged with disk storage. Session creation is open and
unauthenticated; an optional shared secret for private servers is on the backlog.
