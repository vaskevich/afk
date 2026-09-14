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
   sequence counter. The sampler counts ticks (one per `SAMPLE_INTERVAL_SECONDS`), so a
   collector that does not need 1 Hz runs behind `due_every "$<NAME>_INTERVAL_SECONDS"`
   the way `processes` does (every 5 s). Bash 3.2 only: no associative arrays, no
   `${var,,}`, no `mapfile`. Numbers can be printed directly; strings must go through
   `json_string` (or an equivalent escape inside awk, as `collect_processes` does).
   Keep it a point-in-time command, not a long-lived process.
3. **Server**: add a `case` to `describeFrame` in `packages/server/src/log/describe.ts`
   for readable logs, and, if this collector's data can indicate something worth
   flagging, a rules module for the events it can raise (see "Adding a server-side
   rule" below). Interpretation constants such as label maps are `const`s at the top of
   the file or, if they are protocol semantics, enums in shared.
4. **Dashboard** (`packages/web/src/timeline/collectors/`): add a row renderer and a
   details component and register them in `timeline/registry.ts` keyed by collector
   name (see "Adding a dashboard row renderer" below). The `system` collector is the
   template. Extend the fixture in `data/fixtureSource.ts` so `/s/demo` exercises the
   new row.

Per-instance collectors (a wrapped command, a watched log file) use a stream id of
`<collector>:<shortId>` so each instance gets its own row and sequence space.

Shipped so far: `system`, `run` (`afk run -- <cmd>`), and `processes` (the busiest
processes with pid, parent pid, cpu, rss, full path, every 5 s). Planned: `agents`
(running claude / codex counts). See the wire shapes in [PROTOCOL.md](PROTOCOL.md) and
"Adding an output flavor for `run`" below for extending `run` further.

### External collectors (planned)

The collector protocol is "print one JSON object". The intended plugin path is for
`afk` to run any executable on a schedule and wrap its output in a frame envelope with
`collector: "<plugin name>"`, with the server accepting a generic `custom` collector
whose `data` is an open object. Until then, collectors are shell functions.

## Adding a server-side rule

Rules turn frames into `AnomalyEvent`s (`packages/shared/src/protocol.ts`): `id`,
`stream`, `kind`, `severity`, `message`, `startedAt`, `endedAt`. They live under
`packages/server/src/rules/`, keyed by collector, and are derived on the fly — never
persisted — by a per-session `RuleEngine` (`rules/engine.ts`). See ARCHITECTURE.md for
how the engine drives them; this section is about writing one.

The types (`rules/types.ts`):

- **`Rule<C>`**: `{ kind, collector, create() }`. `kind` becomes `AnomalyEvent.kind`
  (dotted, e.g. `"cpu.high"`). `create()` returns a fresh `RuleInstance` — the engine
  makes one per `(stream, rule kind)`, lazily, the first time that stream sees a frame
  from a matching collector.
- **`RuleInstance<C>`**: `onFrame(frame, atMs, context): Verdict`, run for every frame
  of the stream in index order; optionally `onTick(nowMs, context): Verdict` for rules
  that need to notice _silence_ rather than a frame (only `client.stale` does today).
  The engine ticks time-based rules with each frame's own timestamp during replay, so
  history and a live viewer produce the same events.
- **`RuleContext`**: what a rule may consult beyond its own stream. `latestFrame(stream)`
  returns the newest `StoredFrame` of any stream as of the frame or tick being
  processed (the engine records a frame before running rules on it, so a rule sees its
  own stream's current frame too). `cpu.high` uses it to read the latest `processes`
  frame when it opens. Because the map is filled in index order, a replayed session
  sees exactly what a live one did.
- **`Verdict`**: `{ active, severity, message, since?, instant?, details? }`.
  `active: false` (or `INACTIVE`) closes any open event for this rule. `since`
  backdates the start to when the condition first held rather than when the rule
  became sure (a "high for 30 s" rule reports `since` as the moment it crossed the
  line, not 30 s later). `instant` marks a point-in-time event (a command exiting)
  that is created already closed. `details` (`AnomalyEventDetails` in shared) is a
  structured snapshot stored on the event when it opens and left alone afterwards —
  add a field to that shared object rather than inventing a per-rule shape, so the
  dashboard can render it.
- **`Sustain`**: helper for "this condition has held for at least N ms" — feed it a
  boolean each frame, it returns the timestamp the condition first held once the
  duration is met, else `null`. Every current sustained rule uses it; write a new one
  from scratch only if the condition isn't a simple duration threshold.
- **`register(rule)`**: erases the collector type parameter so rules for different
  collectors can share one array. Wrap every rule with it.

Steps:

1. Write the rule in a file grouped by collector (`rules/system.ts` for `system`-typed
   rules, a new `rules/<collector>.ts` for a new collector) as a `Rule<C>` with a
   `kind` and a `create()`.
2. Add `register(yourRule)` to the `RULES` array in `rules/engine.ts`. This is the only
   wiring step — the engine, replay, SSE delivery, and the dashboard's `StatusBanner`
   / `EventMarkers` / `NearbyEvents` all key off `RULES` and the events it produces.
3. Write a co-located `<collector>.test.ts` next to the rule file. Follow
   `rules/engine.test.ts` (the reference test) and [TESTING.md](TESTING.md): feed
   stored frames built with `@afk/shared/testing` builders (`makeSystemFrame`,
   `makeRunFrame`, …) at fixed offsets, assert on the events returned. Cover the
   threshold boundary (29 s vs 30 s, not just "way over" and "way under"), backdating
   (`since`/`startedAt`), and close-on-condition-clear.
4. Update the rule catalogue table in [PROTOCOL.md](PROTOCOL.md) with the new `kind`,
   its collector, severity, and trigger — the wire contract includes what events mean,
   not just their shape.

## Adding an output flavor for `run`

`RunCollectorData.output` is a discriminated union on `flavor` (`packages/shared/src/
protocol.ts`) so how the client looks at a wrapped command's output can grow without
changing the rest of the frame or bumping the protocol version. Today there is one
flavor, `"volume"` (cumulative stdout/stderr byte counts). A richer flavor — parsing
progress lines, counting structured log records — is a new member of that union:

1. **Shared schema**: add a `RunOutput<Name>` Zod object extending `RunOutputBase`
   (which carries the flavor-independent `tail` of a failed run) with
   `flavor: z.literal("<name>")` and whatever fields it needs, and add it to the
   `RunOutput` discriminated union.
2. **Client** (`cli/afk`): `collect_run` builds the `output` object; branch on however
   the run was started (a new flag to `afk run`, or detection of the command) to emit
   the new flavor's shape instead of `"volume"`. Keep it a cheap, point-in-time read —
   no long-lived parsing process per the bash-client rule.
3. **Server**: `rules/run.ts`'s `totalBytes` helper (used by `runStalled`) has a
   `TODO(run)` marking it as volume-only; a rule that wants to react to the new
   flavor's fields needs its own logic, gated on `output.flavor`.
4. **Dashboard**: `timeline/collectors/run.tsx`'s `drawRow` and `rates()` currently
   assume `stdoutBytes`/`stderrBytes` exist on every frame; branch on `output.flavor`
   there too (or route to a different renderer) before reading flavor-specific fields.
5. Update the `output.flavor` union in [PROTOCOL.md](PROTOCOL.md) with the new member.

## Adding a dashboard row renderer

Every collector needs an entry in `timeline/registry.ts`'s `collectors` object, typed
as `CollectorUi<C>`:

- **`label`**: short text for the row header.
- **`rowHeight`**: CSS pixels.
- **`drawRow(ctx, frames, view)`**: imperative canvas drawing, called on every resize
  and data change. `view` gives `width`, `height`, the visible `t0`/`t1`, and
  `x(timeMs)` to map a time to an x coordinate — frames outside `[t0, t1]` may still be
  passed in, so clip or skip them rather than assuming everything is visible.
  `timeline/collectors/system.tsx` and `run.tsx` are the templates: read CSS custom
  properties for color (`getComputedStyle(document.documentElement)`, see the `css()`
  helper in each) rather than hardcoding colors, so the row respects the active theme.
- **`Details`**: a React component rendering the frame under the scrubber, typically a
  `<dl className="kv">` of label/value pairs (see `SystemDetails` / `RunDetails`).

Register the entry in `collectors` keyed by the collector's name; the `{ [C in
CollectorName]: CollectorUi<C> }` type on that object means adding a collector to the
shared `Frame` union makes this file fail to type check until an entry exists — that
is intentional, not a bug to work around. `collectorUi()` is the lookup a caller uses
when it only has a `CollectorName` and needs the type erased.

The dashboard does not interpret raw measurements: a row renderer draws what the data
already says (a percentage, a byte rate, a pressure level) rather than deciding what
counts as high. Anomaly markers and bands are drawn separately, as a DOM overlay
(`timeline/EventMarkers.tsx`) positioned from the same `x(timeMs)` — a row renderer
does not need to know about events at all.

## Adding a storage backend

Implement `SessionStorage` in `packages/server/src/store/storage.ts`:

| method            | disk                            | object store                                                                                                   |
| ----------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `putSession`      | write `session.json` atomically | put `sessions/<id>/session.json`                                                                               |
| `getSession`      | read it                         | get it                                                                                                         |
| `appendFrames`    | append lines to `frames.ndjson` | buffer; every 60 s or 100 frames put a slab `sessions/<id>/frames/<first index, zero padded>.ndjson`           |
| `readFrames`      | read the file                   | get `sessions/<id>/frames.ndjson` if it exists, else list `frames/`, get the parts 16 at a time, concatenate   |
| `listSessionIds`  | readdir                         | list `sessions/` with delimiter                                                                                |
| `deleteSession`   | rm -rf                          | delete every key under the prefix                                                                              |
| `flush?`          | (not needed)                    | write every session's buffer; called from graceful shutdown                                                    |
| `compactSession?` | (not needed)                    | write the frames as `frames.ndjson`, then delete the parts; called in the background at end and by the sweeper |

Frames always arrive in index order and are never rewritten, which is what makes the
object-store variant simple; the two optional methods exist for a backend that buffers
or whose write shape is not its cheapest read shape (see "Storage" in
[ARCHITECTURE.md](ARCHITECTURE.md)). `store/s3-storage.ts` is the S3-compatible
implementation (Lightsail buckets, real S3, MinIO); `store/create-storage.ts`
exports `createStorage`, which builds the backend `AFK_STORAGE=disk|s3` (and the
`AFK_S3_*` variables for the latter) selects. A new backend adds its variables to the
schema in `src/config.ts` and to [CONFIGURATION.md](CONFIGURATION.md), and a branch to
`createStorage`.

## Adding a dashboard data source

`SessionSource` in `packages/web/src/data/source.ts` is `load` plus `subscribe`. The
fixture implementation shows the minimum. A source for a static exported trace file,
or for a self-hosted server on another origin, slots in here without touching the
page.

## Self-hosting

`AFK_SERVER` on the client and `AFK_PUBLIC_BASE_URL` plus `AFK_DATA_DIR` on the server
are all a self-hosted setup needs; every other server variable (limits, retention,
storage backend) is listed with its default in [CONFIGURATION.md](CONFIGURATION.md). A
server on a private network (Tailscale MagicDNS,
for instance) works unchanged with disk storage. Session creation is open and
unauthenticated; an optional shared secret for private servers is on the backlog.
