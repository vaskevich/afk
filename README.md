# afk

Away-from-keyboard telemetry. Run `afk start` on a machine you are about to walk away
from and get a shareable dashboard URL that shows whether everything is still fine.

## Install

```bash
curl -fsSL https://afk.osv.im/install | sh
afk start                    # prints a dashboard URL for your phone
afk run -- <command>         # wraps one command and reports how it went
```

macOS only for now. The installer puts one bash script in `~/.local/bin/afk`
(`AFK_INSTALL_DIR` overrides) and tells you if that directory is not on your `PATH`.
Read it first if you like: it is short, and so is [the client](cli/afk). A self-hosted
server serves the same installer at its own `/install`, and a client installed from it
defaults to that server; set `AFK_SERVER` to point an existing client elsewhere.

Status: early prototype. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/PROTOCOL.md](docs/PROTOCOL.md), [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
(every server environment variable), [docs/EXTENDING.md](docs/EXTENDING.md), and
[BACKLOG.md](BACKLOG.md).

## Layout

- `cli/afk` – the client. One bash script, macOS only for now.
- `packages/shared` – Zod schemas for the wire protocol; types are inferred from them.
- `packages/server` – Node + Hono ingest and dashboard API.
- `packages/web` – Vite + React + TanStack dashboard.
- `infra` – OpenTofu config and deploy script for the `afk.osv.im` deployment.
- `docs` – architecture, protocol, and extension guides.
- `.github/workflows` – CI (typecheck/lint/format/test/build, plus `infra/`
  validation) on every PR and push to main, and a deploy pipeline to
  `afk.osv.im` on push to main or manual dispatch; see the "CI and deploys"
  section of [infra/README.md](infra/README.md).

## Dev

```bash
pnpm install
pnpm build                                          # dashboard into packages/web/dist, server and shared into their dist/
pnpm dev:server                                     # http://localhost:4141 under tsx watch, serves the built dashboard
AFK_SERVER=http://localhost:4141 ./cli/afk start    # in another terminal; open the URL it prints
```

`pnpm dev:server` runs the TypeScript source through `tsx`; the Docker image runs the
compiled output instead (`pnpm --filter @afk/server start`, i.e.
`node --conditions=afk-compiled dist/index.js`, is the same entrypoint locally).

The dashboard follows an active session live over server-sent events and shows the
whole trace once it ends. To iterate on the UI without rebuilding, run `pnpm dev:web`
(Vite on http://localhost:5173, proxying `/api` to the server) and start the client with
`AFK_PUBLIC_BASE_URL=http://localhost:5173` so the printed URL opens there.

Watch a session's frames arrive as server-sent events (works in a browser tab or curl):

```bash
curl -N http://localhost:4141/api/sessions/<sessionId>/stream
```

Reconnect where you left off with `-H 'Last-Event-ID: <index>'` or `?after=<index>`.
`GET /api/sessions/<sessionId>/frames?after=<index>` returns the same data as one JSON document.
