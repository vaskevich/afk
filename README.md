# afk

Away-from-keyboard telemetry. Run `afk start` on a machine you are about to walk away
from and get a shareable dashboard URL that shows whether everything is still fine.

Status: early prototype. See [BACKLOG.md](BACKLOG.md).

## Layout

- `cli/afk` – the client. One bash script, macOS only for now.
- `packages/shared` – Zod schemas for the wire protocol; types are inferred from them.
- `packages/server` – Node + Hono ingest and dashboard API.
- `packages/web` – dashboard (not started yet).

## Dev

```bash
pnpm install
pnpm dev:server                                     # http://localhost:4141
AFK_SERVER=http://localhost:4141 ./cli/afk start    # in another terminal
```
