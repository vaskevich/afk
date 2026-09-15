/**
 * Server configuration, parsed once from the environment at startup.
 *
 * Every tunable the server has goes through here: `loadConfig` validates the `AFK_*`
 * variables against a Zod schema keyed by variable name (so an error names the variable
 * that is wrong), applies defaults, and returns a `ServerConfig` that `index.ts` turns
 * into the in-process shapes (`AppConfig`, `SessionStoreOptions`, sweeper options).
 * Nothing else in the server reads `process.env`.
 *
 * Each default has one owner: the module that uses it exports it and the schema below
 * references it, so the docs table in docs/CONFIGURATION.md, the schema, and the code
 * cannot drift apart. That table documents every variable; keep it in step with the
 * schema.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { MinimumVersions } from "./env.ts";
import {
  MIN_CLIENT_VERSION,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ServerBuildInfo,
} from "@afk/shared";
import { parseSemver } from "./utils/semver.ts";
import { DEFAULT_LIMITS, DEFAULT_SSE_KEEPALIVE_MS, type AdmissionLimits } from "./env.ts";
import { DEFAULT_LOG_LEVEL, LOG_LEVELS, type LogLevel } from "./log/logger.ts";
import { REPO_ROOT, repoPaths } from "./paths.ts";
import { DEFAULT_SLAB_FLUSH_INTERVAL_MS, DEFAULT_SLAB_MAX_FRAMES } from "./store/s3-storage.ts";
import { DEFAULT_STORE_OPTIONS, DEFAULT_TICK_INTERVAL_MS } from "./store/sessions.ts";
import { DEFAULT_RETENTION_DAYS, DEFAULT_SWEEP_INTERVAL_MS } from "./store/sweeper.ts";

const MS_PER_SECOND = 1000;
const MAX_TCP_PORT = 65535;

/**
 * Where the server looks for the built dashboard, the client script, its data
 * directory, and its own package.json when not told otherwise: the repo layout under
 * the root `paths.ts` derives from its own location, in dev and in the image alike.
 */
const paths = repoPaths(REPO_ROOT);
export const DEFAULT_PATHS = {
  webDistDir: paths.webDistDir,
  clientScriptPath: paths.clientScriptPath,
  dataDir: paths.dataDir,
};

/** The server's own manifest, whose `version` is what /versionz and /api/stats report. */
export const SERVER_PACKAGE_JSON = paths.serverPackageJson;

/** What `loadConfig` falls back to when the environment does not say: the paths, and the version. */
export interface ConfigDefaults {
  webDistDir: string;
  clientScriptPath: string;
  dataDir: string;
  serverVersion: string;
}

/** The `version` field of a package.json. Throws `ConfigError` naming the file when it has none. */
export function readPackageVersion(packageJsonPath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError([`${packageJsonPath}: cannot read package version: ${reason}`]);
  }
  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? parsed.version
      : undefined;
  if (typeof version !== "string" || version === "") {
    throw new ConfigError([`${packageJsonPath}: package.json has no "version" string`]);
  }
  return version;
}

/** The defaults the running server uses: the repo layout and its own package version. */
function productionDefaults(): ConfigDefaults {
  return { ...DEFAULT_PATHS, serverVersion: readPackageVersion(SERVER_PACKAGE_JSON) };
}

/** Defaults for every numeric variable, in the units the variable itself uses. */
export const CONFIG_DEFAULTS = {
  port: 4141,
  maxActiveSessions: DEFAULT_LIMITS.maxActiveSessions,
  maxStreamsPerSession: DEFAULT_LIMITS.maxStreamsPerSession,
  maxFramesPerSession: DEFAULT_LIMITS.maxFramesPerSession,
  maxBytesPerSession: DEFAULT_LIMITS.maxBytesPerSession,
  maxSseConnectionsPerSession: DEFAULT_LIMITS.maxSseConnectionsPerSession,
  maxSseConnections: DEFAULT_LIMITS.maxSseConnections,
  maxSessionDurationSeconds: DEFAULT_STORE_OPTIONS.maxSessionDurationSeconds,
  retentionDays: DEFAULT_RETENTION_DAYS,
  sweepIntervalSeconds: DEFAULT_SWEEP_INTERVAL_MS / MS_PER_SECOND,
  tickIntervalSeconds: DEFAULT_TICK_INTERVAL_MS / MS_PER_SECOND,
  evictEndedAfterSeconds: DEFAULT_STORE_OPTIONS.evictEndedAfterMs / MS_PER_SECOND,
  endAfterSilentSeconds: DEFAULT_STORE_OPTIONS.endAfterSilentMs / MS_PER_SECOND,
  sseKeepaliveSeconds: DEFAULT_SSE_KEEPALIVE_MS / MS_PER_SECOND,
  s3SlabFlushSeconds: DEFAULT_SLAB_FLUSH_INTERVAL_MS / MS_PER_SECOND,
  s3SlabMaxFrames: DEFAULT_SLAB_MAX_FRAMES,
} as const;

export const STORAGE_BACKENDS = ["disk", "s3"] as const;
export type StorageBackend = (typeof STORAGE_BACKENDS)[number];

/** Which `SessionStorage` to construct and what it needs. See store/create-storage.ts. */
export type StorageConfig =
  | { backend: "disk"; dataDir: string }
  | {
      backend: "s3";
      bucket: string;
      region: string;
      /** Only for S3-compatible stores (MinIO); unset means the regional S3 endpoint. */
      endpoint: string | undefined;
      accessKeyId: string;
      secretAccessKey: string;
      /** Slab bounds: buffered frames are written when either is reached (see store/s3-storage.ts). */
      slabFlushSeconds: number;
      slabMaxFrames: number;
    };

/** Everything the server can be told from the environment, validated and defaulted. */
export interface ServerConfig {
  port: number;
  /** Public origin used to build dashboard URLs, e.g. https://afk.osv.im */
  publicBaseUrl: string;
  /** Absolute path to the built dashboard (packages/web/dist). */
  webDistDir: string;
  /** Absolute path to the client script (cli/afk) served at /cli/afk and by /install. */
  clientScriptPath: string;
  storage: StorageConfig;
  limits: AdmissionLimits;
  /** Server-owned cap on how long one session accepts frames. */
  maxSessionDurationSeconds: number;
  /** How long after a session ends its data is kept before the sweeper deletes it. */
  retentionDays: number;
  sweepIntervalSeconds: number;
  /** How often time-based rules run and idle ended sessions are evicted from memory. */
  tickIntervalSeconds: number;
  evictEndedAfterSeconds: number;
  /** How long an active session may go without a frame before the server ends it. */
  endAfterSilentSeconds: number;
  sseKeepaliveSeconds: number;
  minimumVersions: MinimumVersions;
  /** Threshold for `log/logger.ts`; lines below it are dropped. */
  logLevel: LogLevel;
  /** What this server was built from: its package version plus `AFK_BUILD_SHA` / `AFK_BUILD_TIME`. */
  build: ServerBuildInfo;
}

/** Thrown by `loadConfig` with one line per problem, each naming the variable. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

/** An optional string variable; an empty value counts as unset, like a shell would treat it. */
const optionalString = z
  .string()
  .optional()
  .transform((raw) => (raw === undefined || raw === "" ? undefined : raw));

/** A whole number with a default and a lower (and optional upper) bound. */
function integer(defaultValue: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  return optionalString.transform((raw, ctx) => {
    if (raw === undefined) {
      return defaultValue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `between ${min} and ${max}`;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected a whole number ${range}, got "${raw}"`,
      });
      return z.NEVER;
    }
    return value;
  });
}

/** One of a fixed set of words, with a default. */
function oneOf<const T extends readonly [string, ...string[]]>(values: T, defaultValue: T[number]) {
  return optionalString.transform((raw, ctx): T[number] => {
    if (raw === undefined) {
      return defaultValue;
    }
    if (!values.includes(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected one of ${values.join(", ")}, got "${raw}"`,
      });
      return z.NEVER;
    }
    return raw;
  });
}

/** A semver string such as "0.2.0", with a default. */
function semver(defaultValue: string) {
  return optionalString.transform((raw, ctx) => {
    if (raw === undefined) {
      return defaultValue;
    }
    if (parseSemver(raw) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected a version like 1.2.3, got "${raw}"`,
      });
      return z.NEVER;
    }
    return raw;
  });
}

/** Variables that must be set when `AFK_STORAGE=s3`. */
const S3_REQUIRED_VARIABLES = [
  "AFK_S3_BUCKET",
  "AFK_S3_REGION",
  "AFK_S3_ACCESS_KEY_ID",
  "AFK_S3_SECRET_ACCESS_KEY",
] as const;

const EnvSchema = z
  .object({
    AFK_PORT: integer(CONFIG_DEFAULTS.port, 1, MAX_TCP_PORT),
    AFK_PUBLIC_BASE_URL: optionalString,
    AFK_WEB_DIST: optionalString,
    AFK_CLIENT_SCRIPT: optionalString,

    AFK_STORAGE: oneOf(STORAGE_BACKENDS, "disk"),
    AFK_DATA_DIR: optionalString,
    AFK_S3_BUCKET: optionalString,
    AFK_S3_REGION: optionalString,
    AFK_S3_ENDPOINT: optionalString,
    AFK_S3_ACCESS_KEY_ID: optionalString,
    AFK_S3_SECRET_ACCESS_KEY: optionalString,
    AFK_S3_SLAB_FLUSH_SECONDS: integer(CONFIG_DEFAULTS.s3SlabFlushSeconds, 1),
    AFK_S3_SLAB_MAX_FRAMES: integer(CONFIG_DEFAULTS.s3SlabMaxFrames, 1),

    AFK_MAX_ACTIVE_SESSIONS: integer(CONFIG_DEFAULTS.maxActiveSessions, 1),
    AFK_MAX_STREAMS_PER_SESSION: integer(CONFIG_DEFAULTS.maxStreamsPerSession, 1),
    AFK_MAX_FRAMES_PER_SESSION: integer(CONFIG_DEFAULTS.maxFramesPerSession, 1),
    AFK_MAX_BYTES_PER_SESSION: integer(CONFIG_DEFAULTS.maxBytesPerSession, 1),
    AFK_MAX_SSE_CONNECTIONS_PER_SESSION: integer(CONFIG_DEFAULTS.maxSseConnectionsPerSession, 1),
    AFK_MAX_SSE_CONNECTIONS: integer(CONFIG_DEFAULTS.maxSseConnections, 1),
    AFK_MAX_SESSION_DURATION_SECONDS: integer(CONFIG_DEFAULTS.maxSessionDurationSeconds, 1),

    AFK_RETENTION_DAYS: integer(CONFIG_DEFAULTS.retentionDays, 0),
    AFK_SWEEP_INTERVAL_SECONDS: integer(CONFIG_DEFAULTS.sweepIntervalSeconds, 1),

    AFK_TICK_INTERVAL_SECONDS: integer(CONFIG_DEFAULTS.tickIntervalSeconds, 1),
    AFK_EVICT_ENDED_AFTER_SECONDS: integer(CONFIG_DEFAULTS.evictEndedAfterSeconds, 0),
    AFK_END_AFTER_SILENT_SECONDS: integer(CONFIG_DEFAULTS.endAfterSilentSeconds, 1),
    AFK_SSE_KEEPALIVE_SECONDS: integer(CONFIG_DEFAULTS.sseKeepaliveSeconds, 1),

    // Per-deployment floors for clients (docs/VERSIONING.md). The env can only raise the
    // protocol floor: the shared schema already rejects anything below MIN_PROTOCOL_VERSION.
    AFK_MIN_CLIENT_VERSION: semver(MIN_CLIENT_VERSION),
    AFK_MIN_PROTOCOL_VERSION: integer(MIN_PROTOCOL_VERSION, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION),

    AFK_LOG_LEVEL: oneOf(LOG_LEVELS, DEFAULT_LOG_LEVEL),

    // Build identity, stamped into the image by the Dockerfile (ARG GIT_SHA / BUILD_TIME
    // from infra/deploy.sh). Free-form on purpose: a deploy compares the commit as a
    // string, and a local run simply leaves both unset.
    AFK_BUILD_SHA: optionalString,
    AFK_BUILD_TIME: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.AFK_STORAGE !== "s3") {
      return;
    }
    for (const name of S3_REQUIRED_VARIABLES) {
      if (env[name] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "required when AFK_STORAGE=s3",
        });
      }
    }
  });

type ParsedEnv = z.infer<typeof EnvSchema>;

function storageConfig(env: ParsedEnv, defaultDataDir: string): StorageConfig {
  if (env.AFK_STORAGE === "disk") {
    return { backend: "disk", dataDir: env.AFK_DATA_DIR ?? defaultDataDir };
  }
  // superRefine has already rejected the s3 backend without these set.
  return {
    backend: "s3",
    bucket: env.AFK_S3_BUCKET ?? "",
    region: env.AFK_S3_REGION ?? "",
    endpoint: env.AFK_S3_ENDPOINT,
    accessKeyId: env.AFK_S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.AFK_S3_SECRET_ACCESS_KEY ?? "",
    slabFlushSeconds: env.AFK_S3_SLAB_FLUSH_SECONDS,
    slabMaxFrames: env.AFK_S3_SLAB_MAX_FRAMES,
  };
}

/**
 * Parses and validates the `AFK_*` variables. Throws `ConfigError` naming every variable
 * that is wrong. `defaults` exists so tests can pass a temp directory and a fixed version
 * instead of the repo layout and the real package.json.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  defaults: ConfigDefaults = productionDefaults(),
): ServerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new ConfigError(problems);
  }
  const value = parsed.data;
  return {
    port: value.AFK_PORT,
    publicBaseUrl: value.AFK_PUBLIC_BASE_URL ?? `http://localhost:${value.AFK_PORT}`,
    webDistDir: value.AFK_WEB_DIST ?? defaults.webDistDir,
    clientScriptPath: value.AFK_CLIENT_SCRIPT ?? defaults.clientScriptPath,
    storage: storageConfig(value, defaults.dataDir),
    limits: {
      maxActiveSessions: value.AFK_MAX_ACTIVE_SESSIONS,
      maxStreamsPerSession: value.AFK_MAX_STREAMS_PER_SESSION,
      maxFramesPerSession: value.AFK_MAX_FRAMES_PER_SESSION,
      maxBytesPerSession: value.AFK_MAX_BYTES_PER_SESSION,
      maxSseConnectionsPerSession: value.AFK_MAX_SSE_CONNECTIONS_PER_SESSION,
      maxSseConnections: value.AFK_MAX_SSE_CONNECTIONS,
    },
    maxSessionDurationSeconds: value.AFK_MAX_SESSION_DURATION_SECONDS,
    retentionDays: value.AFK_RETENTION_DAYS,
    sweepIntervalSeconds: value.AFK_SWEEP_INTERVAL_SECONDS,
    tickIntervalSeconds: value.AFK_TICK_INTERVAL_SECONDS,
    evictEndedAfterSeconds: value.AFK_EVICT_ENDED_AFTER_SECONDS,
    endAfterSilentSeconds: value.AFK_END_AFTER_SILENT_SECONDS,
    sseKeepaliveSeconds: value.AFK_SSE_KEEPALIVE_SECONDS,
    minimumVersions: {
      clientVersion: value.AFK_MIN_CLIENT_VERSION,
      protocolVersion: value.AFK_MIN_PROTOCOL_VERSION,
    },
    logLevel: value.AFK_LOG_LEVEL,
    build: {
      version: defaults.serverVersion,
      commit: value.AFK_BUILD_SHA ?? null,
      builtAt: value.AFK_BUILD_TIME ?? null,
    },
  };
}

function describeStorage(storage: StorageConfig): string {
  if (storage.backend === "disk") {
    return `storage disk (${storage.dataDir})`;
  }
  // Credentials are never printed, not even partially.
  const endpoint = storage.endpoint === undefined ? "" : `, endpoint ${storage.endpoint}`;
  const slabs = `slabs every ${storage.slabFlushSeconds}s or ${storage.slabMaxFrames} frames`;
  return `storage s3 (bucket ${storage.bucket}, region ${storage.region}${endpoint}, ${slabs})`;
}

/** One line for the startup log with every effective setting and no secrets. */
export function describeConfig(config: ServerConfig): string {
  return [
    `version ${config.build.version}`,
    `commit ${config.build.commit ?? "unknown"}`,
    `port ${config.port}`,
    `public base ${config.publicBaseUrl}`,
    `web dist ${config.webDistDir}`,
    `client script ${config.clientScriptPath}`,
    describeStorage(config.storage),
    `limits ${config.limits.maxActiveSessions} sessions x ${config.limits.maxStreamsPerSession} streams x ${config.limits.maxFramesPerSession} frames / ${config.limits.maxBytesPerSession} bytes`,
    `sse connections ${config.limits.maxSseConnectionsPerSession} per session / ${config.limits.maxSseConnections} total`,
    `max session ${config.maxSessionDurationSeconds}s`,
    `retention ${config.retentionDays}d (sweep every ${config.sweepIntervalSeconds}s)`,
    `tick ${config.tickIntervalSeconds}s`,
    `evict ended after ${config.evictEndedAfterSeconds}s`,
    `end after silent ${config.endAfterSilentSeconds}s`,
    `sse keepalive ${config.sseKeepaliveSeconds}s`,
    `minimum client ${config.minimumVersions.clientVersion} / protocol ${config.minimumVersions.protocolVersion}`,
    `log level ${config.logLevel}`,
  ].join(", ");
}
