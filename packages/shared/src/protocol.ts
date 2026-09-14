/**
 * Wire protocol shared by the afk server, dashboard, and (by contract) the bash client.
 *
 * Design notes:
 * - Clients are intentionally dumb: they send raw measurements. All interpretation
 *   (thresholds, "normal" vs "warn", anomaly events) happens on the server so it can
 *   evolve without users downloading a new CLI.
 * - Frames are sent as newline-delimited JSON (one frame per line) so the bash client
 *   can stream its spool file straight into an HTTP body.
 * - Field names are deliberately explicit and readable over terse.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Server-owned session policy. Returned on session create so clients never hardcode it. */
export const DEFAULT_MAX_SESSION_DURATION_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/**
 * Point-in-time snapshot of whole-machine health. Sampled at ~1 Hz.
 * All memory values are bytes. Pressure level is the raw value of
 * `sysctl kern.memorystatus_vm_pressure_level` (1 = normal, 2 = warn, 4 = critical);
 * the server maps it to a label.
 */
export const SystemCollectorData = z.object({
  cpu: z.object({
    /** Sum of per-process %cpu divided by core count, so 100 = every core busy. */
    percent: z.number().min(0),
  }),
  loadAverage: z.object({
    oneMinute: z.number().min(0),
    fiveMinutes: z.number().min(0),
    fifteenMinutes: z.number().min(0),
  }),
  memory: z.object({
    pressureLevel: z.number().int(),
    totalBytes: z.number().int().nonnegative(),
    freeBytes: z.number().int().nonnegative(),
    activeBytes: z.number().int().nonnegative(),
    inactiveBytes: z.number().int().nonnegative(),
    wiredBytes: z.number().int().nonnegative(),
    compressedBytes: z.number().int().nonnegative(),
    swapUsedBytes: z.number().int().nonnegative(),
    swapTotalBytes: z.number().int().nonnegative(),
  }),
});
export type SystemCollectorData = z.infer<typeof SystemCollectorData>;

// TODO(collectors): processes (pid, parentPid, cpu, rss, fullPath), agents (claude/codex
// counts), run (afk run -- <cmd>: stdout/stderr bytes per tick, exit code).

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

const FrameBase = z.object({
  /**
   * Identifies a time series within a session, i.e. one row on the dashboard timeline.
   * Singleton collectors use their own name ("system"); per-instance collectors append
   * an id ("run:3f2a"). Sequence numbers are scoped to a stream.
   */
  stream: z.string().min(1).max(128),
  /** Monotonic per-stream counter starting at 1. Used for de-duplication on resend. */
  sequence: z.number().int().positive(),
  /** Client wall clock, unix seconds. The server records its own receive time separately. */
  timestamp: z.number().int().positive(),
});

export const SystemFrame = FrameBase.extend({
  collector: z.literal("system"),
  data: SystemCollectorData,
});

/** Every frame the server accepts. Add new collectors to this union. */
export const Frame = z.discriminatedUnion("collector", [SystemFrame]);
export type Frame = z.infer<typeof Frame>;
export type CollectorName = Frame["collector"];

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const HostInfo = z.object({
  hostname: z.string().min(1).max(256),
  platform: z.string().min(1).max(64), // e.g. "darwin"
  osVersion: z.string().min(1).max(64), // e.g. "26.5.2"
  cpuCount: z.number().int().positive(),
  memoryTotalBytes: z.number().int().positive(),
});
export type HostInfo = z.infer<typeof HostInfo>;

export const CreateSessionRequest = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  clientVersion: z.string().min(1).max(64),
  host: HostInfo,
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const CreateSessionResponse = z.object({
  /** Unguessable id; doubles as the shareable dashboard path segment. */
  sessionId: z.string(),
  /** Write-only bearer token for the ingest endpoint. Never appears in the dashboard URL. */
  ingestToken: z.string(),
  dashboardUrl: z.string().url(),
  /** Server-owned policy: after this the server rejects new frames with 410 Gone. */
  maxDurationSeconds: z.number().int().positive(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const IngestResponse = z.object({
  accepted: z.number().int().nonnegative(),
  /** Duplicates skipped because their sequence was already seen. */
  duplicates: z.number().int().nonnegative(),
  /** Highest sequence accepted so far, per stream, so a client can resync after a hiccup. */
  latestSequence: z.record(z.string(), z.number().int()),
});
export type IngestResponse = z.infer<typeof IngestResponse>;

export const SessionStatus = z.enum(["active", "ended", "expired"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionSummary = z.object({
  sessionId: z.string(),
  status: SessionStatus,
  host: HostInfo,
  clientVersion: z.string(),
  /** Unix milliseconds, server clock. */
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  maxDurationSeconds: z.number().int().positive(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const ErrorResponse = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
