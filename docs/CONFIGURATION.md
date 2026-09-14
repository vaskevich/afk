# Configuration

Every server tunable is an `AFK_*` environment variable, parsed and validated once at
startup by `packages/server/src/config.ts` (`loadConfig`). Nothing else in the server
reads `process.env`. A bad value stops the server before it listens, with one line per
problem naming the variable:

```
invalid configuration:
  AFK_PORT: expected a whole number between 1 and 65535, got "abc"
  AFK_S3_BUCKET: required when AFK_STORAGE=s3
```

An empty value counts as unset. On a successful start the server logs the effective
settings on one line (`describeConfig`); credentials are never printed.

The schema in `config.ts` is the source of truth for this table; change them together.
Each default is owned by the module that uses it (for example `DEFAULT_LIMITS` in
`env.ts`, `DEFAULT_STORE_OPTIONS` in `store/sessions.ts`) and the schema references it,
so the numbers below are the numbers the code uses.

## Server

| Variable              | Default                   | Meaning                                                                    | Notes                                                                                                                                         |
| --------------------- | ------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `AFK_PORT`            | `4141`                    | TCP port to listen on.                                                     | 1–65535.                                                                                                                                      |
| `AFK_PUBLIC_BASE_URL` | `http://localhost:<port>` | Public origin used to build the dashboard URLs the client prints.          | Production sets `https://afk.osv.im`. For UI work against the Vite dev server, set `http://localhost:5173` so printed URLs open there.        |
| `AFK_WEB_DIST`        | `packages/web/dist`       | Absolute path to the built dashboard the server serves.                    | Resolved relative to `config.ts` when unset, which is why the Dockerfile keeps the same `packages/` layout.                                   |
| `AFK_CLIENT_SCRIPT`   | `cli/afk`                 | Absolute path to the client script served at `/cli/afk` and by `/install`. | Resolved relative to `config.ts` when unset; the Dockerfile copies `cli/afk` to that layout. Both routes answer 404 when the file is missing. |

## Storage

| Variable                   | Default                | Meaning                                        | Notes                                                                                                                                                        |
| -------------------------- | ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AFK_STORAGE`              | `disk`                 | Session storage backend: `disk` or `s3`.       | `disk` for local dev and self-hosting; `s3` for Lightsail object storage, real S3, or MinIO. See "Adding a storage backend" in [EXTENDING.md](EXTENDING.md). |
| `AFK_DATA_DIR`             | `packages/server/data` | Directory holding `sessions/<id>/` for `disk`. | Only read when `AFK_STORAGE=disk`.                                                                                                                           |
| `AFK_S3_BUCKET`            | —                      | Bucket name.                                   | Required when `AFK_STORAGE=s3`.                                                                                                                              |
| `AFK_S3_REGION`            | —                      | Bucket region, e.g. `us-west-2`.               | Required when `AFK_STORAGE=s3`.                                                                                                                              |
| `AFK_S3_ENDPOINT`          | unset                  | Custom endpoint for an S3-compatible store.    | Only for MinIO and other self-hosted stores; setting it also switches to path-style addressing. Lightsail buckets and real S3 leave it unset.                |
| `AFK_S3_ACCESS_KEY_ID`     | —                      | Access key id for the bucket.                  | Required when `AFK_STORAGE=s3`. Secret; never logged.                                                                                                        |
| `AFK_S3_SECRET_ACCESS_KEY` | —                      | Secret access key for the bucket.              | Required when `AFK_STORAGE=s3`. Secret; never logged.                                                                                                        |

## Sessions and limits

| Variable                           | Default | Meaning                                                      | Notes                                                                                                                                                                                                  |
| ---------------------------------- | ------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AFK_MAX_ACTIVE_SESSIONS`          | `20`    | How many sessions may be accepting frames at once.           | Creating a session past this returns 503 with `Retry-After`. Sized with `AFK_MAX_STREAMS_PER_SESSION` for the smallest Lightsail node; see "Admission control" in [ARCHITECTURE.md](ARCHITECTURE.md).  |
| `AFK_MAX_STREAMS_PER_SESSION`      | `10`    | How many streams (timeline rows) one session may accumulate. | A batch that would add one more returns 422; `afk run` then runs the command without telemetry.                                                                                                        |
| `AFK_MAX_FRAMES_PER_SESSION`       | `15000` | Hard ceiling on stored frames per session.                   | About four hours of one 1 Hz stream, or the one-hour cap with several streams. A batch past it returns 410 and the client stops; without it one session could exhaust the node's memory.               |
| `AFK_MAX_SESSION_DURATION_SECONDS` | `3600`  | Server-owned cap on how long a session accepts frames.       | Stamped on each session at create and returned to the client as `maxDurationSeconds`. `DEFAULT_MAX_SESSION_DURATION_SECONDS` in `packages/shared` is the documented default a client may fall back to. |

## Retention

| Variable                     | Default | Meaning                                                          | Notes                                                                                                                                                                                                                 |
| ---------------------------- | ------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AFK_RETENTION_DAYS`         | `7`     | How long a session's data is kept after it ends before deletion. | A session that never received an explicit end counts as ended when it hit its cap. Active sessions are never deleted. `0` deletes on the next sweep after a session ends. Runs on every backend (`store/sweeper.ts`). |
| `AFK_SWEEP_INTERVAL_SECONDS` | `3600`  | How often the retention sweeper runs.                            | The first sweep runs 10 s after startup. Runs never overlap. Each run logs `[sweeper] scanned N sessions, deleted M`.                                                                                                 |

## Internals

Rarely worth changing; exposed so a self-hoster can tune them without a code change.

| Variable                        | Default | Meaning                                                                                          | Notes                                                                                                              |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `AFK_TICK_INTERVAL_SECONDS`     | `5`     | How often time-based rules (`client.stale`) run and idle ended sessions are evicted from memory. | `SessionStore.startTicker`.                                                                                        |
| `AFK_EVICT_ENDED_AFTER_SECONDS` | `600`   | How long an ended session with no viewers stays in the memory cache.                             | Evicted sessions are reloaded from storage on the next request. `0` evicts on the next tick.                       |
| `AFK_SSE_KEEPALIVE_SECONDS`     | `15`    | Interval between `: keepalive` comments on an SSE stream.                                        | Keeps proxies and browsers from closing an idle stream; the Lightsail load balancer is the reason for the default. |

## Client versions

See [VERSIONING.md](VERSIONING.md) for the policy. Clients below either floor get `426 Upgrade Required`.

| Variable                   | Default                                  | Meaning                                                                    | Notes                                                                                                            |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `AFK_MIN_CLIENT_VERSION`   | `MIN_CLIENT_VERSION` in shared (`0.1.0`) | Oldest client release (`X-Afk-Client: bash/<semver>`) this server accepts. | Raise only to retire a release with known-bad behaviour, never just because a newer client exists.               |
| `AFK_MIN_PROTOCOL_VERSION` | `MIN_PROTOCOL_VERSION` in shared (`1`)   | Oldest protocol version accepted in the create request.                    | Can only be raised; the shared schema already rejects anything below the shared floor, up to `PROTOCOL_VERSION`. |

## Not configurable yet

- **Log level.** The server logs with `console.log` directly and has no logger to
  thread a level through, so there is no `AFK_LOG_LEVEL`. Add one together with a
  logger module if debug output is ever needed.

## Client

The bash client reads `AFK_SERVER` (the server origin) and `AFK_HOME` (its spool
directory, default `~/.afk`). The `AFK_SERVER` default is `https://afk.osv.im` in the
repo; a copy installed with `curl -fsSL <origin>/install | sh` defaults to the `<origin>`
it was installed from, so a self-hosted server's users set nothing. Everything else the
client needs, such as the session cap, comes from the server's create response. The
remaining client knobs are documented in the script's own header: `AFK_SPOOL_MAX_BYTES`,
`AFK_NO_QR`, `AFK_RUN_TAIL_LINES`, and `AFK_RUN_CAPTURE_MAX_BYTES` (the chunk size, 64 MiB
by default, of the wrapped command's output `afk run` keeps on disk while it runs).

The installer itself reads `AFK_INSTALL_DIR` (where to put `afk`, default `~/.local/bin`).

## Production

`infra/deploy.sh` sets `AFK_PORT`, `AFK_PUBLIC_BASE_URL`, `AFK_STORAGE=s3`, and the four
`AFK_S3_*` variables in the container deployment spec (see [infra/README.md](../infra/README.md));
everything else runs on its default. Add a variable there only when production needs a
non-default value.
