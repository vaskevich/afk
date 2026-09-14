# Product recommendations

## Executive summary

1. The hard parts exist: resilient client, server-side rules, live dashboard. Missing: the path from "heard about it" to "URL on my phone", and a page that answers "should I come back?" first.
2. P0: an installer, a QR code, a verdict-first session page, a plain statement of what leaves the machine, and sessions that survive the one-hour cap; the founder's own scenario is "come back an hour later".
3. P1 turns glancing into being told: notifications on critical events, a failing command's last output, and links that carry the verdict and the moment.
4. P2 is the second day: finding yesterday's session and a one-command self-host.
5. Not yet: the agents collector, accounts, and a client rewrite.

## P0: before telling anyone

### 1. Install in one line, and say so on the landing page

- **Moment.** A developer reads README.md, sees `pnpm install`, `pnpm build`, `pnpm dev:server`, assumes they must run a server, and leaves.
- **Build.** `curl -fsSL https://afk.osv.im/install | sh` that puts `cli/afk` in `~/.local/bin`, served by the server (`routes/web.ts`); the open BACKLOG.md item. Make `packages/web/src/routes/LandingPage.tsx` lead with that line and `afk start`; move the service stats below.
- **Why.** docs/CLIENT.md chose bash for "curl the file" distribution; nothing uses it yet. A Homebrew tap adds a release pipeline for no gain.
- **Size.** S.

### 2. Put the URL on the phone without typing it

- **Moment.** `cmd_start` in `cli/afk` prints a 22-character URL; the user is at the laptop and has to get it onto a phone.
- **Build.** `GET /api/sessions/:id/qr` renders the dashboard URL as a Unicode-block QR (the `qrcode` package); the client prints it under the URL and copies the URL with `pbcopy`.
- **Why.** Fits "dumb client, smart server" (docs/ARCHITECTURE.md) and bash 3.2, which has no QR library. Handoff and AirDrop are browser- and phone-specific.
- **Size.** S.

### 3. Make the session page answer "should I come back?" first

- **Moment.** On a phone, `SessionPage.tsx` renders host facts (`SessionHeader.tsx`) above the verdict, and a running `afk run` command with no anomaly shows only in `DetailsPanel`, below the timeline.
- **Build.** Move `StatusBanner` to the top and extend it with freshness ("updated 3 s ago" or the stale warning), one line per `run` stream (command, elapsed, running or exit code, seconds since last output), and cpu and memory pressure at the live edge. Set `document.title` to the verdict (`index.html` is a static "afk"). Collapse host facts to one line.
- **Why.** This is the founder's two-second read; the timeline answers "what happened". Events alone miss the most common state: fine and still running.
- **Size.** M.

### 4. State what leaves the machine, redact the obvious, let the owner delete

- **Moment.** `afk run -- psql postgres://me:hunter2@host/db` stores the password in `command` (docs/PROTOCOL.md) on the hosted server for seven days (`AFK_RETENTION_DAYS`, docs/CONFIGURATION.md), on a page with no read auth.
- **Build.** A "what is sent" section in README.md and on the landing page: the docs/PROTOCOL.md fields, retention, and that the id is the secret. Client-side redaction of URL userinfo and `KEY=value` arguments in `command`. `DELETE /api/sessions/:id` with the ingest token, plus `afk delete <id>`.
- **Why.** The unguessable-id model is fine for a hosted MVP if stated; read auth would cost the zero-friction share link.
- **Size.** S each.

### 5. Chain sessions past the one-hour cap

- **Moment.** The founder leaves for "an hour"; `system_sampler_loop` in `cli/afk` stops at `maxDurationSeconds` (3600), so the second hour is unmonitored and a still-running `afk run` loses its row.
- **Build.** The open BACKLOG.md "auto-chain" item, plus `previousSessionId` and `nextSessionId` on the session record so the dashboard links to the continuation and the first URL redirects to the live session, keeping one QR valid for the whole absence.
- **Why.** Raising the cap breaks the memory budget behind admission control (docs/ARCHITECTURE.md); chaining keeps it and keeps traces small.
- **Size.** M.

## P1: next

### 6. Tell the phone instead of waiting to be looked at

- **Moment.** A migration exits 3 at minute 20; the user looks at minute 60 and has lost 40 minutes. The critical `run.exited` (`rules/run.ts`) exists only on the page.
- **Build.** `afk start --notify <url>` (an ntfy.sh topic or any webhook), sent at session create as an optional field (compatible per docs/PROTOCOL.md versioning). The server POSTs when a critical event opens, on `client.stale`, and at session end, with the banner text and the link. Fire from the live ingest path, deduplicated by event id (events are never persisted, `rules/engine.ts`).
- **Why.** ntfy gives iOS and Android push with no app or service worker of our own; a webhook covers Slack.
- **Size.** M.

### 7. Ship the last lines of output when a run fails

- **Moment.** The banner says "command failed with exit code 3 after 41s" and nothing else; the user has to ssh in to learn why.
- **Build.** `cli/afk` already tees stdout and stderr into `runs/<id>/`; put the last 20 lines of each (capped at 4 KB) on the `exited` frame as an optional `outputTail`, shown under the event in `StatusBanner` and in `RunDetails`. `--no-output` opts out.
- **Why.** An exit code without a reason is a dead end; full logs would break the frame budget and the privacy story.
- **Size.** M.

### 8. Links that carry the verdict and the moment

- **Moment.** A session link pasted in Slack unfurls as "afk" (`index.html`); a colleague has to find the anomaly themselves.
- **Build.** `routes/web.ts` injects `<title>` and `og:description` for `/s/:id` ("telesto-ii, ended, 2 anomalies, 48 min"). `?t=<offset>` and `?event=<id>` seed `cursor` and `zoom` in `SessionPage.tsx`; clicking a marker updates them.
- **Why.** The URL is already the unit of sharing; making it carry state is cheaper than any export feature.
- **Size.** S.

## P2: later

### 9. Find yesterday's session

- **Moment.** Second day, the user wants last night's build trace; the URL went with the terminal.
- **Build.** Write `dashboardUrl` and the start time into each `~/.afk/sessions/<id>/`; `afk list` prints the last ten with status, `afk open` opens the latest.
- **Why.** The local state already exists; a server-side list needs accounts.
- **Size.** S.

### 10. One-command self-host

- **Moment.** A team on a private network wants the self-hosted option README.md promises and finds a Dockerfile with no published image.
- **Build.** Push the image to GHCR from CI (`deploy.yml` only pushes to Lightsail), a README section with one `docker run` line (disk storage, a volume, `AFK_PUBLIC_BASE_URL`), and `AFK_INGEST_SECRET` (open in BACKLOG.md).
- **Why.** docs/CONFIGURATION.md already documents every variable; the image and one env var are all that is missing.
- **Size.** S.

## Deliberately not yet

- **Agents collector.** Parked in BACKLOG.md: undocumented tool internals, session names leaving the machine. Its payoff, "an agent has waited on you for 10 minutes", is a notification, so it follows item 6; `afk run -- claude` and the `processes` row cover the rest today.
- **Accounts and a server-side session list.** The unguessable id (docs/PROTOCOL.md) is the whole auth model and keeps time-to-first-value at one command. Item 9 covers the second day locally.
- **A client rewrite or Linux port.** docs/CLIENT.md names the triggers (a Linux port, a second contributor, a thousand lines, a quoting bug); none has fired at 550 lines. The contract test makes a later port safe.

## Implemented

- **2026-09-15, item 1 (install in one line).** `GET /install` on the server returns a
  short POSIX `sh` installer with the server's own origin filled in; it downloads
  `GET /cli/afk` from that origin, installs it to `~/.local/bin/afk` (`AFK_INSTALL_DIR`
  overrides), and rewrites the client's default `AFK_SERVER` to the origin it came from,
  so `curl -fsSL https://afk.osv.im/install | sh` and a self-hosted
  `curl -fsSL http://afk.internal:4141/install | sh` both work with no env var. The
  client's path is `AFK_CLIENT_SCRIPT` (docs/CONFIGURATION.md) and ships in the Docker
  image. `LandingPage.tsx` now leads with the one-liner (copy button, built from
  `window.location.origin`), `afk start` and `afk run`, and the demo link; a "what leaves
  your machine" paragraph (the start of item 4), a note on the demo, and the service
  stats sit behind one collapsed disclosure, remembered in localStorage. New mark and
  favicon: "afk" drawn as strokes with the letters touching and the f's crossbar running
  into the k, `#FFD60A` on `#000000` (`packages/web/public/favicon.svg`, plus 32 px and
  180 px PNGs, and the same glyphs as the page's wordmark). Still open from this
  item: Linux in the installer (the client itself is macOS-only), and the client's
  upgrade hint still points at GitHub rather than `<server>/install`.
- **2026-09-15, item 2 (put the URL on the phone without typing it).**
  `GET /api/sessions/:id/qr` renders the dashboard URL as a half-block QR behind the
  ingest token (`packages/server/src/utils/qr.ts`); `afk start`, and an `afk run` that
  created the session, print it under the URL when stdout is a terminal (`--no-qr` or
  `AFK_NO_QR=1` to skip), and `afk qr` reprints it. The session page has a Share panel
  with the URL, a copy button, and a QR rendered in the browser. `pbcopy` was left out:
  the QR is the phone path and the dashboard's copy button covers the clipboard.
