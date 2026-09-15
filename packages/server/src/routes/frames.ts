import { Hono } from "hono";
import type { IngestResponse } from "@afk/shared";
import type { AppDeps, AppEnv } from "../env.ts";
import { errorResponse } from "../http/errors.ts";
import { limitBody } from "../middleware/body-limit.ts";
import { clientVersion } from "../middleware/client-version.ts";
import { ingestAuth } from "../middleware/ingest-auth.ts";
import {
  TooManyBytesError,
  TooManyFramesError,
  type IngestResult,
  type Session,
} from "../store/sessions.ts";
import { parseFrames } from "../utils/ndjson.ts";
import { describeFrame } from "../log/describe.ts";
import { log } from "../log/logger.ts";

/** How often one live session's ingest is summarized at `info`. */
export const INGEST_SUMMARY_INTERVAL_MS = 60_000;

/** What a session has ingested since its last summary line. */
interface IngestSummary {
  /** When the current window opened: the first batch, or the last line logged. */
  windowStartedAtMs: number;
  frames: number;
  duplicates: number;
  streams: Set<string>;
}

/**
 * Keyed by the session object rather than its id, so an entry is collected along with
 * the session when the store evicts it and there is nothing here to prune.
 */
const ingestSummaries = new WeakMap<Session, IngestSummary>();

/**
 * What the log says about ingest. Every batch is a `debug` line, as is every accepted
 * frame; at `info` a session gets one summary line at most every
 * `INGEST_SUMMARY_INTERVAL_MS`, so an operator watching the default level sees each live
 * session tick over without a line a second per session (ten of them at the 1 Hz send
 * interval used to be tens of thousands of lines an hour, which buried everything else).
 * The counts are since the last summary; `total` is the session's running total. The
 * `afk run` command line is logged at no level: it is typed by the user and, redaction
 * notwithstanding, can carry a secret, and the run's stream id in `describeFrame` is
 * enough to find it.
 */
function logBatch(session: Session, result: IngestResult, nowMs = Date.now()): void {
  const sessionId = session.sessionId;
  const streams = new Set(result.accepted.map((stored) => stored.frame.stream));
  log.debug("accepted batch", {
    session: sessionId,
    streams: [...streams].join(","),
    accepted: result.accepted.length,
    duplicates: result.duplicates,
    ...(result.rejectedStreams.length > 0 ? { rejected: result.rejectedStreams.join(",") } : {}),
  });
  if (log.enabled("debug")) {
    for (const { frame } of result.accepted) {
      log.debug(describeFrame(frame), { session: sessionId });
    }
  }
  summarizeIngest(session, result, streams, nowMs);
}

function summarizeIngest(
  session: Session,
  result: IngestResult,
  batchStreams: ReadonlySet<string>,
  nowMs: number,
): void {
  let summary = ingestSummaries.get(session);
  if (!summary) {
    // The first batch opens the window rather than logging: `session created` has just
    // said this session exists, and the summary is worth reading once it has counts.
    summary = { windowStartedAtMs: nowMs, frames: 0, duplicates: 0, streams: new Set() };
    ingestSummaries.set(session, summary);
  }
  summary.frames += result.accepted.length;
  summary.duplicates += result.duplicates;
  for (const stream of batchStreams) {
    summary.streams.add(stream);
  }

  const elapsedMs = nowMs - summary.windowStartedAtMs;
  if (elapsedMs < INGEST_SUMMARY_INTERVAL_MS) {
    return;
  }
  log.info("session ingesting", {
    session: session.sessionId,
    streams: [...summary.streams].join(","),
    frames: summary.frames,
    duplicates: summary.duplicates,
    total: session.frames.length,
    seconds: Math.round(elapsedMs / 1000),
  });
  summary.windowStartedAtMs = nowMs;
  summary.frames = 0;
  summary.duplicates = 0;
  summary.streams.clear();
}

/**
 * Largest ingest body accepted. The client's sender ships at most
 * SEND_MAX_FILES_PER_BATCH (200) queue files per request, and each file is what its
 * sampler wrote in one SEND_INTERVAL_SECONDS (1 s) rotation: one system frame (about
 * 350 bytes) plus, for an `afk run`, one run frame (about 300 bytes), since a joiner
 * keeps its own spool and sender. So a full batch is roughly 200 x 650 bytes = 130 KB,
 * and 1 MiB is about eight times that, with room for a couple more collectors at 1 Hz
 * before the limit is felt. A queue that has grown past 200 files while the server was
 * unreachable is drained in successive batches, not one big one.
 */
export const MAX_INGEST_BODY_BYTES = 1024 * 1024;

/** Frame ingest. Mounted at /api/sessions. Body is newline-delimited JSON, one frame per line. */
export function frameRoutes(deps: AppDeps) {
  const { store } = deps;

  // Auth before the body limit so an ended session answers 410 (stop) rather than a 413
  // the client would park; the limit checks Content-Length before reading anything.
  return new Hono<AppEnv>().post(
    "/:sessionId/frames",
    clientVersion(deps),
    ingestAuth(deps),
    limitBody(MAX_INGEST_BODY_BYTES),
    async (c) => {
      const session = c.get("session");

      const parsed = parseFrames(await c.req.text());
      if (!parsed.ok) {
        return errorResponse(c, 400, parsed.message, parsed.details);
      }

      let result;
      try {
        result = await store.ingest(session, parsed.frames);
      } catch (err) {
        if (err instanceof TooManyFramesError || err instanceof TooManyBytesError) {
          // 410: the session is full (by count or by size) and will accept nothing
          // more, so the client stops or chains, exactly as for an ended session.
          return errorResponse(c, 410, err.message, { limit: err.limit });
        }
        throw err;
      }
      const { rejectedStreams } = result;
      if (rejectedStreams.length > 0 && result.accepted.length === 0 && result.duplicates === 0) {
        // Every frame belongs to a stream the session has no room for (an `afk run`'s
        // first batch, whose stream is new): 422 rather than 4xx-generic so the client
        // knows the batch was well formed, and nothing of it was kept. A batch that also
        // carried known streams is a 200 below, with the rejected ones named.
        const stream = rejectedStreams[0]!;
        const limit = deps.config.limits.maxStreamsPerSession;
        return errorResponse(
          c,
          422,
          `stream "${stream}" would exceed the limit of ${limit} streams per session`,
          { stream, limit },
        );
      }
      logBatch(session, result);
      const body: IngestResponse = {
        accepted: result.accepted.length,
        duplicates: result.duplicates,
        latestSequence: Object.fromEntries(session.latestSequence),
        ...(rejectedStreams.length > 0 ? { rejectedStreams } : {}),
      };
      return c.json(body);
    },
  );
}
