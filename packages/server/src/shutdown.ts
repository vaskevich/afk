/**
 * Graceful shutdown. A deploy replaces the container by sending SIGTERM; without a
 * handler node dies mid-batch (a half-written append) and every open SSE stream is
 * reset without so much as a log line. `shutdown` runs the steps in the order that
 * loses the least:
 *
 *   1. stop the ticker and the sweeper, so no new periodic work starts;
 *   2. stop accepting connections and drop idle keep-alive ones;
 *   3. wait for every in-memory session's write queue to drain, so no batch that
 *      was accepted is left half-written, then flush what storage still buffers
 *      (the bucket backend's slabs), so nothing accepted is lost to the restart;
 *   4. close whatever connections remain (SSE streams end here; the dashboard
 *      reconnects with Last-Event-ID) and wait for the server to close;
 *   5. exit 0.
 *
 * A hard exit after `SHUTDOWN_TIMEOUT_MS` (exit code 1, with an error line) means a
 * stuck storage write cannot hang a deploy; the orchestrator would SIGKILL us anyway,
 * but this way the log says why. Signals are wired in `index.ts` through
 * `handleSignals`; `shutdown` itself takes everything it touches as an argument so
 * the tests can run it with an in-memory store and fake timers, no signals needed.
 */
import { log } from "./log/logger.ts";
import type { SessionStore } from "./store/sessions.ts";

/** How long a shutdown may take before the process exits regardless. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export const EXIT_CODE_CLEAN = 0;
/** A drain or close did not finish within the timeout, or a second signal arrived. */
export const EXIT_CODE_FORCED = 1;

export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * The parts of `node:http`'s Server that shutdown uses; `@hono/node-server`'s `serve`
 * returns one. The connection-closing methods are optional because a server type that
 * lacks them (HTTP/2) still closes, just without cutting long-lived streams short.
 */
export interface ClosableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export interface ShutdownDeps {
  server: ClosableServer;
  store: SessionStore;
  /** What `SessionStore.startTicker` returned. */
  stopTicker: () => void;
  /** What `startSweeper` returned. */
  stopSweeper: () => void;
  timeoutMs?: number;
  /** `process.exit` in production; a spy in tests. */
  exit?: (code: number) => void;
}

/** Resolves once the server has closed; an error (already closed) is not worth failing a shutdown for. */
async function closeServer(server: ClosableServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Runs the shutdown sequence to completion and exits. Resolves after `exit` has been called. */
export async function shutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  const { server, store, stopTicker, stopSweeper } = deps;
  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = deps.exit ?? process.exit;
  const startedAt = Date.now();
  log.info("shutting down", { signal, timeoutMs });

  // Not unref'd on purpose: if a stuck drain is the only thing keeping the loop alive,
  // this is what ends the process, with a line saying so.
  const deadline = setTimeout(() => {
    log.error("shutdown timed out, exiting anyway", { signal, timeoutMs });
    exit(EXIT_CODE_FORCED);
  }, timeoutMs);

  stopTicker();
  stopSweeper();

  const closed = closeServer(server);
  server.closeIdleConnections?.();

  const { sessionsInMemory: sessions } = store.stats();
  await store.drainWrites();
  try {
    await store.flushStorage();
  } catch (err) {
    // What did not flush stays in the bucket as the last slab written; the session
    // reads short of those frames. Still worth closing cleanly.
    log.error("storage flush failed", {
      signal,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  log.info("writes drained", { sessions });

  // Ends SSE streams and any request still open; the dashboard reconnects on its own.
  server.closeAllConnections?.();
  await closed;

  clearTimeout(deadline);
  log.info("shutdown complete", { signal, elapsedMs: Date.now() - startedAt });
  exit(EXIT_CODE_CLEAN);
}

/**
 * Runs `shutdown` on the first SIGTERM or SIGINT. A second signal while the first is
 * still being handled exits at once: someone pressing Ctrl-C twice wants out now.
 */
export function handleSignals(deps: ShutdownDeps): void {
  const exit = deps.exit ?? process.exit;
  let shuttingDown = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (shuttingDown) {
        log.warn("second signal, exiting now", { signal });
        exit(EXIT_CODE_FORCED);
        return;
      }
      shuttingDown = true;
      void shutdown(signal, deps);
    });
  }
}
