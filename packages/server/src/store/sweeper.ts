import { log } from "../log/logger.ts";
import { SessionStore, sessionEndMs, sessionStatus } from "./sessions.ts";
import type { SessionStorage } from "./storage.ts";

/**
 * Retention. Sessions are deleted `retention` after they end; a session that never
 * received an explicit end counts as ended the moment it hit its cap. Lightsail buckets
 * have no lifecycle rules, so the server owns this for every backend rather than
 * relying on the store to expire objects.
 *
 * The same pass compacts, on a backend that can (`SessionStorage.compactSession`),
 * every over session it keeps: `SessionStore.end` compacts in the background, but a
 * session that expired without an end (the server restarted before the silence rule
 * fired, or the client hit the cap without chaining) never went through `end`, and a
 * compaction at end can fail. When there is nothing to do the call is one listing.
 */

export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** The first sweep runs this long after startup so it never competes with boot. */
export const DEFAULT_SWEEP_STARTUP_DELAY_MS = 10_000;

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SweepResult {
  /** Session ids storage listed. */
  scanned: number;
  /** Sessions whose data was deleted this run. */
  deleted: number;
  /** Over sessions, kept, that storage rewrote into its compact shape this run. */
  compacted: number;
}

/**
 * One pass over every stored session: deletes those that ended (explicitly, or by
 * hitting their cap) more than `retentionMs` before `now`, and evicts them from the
 * store's memory cache; compacts the over ones it keeps when storage can. Active
 * sessions are never touched. A read, delete, or compaction that fails for one
 * session is logged and does not stop the others.
 */
export async function sweepExpiredSessions(
  storage: SessionStorage,
  store: SessionStore,
  now: number,
  retentionMs: number,
): Promise<SweepResult> {
  const sessionIds = await storage.listSessionIds();
  let deleted = 0;
  let compacted = 0;
  for (const sessionId of sessionIds) {
    try {
      const record = await storage.getSession(sessionId);
      if (!record || sessionStatus(record, now) === "active") {
        continue;
      }
      if (now < sessionEndMs(record) + retentionMs) {
        if (await compactIfPossible(storage, sessionId)) {
          compacted++;
        }
        continue;
      }
      await storage.deleteSession(sessionId);
      store.evict(sessionId);
      deleted++;
    } catch (err) {
      log.error("sweeper could not sweep a session", {
        session: sessionId,
        error: describeError(err),
      });
    }
  }
  return { scanned: sessionIds.length, deleted, compacted };
}

/** Compacts the session if storage can; a failure is a warning (the next run retries). */
async function compactIfPossible(storage: SessionStorage, sessionId: string): Promise<boolean> {
  if (!storage.compactSession) {
    return false;
  }
  try {
    return await storage.compactSession(sessionId);
  } catch (err) {
    log.warn("sweeper could not compact a session", {
      session: sessionId,
      error: describeError(err),
    });
    return false;
  }
}

export interface SweeperOptions {
  storage: SessionStorage;
  store: SessionStore;
  retentionMs: number;
  intervalMs?: number;
  startupDelayMs?: number;
}

/**
 * Runs `sweepExpiredSessions` once shortly after startup and then every `intervalMs`,
 * skipping a tick if the previous run is still going. Logs one line per run. Returns a
 * function that stops it.
 */
export function startSweeper(options: SweeperOptions): () => void {
  const {
    storage,
    store,
    retentionMs,
    intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    startupDelayMs = DEFAULT_SWEEP_STARTUP_DELAY_MS,
  } = options;
  let running = false;
  let interval: NodeJS.Timeout | undefined;

  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await sweepExpiredSessions(storage, store, Date.now(), retentionMs);
      log.info("sweeper ran", {
        scanned: result.scanned,
        deleted: result.deleted,
        compacted: result.compacted,
        retentionDays: retentionMs / MS_PER_DAY,
      });
    } catch (err) {
      log.error("sweeper run failed", { error: describeError(err) });
    } finally {
      running = false;
    }
  };

  const startup = setTimeout(() => {
    void run();
    interval = setInterval(() => void run(), intervalMs);
  }, startupDelayMs);

  return () => {
    clearTimeout(startup);
    if (interval) {
      clearInterval(interval);
    }
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
