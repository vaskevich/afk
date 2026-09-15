/**
 * The server's logger. One line per call:
 *
 *   2026-09-15T10:00:00.000Z info  session created session=abc host=mac
 *
 * that is an ISO timestamp, the level padded to a fixed width, the message, and the
 * context appended as `key=value` pairs (values with whitespace, `=`, or quotes are
 * JSON-quoted; undefined values are left out). Lines below the threshold are dropped.
 * `info` and below go to stdout, `warn` and `error` to stderr.
 *
 * No dependency on purpose: the whole thing is a threshold and a formatter, and a
 * library would be more code than this file. The one instance, `log`, is shared by
 * every module; `index.ts` sets its level from `AFK_LOG_LEVEL` (config.ts) before
 * anything else runs. Tests that care about a line spy on `log`, never on `console`.
 *
 * What goes where: `debug` is per-frame detail (the `afk run` command line is logged
 * at no level, see routes/frames.ts); `info` is one line per batch, per session lifecycle
 * step, per anomaly event, and per sweeper run; `warn` is something the server worked
 * around; `error` is something it could not. Session ids appear at `info` on purpose:
 * an operator needs them to find a session, which means logs identify sessions for as
 * long as the log retention lasts (see docs/ARCHITECTURE.md, "Hardening").
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** The widest level name, so the message column lines up across levels. */
const LEVEL_COLUMN_WIDTH = Math.max(...LOG_LEVELS.map((level) => level.length));

/** Values a context entry can hold; anything else is formatted with `String()` by the caller. */
export type LogValue = string | number | boolean | null | undefined;
export type LogContext = Record<string, LogValue>;

/** Where formatted lines go. The default writes by level to stdout or stderr. */
export type LogSink = (level: LogLevel, line: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  /** The clock, injectable so a test can pin the timestamp. */
  now?: () => Date;
}

const STDERR_LEVELS: ReadonlySet<LogLevel> = new Set(["warn", "error"]);

const defaultSink: LogSink = (level, line) => {
  const stream = STDERR_LEVELS.has(level) ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

/** True when a line at `level` passes a logger whose threshold is `threshold`. */
export function isEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(threshold);
}

/** A context value as it appears after the `=`: bare when it is a single plain token, JSON-quoted otherwise. */
function formatValue(value: Exclude<LogValue, undefined>): string {
  if (typeof value !== "string") {
    return String(value);
  }
  const needsQuoting = value === "" || /[\s="\\]/.test(value);
  return needsQuoting ? JSON.stringify(value) : value;
}

/** The exact line a call produces, without the trailing newline. Exported for the tests. */
export function formatLine(
  timestamp: Date,
  level: LogLevel,
  message: string,
  context: LogContext = {},
): string {
  const parts = [timestamp.toISOString(), level.padEnd(LEVEL_COLUMN_WIDTH), message];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

export class Logger {
  private level: LogLevel;
  private readonly sink: LogSink;
  private readonly now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? DEFAULT_LOG_LEVEL;
    this.sink = options.sink ?? defaultSink;
    this.now = options.now ?? (() => new Date());
  }

  /** The current threshold. */
  getLevel(): LogLevel {
    return this.level;
  }

  /** Changes the threshold; `index.ts` calls this once from config. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Whether a call at `level` would produce a line, for callers that build expensive context. */
  enabled(level: LogLevel): boolean {
    return isEnabled(level, this.level);
  }

  debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.enabled(level)) {
      return;
    }
    this.sink(level, formatLine(this.now(), level, message, context));
  }
}

/** The server's one logger. Every module logs through it; `index.ts` sets its level. */
export const log = new Logger();
