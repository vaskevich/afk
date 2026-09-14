# Versioning

The principle: **keep existing clients working for as long as possible.** `cli/afk` is a
script people download once and forget about, so the server bends to old clients
rather than the other way round. Two independent numbers make that tractable.

| number               | where                                   | today   | what it describes                                    |
| -------------------- | --------------------------------------- | ------- | ---------------------------------------------------- |
| **protocol version** | `PROTOCOL_VERSION` in `packages/shared` | `1`     | the wire contract: shapes, field meanings, endpoints |
| **client version**   | `AFK_VERSION` in `cli/afk` (semver)     | `0.4.0` | the client implementation                            |

They move independently. A client release almost never bumps the protocol; a protocol
bump always ships with a client release.

## Protocol version

An integer. It is the create request's `protocolVersion` and is the only version the
_wire contract_ has. The server accepts a range, `[MIN_PROTOCOL_VERSION,
PROTOCOL_VERSION]` (both exported from `packages/shared/src/protocol.ts`), and must keep
handling every version in that range explicitly, not just the newest.

**Bump it only for an incompatible change**, meaning a client speaking the old version
would be misread by the new server, or a new server's response would be misread by an
old client:

- a field the client sends is removed, renamed, or its meaning changes;
- a required field is added to something the client sends;
- a response field the client relies on is removed or changes meaning;
- an endpoint the client uses changes its method, path, or status-code contract.

**Additive changes never bump it.** Adding a collector, an optional field, an endpoint,
an event kind, a rule, a response field, or a new `output.flavor` are all additive: an
old client keeps sending what it sent, the server keeps understanding it, and unknown
response fields are ignored by the bash client's `sed`-based extraction. This is why the
version has stayed at 1 while collectors and rules were added.

When version 2 exists, the server does not drop version 1 the same day. It keeps
accepting `MIN_PROTOCOL_VERSION = 1` and translates: a per-version adapter in
`packages/server/src/utils/` (say `protocol-v1.ts`) that maps a v1 create request and
v1 frames onto the current shapes before validation, chosen by the session's recorded
`protocolVersion`. `MIN_PROTOCOL_VERSION` only moves up once no active clients speak the
old version any more (the `X-Afk-Client` header in the server log tells you), and that
retirement is itself a deliberate change with a changelog line.

## Client version

A semver string, sent as `clientVersion` in the create request and as
`X-Afk-Client: <name>/<semver>` on every client request (`bash/0.4.0` today). It is the
implementation, not the contract: **bump it on every client release**, whether or not
the protocol changed. Patch for a fix, minor for a new collector or command, major for a
protocol bump or a change in how the script is invoked.

The server has a `MIN_CLIENT_VERSION` (shared constant, overridable with
`AFK_MIN_CLIENT_VERSION`). It exists **only to retire clients with known-bad
behaviour**: a release whose retry loop floods the server, one that sends malformed
frames the schema happens to accept, one with a bug that corrupts its own spool. It is
never raised merely because a newer client exists, and never as a way to force people
onto new features. Raising it is a changelog line that names the bug being retired.

## The rejection contract

A client the server will not talk to gets `426 Upgrade Required` with an
`ErrorResponse` whose `details` is:

```json
{
  "error": "client version 0.0.9 is below the minimum 0.1.0",
  "details": {
    "minimumClientVersion": "0.1.0",
    "minimumProtocolVersion": 1,
    "yourVersion": "0.0.9"
  }
}
```

`details` always has these three fields, whichever check failed, so a client prints the
same message either way. `yourVersion` is what the `X-Afk-Client` header said, or `null`
when it was missing or unparsable (which is also a 426: every real client sends it).

Where it is enforced (`packages/server/src/middleware/client-version.ts`):

- `POST /api/sessions` (create): the header is checked, and `protocolVersion` in the
  body must be within the accepted range. An out-of-range protocol version is a 426 with
  the same `details`, not a schema 400, so an old client sees the upgrade message rather
  than "invalid request".
- `POST /api/sessions/:id/frames` and `POST /api/sessions/:id/end`: the header is
  checked. A client that was fine when it created its session but is retired mid-session
  gets a 426 on its next batch.
- Dashboard reads (`GET` anything) are never version-checked. Browsers send no header.

Client behaviour: on 426 from create, print the server's message, both minimums, and how
to update, then exit 1 (no capacity-style retry, the answer will not change). On 426 from
frames, treat it as a 410: stop the session, keep the spooled batches, print the upgrade
hint. See the status table in [PROTOCOL.md](PROTOCOL.md).

Both minimums are configurable per deployment: `AFK_MIN_CLIENT_VERSION` and
`AFK_MIN_PROTOCOL_VERSION` in the server environment, with the shared constants as
defaults. A self-hosted server that only ever talks to one machine can leave them alone.

## The latest client

The minimum is a floor; the **latest** is what a server ships. Every server serves a
client at `GET /cli/afk` (the `cli/afk` file at `AFK_CLIENT_SCRIPT`, installed by
`GET /install`), and "latest" means exactly that file's `AFK_VERSION` line: the copy a
`curl -fsSL <origin>/install | sh` against this server would install, nothing more
global. The server reads the line once at startup and reports it in two places:

- `GET /versionz` and `GET /api/version`, as `client.version` (null when the server has
  no client script), which `afk version --check` prints next to the running copy's own;
- the session create response, as `latestClientVersion` (omitted without a client
  script), so a client learns it is behind on the request it makes anyway.

The client compares that to its own `AFK_VERSION` (numerically, part by part;
`version_lt` in `cli/afk`) and, when it is behind, prints
`afk 0.3.0 is available (this is 0.2.0). Update with: curl -fsSL <server>/install | sh`
on stderr. `afk start` on a terminal (stdin and stderr both ttys, and
`AFK_NO_UPDATE_PROMPT` not `1`) also asks `update now? [y/N]`, waits ten seconds, and
on `y` runs that installer over the running copy's own directory (or
`AFK_INSTALL_DIR`). The session it just created is never disturbed: the process keeps
running the code it loaded and the new copy is picked up by the next `afk start`, a
declined, timed-out, or failed update is one log line, and neither a pipe nor an
`afk run` (whose command is about to get stdin) is ever asked. `afk update` runs the
same installer on demand. None of this is enforcement: a client that is behind keeps
working until it is below the minimum, which is the 426 above and nothing else.

The release side is unchanged by this: bumping `AFK_VERSION` in `cli/afk` and deploying
the server _is_ publishing a new latest, since the server serves the file from its own
checkout or image. A deployment whose `AFK_CLIENT_SCRIPT` points elsewhere publishes
whatever that file says. There is no separate registry of versions to update.

## What a bump requires

| change                                         | protocol | client | also                                                                                     |
| ---------------------------------------------- | -------- | ------ | ---------------------------------------------------------------------------------------- |
| new collector (`processes`, `agents`)          |          | minor  | PROTOCOL.md section, shared union, dashboard registry entry                              |
| new optional field on a frame                  |          | minor  | PROTOCOL.md field table                                                                  |
| new `run` output flavor                        |          | minor  | PROTOCOL.md, `RunOutput` union                                                           |
| new endpoint, new event kind, new rule         |          |        | PROTOCOL.md; no client change unless the client uses it                                  |
| new response field on create or ingest         |          |        | PROTOCOL.md; old clients ignore it                                                       |
| client bug fix, no wire change                 |          | patch  | changelog line                                                                           |
| rename `timestamp` to `sampledAt` on a frame   | **bump** | major  | everything in the checklist below                                                        |
| `sequence` becomes per-session, not per-stream | **bump** | major  | meaning changed: old clients would be de-duplicated wrongly                              |
| create request gains a required `machineId`    | **bump** | major  | old clients cannot produce it                                                            |
| retire client `0.1.0` for a flooding bug       |          |        | raise `MIN_CLIENT_VERSION`, changelog line naming the bug, PROTOCOL.md status table note |

Every client release: bump `AFK_VERSION`, add a changelog line (the commit message is
the changelog until there is a `CHANGELOG.md`), and make sure `afk version` prints it.
Deploying the server then makes that version the latest every older client is told
about (see "The latest client" above), so a bump that is not meant to reach users yet
should not be merged to main.

Every protocol change, incompatible or not: update [PROTOCOL.md](PROTOCOL.md) in the
same commit as `packages/shared/src/protocol.ts`, and add or update a schema test.

## Checklist for a protocol bump

Incompatible changes are rare and expensive; the list is meant to make that felt.

1. Write down why the change cannot be made additively. If it can, make it additively.
2. `packages/shared/src/protocol.ts`: `PROTOCOL_VERSION = N`. Leave
   `MIN_PROTOCOL_VERSION` where it is.
3. Make the server accept both: add `packages/server/src/utils/protocol-v<N-1>.ts` that
   maps old-shape requests onto the new shapes, select it by the session's
   `protocolVersion`, and record `protocolVersion` on the session if it is not already.
   Tests for the adapter, and a route test that a v<N-1> create and ingest still succeed.
4. `cli/afk`: `AFK_PROTOCOL_VERSION=N`, the new shapes, and a **major** `AFK_VERSION`
   bump.
5. [PROTOCOL.md](PROTOCOL.md): the version at the top, every changed section, and a
   short "changes from version N-1" note at the bottom of the doc.
6. [ARCHITECTURE.md](ARCHITECTURE.md) decision log entry: what changed, why it could not
   be additive.
7. Changelog line for the client release.
8. Deploy the server **before** publishing the client; the server accepts both, the new
   client speaks only the new version.
9. Later, when the log shows no more v<N-1> clients: raise `MIN_PROTOCOL_VERSION`,
   delete the adapter and its tests, and add a changelog line for the retirement.
