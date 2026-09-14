import { createMiddleware } from "hono/factory";
import { log } from "../log/logger.ts";

/** A request whose response took at least this long to produce is logged at `info`. */
export const SLOW_REQUEST_MS = 1_000;

export interface RequestTimingOptions {
  /** Monotonic clock in milliseconds; injectable so a test can pin the duration. */
  now?: () => number;
}

/**
 * One line per request, `method= path= status= ms=`: "slow request" at `info` from
 * `SLOW_REQUEST_MS`, "request" at `debug` below it, so a slow read shows in the default
 * log without a line for every health check and dashboard poll. The path carries no
 * query string. The time is until the handler produced its response, which for the SSE
 * route means the headers, not the end of the stream; a cold session's load from
 * storage happens before either, so it is inside the measurement. Mounted first in
 * app.ts so every other middleware is too.
 *
 * Why: when a dashboard URL took 40 s to load on 2026-09-14, the container log had
 * nothing about it, because the read routes log nothing; the only trace was a bump in
 * the Lightsail CPU and memory metrics.
 */
export function requestTiming(options: RequestTimingOptions = {}) {
  const now = options.now ?? (() => performance.now());
  return createMiddleware(async (c, next) => {
    const started = now();
    try {
      await next();
    } catch (err) {
      // Hono turns an Error thrown by a handler into a response before it reaches
      // here; anything else is still in flight as an exception, so it is a 500.
      logRequest(c.req.method, c.req.path, 500, now() - started);
      throw err;
    }
    logRequest(c.req.method, c.req.path, c.res.status, now() - started);
  });
}

function logRequest(method: string, path: string, status: number, elapsedMs: number): void {
  const ms = Math.round(elapsedMs);
  const context = { method, path, status, ms };
  if (ms >= SLOW_REQUEST_MS) {
    log.info("slow request", context);
  } else {
    log.debug("request", context);
  }
}
