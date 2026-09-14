# afk

Away-from-keyboard telemetry. Run `afk start` on a machine you are about to walk away
from and get a shareable dashboard URL that shows whether everything is still fine.

Status: early prototype. See [BACKLOG.md](BACKLOG.md).

## Layout

- `cli/afk` – the client. One bash script, macOS only for now.
- `packages/shared` – Zod schemas for the wire protocol; types are inferred from them.
- `packages/server` – Node + Hono ingest and dashboard API.
- `packages/web` – Vite + React + TanStack dashboard.
- `infra` – OpenTofu config and deploy script for the `afk.osv.im` deployment.

## Dev

```bash
pnpm install
pnpm dev:server                                     # http://localhost:4141
AFK_SERVER=http://localhost:4141 ./cli/afk start    # in another terminal
```

Watch a session's frames arrive as server-sent events (works in a browser tab or curl):

```bash
curl -N http://localhost:4141/api/sessions/<sessionId>/stream
```

Reconnect where you left off with `-H 'Last-Event-ID: <index>'` or `?after=<index>`.
`GET /api/sessions/<sessionId>/frames?after=<index>` returns the same data as one JSON document.
Set `AFK_PUBLIC_BASE_URL=http://localhost:5173` when running the Vite dev server so the
printed dashboard URL opens the web app.
