# afk

Away-from-keyboard telemetry: a bash client streams machine health to a Node server
that serves a shareable live dashboard. Prototype stage; the aim is a working MVP
with natural extension points, not completeness.

## Read first

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data flow, storage, and a
  dated decision log. Add a log entry whenever a direction changes.
- [docs/PROTOCOL.md](docs/PROTOCOL.md): the wire contract. `packages/shared/src/protocol.ts`
  is the source of truth; keep the doc in step with it.
- [docs/EXTENDING.md](docs/EXTENDING.md): how to add a collector, rule, storage backend,
  or data source.
- [BACKLOG.md](BACKLOG.md): the todo list. Deferred work goes here, not in scattered
  TODO comments alone. Check items off as they land.

## Layout

`cli/afk` (bash client), `packages/shared` (Zod schemas, shared types),
`packages/server` (Hono), `packages/web` (Vite + React + TanStack), `scenarios/`
(workloads that exercise the monitor), `infra/` (OpenTofu), `docs/`.

## Commands

```bash
pnpm install
pnpm build            # dashboard into packages/web/dist, served by the server
pnpm dev:server       # http://localhost:4141
pnpm dev:web          # Vite on :5173, proxies /api to :4141
pnpm typecheck && pnpm lint && pnpm format:check
AFK_SERVER=http://localhost:4141 ./cli/afk start
```

Smoke test after touching the server or client: start the server, run the client for
a few seconds, `kill -TERM` it, and check the server log shows frames and "ended by
client". macOS has no `timeout`; background the client and kill it by pid. A stale
server can hold port 4141 and silently serve old code: kill it with
`lsof -t -iTCP:4141 -sTCP:LISTEN | xargs kill`.

## Conventions

- **Dumb client, smart server.** Collectors ship raw values. Thresholds, labels, and
  anomaly detection live on the server so users never need a new CLI for better rules.
- **Schemas first.** New wire fields start in `packages/shared` as Zod; types are
  inferred. Explicit, readable names (`memoryPressureLevel`, not `mp`).
- **Bash 3.2** for `cli/afk`: no bash 4 features, no jq, no python. Point-in-time
  sampling commands only, no long-lived `top`. Every JSON string goes through
  `json_string`.
- **async/await only.** No `.then`, `.catch`, `.finally` chains (lint enforced).
- **Braces on every control statement**, body on its own line (lint enforced).
- **Named constants** at the top of the file instead of inline literal maps; enums in
  shared for protocol semantics.
- **Hono layout**: one route module per resource under `routes/`, request plumbing in
  `middleware/`, wiring only in `app.ts`.
- **Commits**: small and logical, as you go, not one at the end. Stage specific paths,
  never `git add -A`, because subagents may be working in the tree concurrently.
- **Prettier and ESLint** are the formatting and style authority; run them before
  committing.
- Leave `TODO(topic):` comments for deferred abstractions and mirror anything
  non-trivial in BACKLOG.md.
