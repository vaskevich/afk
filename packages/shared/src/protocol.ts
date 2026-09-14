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

/**
 * The wire contract's version. Bumped only for an incompatible change; additive changes
 * (a new collector, an optional field, an endpoint) never bump it. See docs/VERSIONING.md.
 */
export const PROTOCOL_VERSION = 1;
/** Oldest protocol version the server still accepts; anything in [min, current] is handled. */
export const MIN_PROTOCOL_VERSION = 1;
/**
 * Oldest client (semver, from `X-Afk-Client: <name>/<semver>`) the server talks to. Raised
 * only to retire a client release with known-bad behaviour, never because a newer one exists.
 */
export const MIN_CLIENT_VERSION = "0.1.0";

/** Server-owned session policy. Returned on session create so clients never hardcode it. */
export const DEFAULT_MAX_SESSION_DURATION_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/**
 * Raw values of macOS `sysctl kern.memorystatus_vm_pressure_level`. The client sends
 * this number as-is; the server maps it to a label (see `describeFrame`).
 */
export enum MemoryPressureLevel {
  Normal = 1,
  Warn = 2,
  Critical = 4,
}

/**
 * Point-in-time snapshot of whole-machine health. Sampled at ~1 Hz.
 * All memory values are bytes. Pressure level is the raw value of
 * `sysctl kern.memorystatus_vm_pressure_level`; the server maps it to a label.
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
    // Not z.nativeEnum(MemoryPressureLevel): the client sends the raw sysctl value,
    // and unknown/future levels must still be accepted and stored, not rejected.
    // See MemoryPressureLevel above for the known values.
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

/**
 * One wrapped command (`afk run -- <cmd>`), sampled at ~1 Hz for as long as it runs,
 * plus one final frame with `state: "exited"`. Byte counts are cumulative; the server
 * derives rates. `output.flavor` names how the client looked at the output so richer
 * parsers (progress lines, JSON records) can be added without changing the envelope.
 */
export const RunOutputVolume = z.object({
  flavor: z.literal("volume"),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
});
export const RunOutput = z.discriminatedUnion("flavor", [RunOutputVolume]);
export type RunOutput = z.infer<typeof RunOutput>;

export const RunState = z.enum(["running", "exited"]);
export type RunState = z.infer<typeof RunState>;

export const RunCollectorData = z.object({
  /** The command line as typed, truncated for display. */
  command: z.string().max(256),
  pid: z.number().int().nonnegative(),
  state: RunState,
  /** Set on the final frame only. */
  exitCode: z.number().int().nullable(),
  elapsedSeconds: z.number().int().nonnegative(),
  /** The wrapped process itself (0 once it is gone). rss is bytes. */
  process: z.object({
    cpuPercent: z.number().min(0),
    rssBytes: z.number().int().nonnegative(),
  }),
  output: RunOutput,
});
export type RunCollectorData = z.infer<typeof RunCollectorData>;

/** How many processes a `processes` frame carries at most; the client sends the busiest ones. */
export const PROCESSES_TOP_MAX = 10;
/** Full executable paths can be long (nested .app bundles); anything past this is cut. */
export const PROCESS_COMMAND_MAX_LENGTH = 512;

/**
 * Point-in-time list of the busiest processes, sampled every few seconds. `top` is
 * ordered by cpu descending as `ps -r` lists them; `sampledCount` is how many
 * processes there were in total. rss is bytes; `command` is the full executable path.
 */
export const ProcessEntry = z.object({
  pid: z.number().int().nonnegative(),
  parentPid: z.number().int().nonnegative(),
  cpuPercent: z.number().min(0),
  memoryPercent: z.number().min(0),
  rssBytes: z.number().int().nonnegative(),
  command: z.string().max(PROCESS_COMMAND_MAX_LENGTH),
});
export type ProcessEntry = z.infer<typeof ProcessEntry>;

export const ProcessesCollectorData = z.object({
  sampledCount: z.number().int().nonnegative(),
  top: z.array(ProcessEntry).max(PROCESSES_TOP_MAX),
});
export type ProcessesCollectorData = z.infer<typeof ProcessesCollectorData>;

// TODO(collectors): agents (claude/codex counts).

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
export type SystemFrame = z.infer<typeof SystemFrame>;

/** Stream id is `run:<runId>` so every wrapped command gets its own row. */
export const RunFrame = FrameBase.extend({
  collector: z.literal("run"),
  data: RunCollectorData,
});
export type RunFrame = z.infer<typeof RunFrame>;

export const ProcessesFrame = FrameBase.extend({
  collector: z.literal("processes"),
  data: ProcessesCollectorData,
});
export type ProcessesFrame = z.infer<typeof ProcessesFrame>;

/** Every frame the server accepts. Add new collectors to this union. */
export const Frame = z.discriminatedUnion("collector", [SystemFrame, RunFrame, ProcessesFrame]);
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
  /** Must be in [MIN_PROTOCOL_VERSION, PROTOCOL_VERSION]; the server answers 426 otherwise. */
  protocolVersion: z
    .number()
    .int()
    .min(MIN_PROTOCOL_VERSION, {
      message: `protocol version too old; this server accepts ${MIN_PROTOCOL_VERSION} to ${PROTOCOL_VERSION}`,
    })
    .max(PROTOCOL_VERSION, {
      message: `protocol version too new; this server accepts ${MIN_PROTOCOL_VERSION} to ${PROTOCOL_VERSION}`,
    }),
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
  /** Distinct streams seen so far, and the server's cap. A client checks this before joining. */
  streamCount: z.number().int().nonnegative(),
  maxStreams: z.number().int().positive(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** GET /api/stats: whole-service numbers for the landing page and for operators. */
export const ServiceStats = z.object({
  activeSessions: z.number().int().nonnegative(),
  maxActiveSessions: z.number().int().positive(),
  maxStreamsPerSession: z.number().int().positive(),
  /** Sessions currently held in memory, active or recently viewed. */
  sessionsInMemory: z.number().int().nonnegative(),
  framesInMemory: z.number().int().nonnegative(),
  uptimeSeconds: z.number().int().nonnegative(),
  serverVersion: z.string(),
});
export type ServiceStats = z.infer<typeof ServiceStats>;

export const ErrorResponse = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/**
 * `details` of a 426 Upgrade Required `ErrorResponse`, the same three fields whichever
 * check failed (client version below the minimum, missing `X-Afk-Client` header, or a
 * `protocolVersion` outside the accepted range) so a client prints one upgrade message.
 * `yourVersion` is what the header said, or null when it was missing or unparsable.
 * See docs/VERSIONING.md.
 */
export const UpgradeRequiredDetails = z.object({
  minimumClientVersion: z.string(),
  minimumProtocolVersion: z.number().int(),
  yourVersion: z.string().nullable(),
});
export type UpgradeRequiredDetails = z.infer<typeof UpgradeRequiredDetails>;

// ---------------------------------------------------------------------------
// Reading a session (dashboard side)
// ---------------------------------------------------------------------------

/**
 * A frame as the server stores and serves it. `index` is the session-wide position
 * (1-based, monotonic across all streams) and doubles as the SSE event id, so a
 * dashboard reconnecting with `Last-Event-ID` picks up exactly where it left off.
 */
export const StoredFrame = z.object({
  index: z.number().int().positive(),
  /** Server clock, unix milliseconds. */
  receivedAt: z.number().int(),
  frame: Frame,
});
export type StoredFrame = z.infer<typeof StoredFrame>;

// ---------------------------------------------------------------------------
// Anomaly events
// ---------------------------------------------------------------------------

export const EventSeverity = z.enum(["info", "warning", "critical"]);
export type EventSeverity = z.infer<typeof EventSeverity>;

/** How many processes an event names at most; enough to say what was going on. */
export const EVENT_TOP_PROCESSES_MAX = 3;

/**
 * Structured context a rule captured when the event opened, so the event itself can
 * say what was going on at that moment (the dashboard and log render it; nothing is
 * recomputed from it). A named object so future rules can add fields to it.
 */
export const AnomalyEventDetails = z.object({
  /** The busiest processes at the time, from the `processes` stream, cpu descending. */
  topProcesses: z
    .array(
      z.object({
        pid: z.number().int().nonnegative(),
        cpuPercent: z.number().min(0),
        /** Full executable path, as the collector reported it. */
        command: z.string().max(PROCESS_COMMAND_MAX_LENGTH),
      }),
    )
    .max(EVENT_TOP_PROCESSES_MAX)
    .optional(),
});
export type AnomalyEventDetails = z.infer<typeof AnomalyEventDetails>;

/**
 * Something the server's rules decided is worth calling out. Events are derived from
 * frames on the server (never persisted, recomputed on load, so improved rules apply
 * to old sessions too) and belong to a stream, i.e. a timeline row.
 */
export const AnomalyEvent = z.object({
  /** Stable across recomputation: `<stream>:<kind>:<startedAt>`. Live updates upsert by id. */
  id: z.string(),
  stream: z.string(),
  /** Rule identifier, dotted, e.g. "cpu.high", "memory.pressure", "client.stale". */
  kind: z.string(),
  severity: EventSeverity,
  /** One readable sentence, e.g. "cpu above 90% for 45s (peak 97%)". */
  message: z.string(),
  /** Unix milliseconds, derived from frame timestamps. */
  startedAt: z.number().int(),
  /** Null while the condition is still ongoing. */
  endedAt: z.number().int().nullable(),
  /** Snapshot captured when the event opened; absent when the rule had nothing to add. */
  details: AnomalyEventDetails.optional(),
});
export type AnomalyEvent = z.infer<typeof AnomalyEvent>;

/** GET /api/sessions/:id/frames?after=<index>. Events are always the complete current set. */
export const FramesResponse = z.object({
  session: SessionSummary,
  frames: z.array(StoredFrame),
  events: z.array(AnomalyEvent),
});
export type FramesResponse = z.infer<typeof FramesResponse>;

/**
 * GET /api/sessions/:id/stream (text/event-stream). Events, in order of appearance:
 *   session  data = SessionSummary; sent on connect and whenever the status changes
 *   event    data = AnomalyEvent; every existing event is sent after `session` as a
 *            snapshot, then one per change (an event opening, updating, or closing);
 *            consumers upsert by id. No SSE id, so it never disturbs frame resumption.
 *   frame    data = StoredFrame; id = StoredFrame.index
 *   end      data = SessionSummary; sent once the session is over, then the stream closes
 * Reconnect with `Last-Event-ID` (or `?after=<index>`) to replay what was missed.
 */
export const StreamEventName = {
  Session: "session",
  Event: "event",
  Frame: "frame",
  End: "end",
} as const;
export type StreamEventName = (typeof StreamEventName)[keyof typeof StreamEventName];
