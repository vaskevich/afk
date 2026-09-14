import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_SESSION_DURATION_SECONDS } from "@afk/shared";
import { ConfigError, describeConfig, loadConfig, type ServerConfig } from "./config.ts";

/** Fixed fallbacks so the expected values do not depend on where the tests run. */
const PATHS = { webDistDir: "/opt/afk/web/dist", dataDir: "/var/lib/afk" };

const S3_ENV = {
  AFK_STORAGE: "s3",
  AFK_S3_BUCKET: "test-bucket",
  AFK_S3_REGION: "us-east-1",
  AFK_S3_ACCESS_KEY_ID: "AKIATESTKEYID",
  AFK_S3_SECRET_ACCESS_KEY: "verySecretValue",
};

/** A copy of `env` with `key` removed, for testing a missing required variable. */
function withoutVar(env: typeof S3_ENV, key: keyof typeof S3_ENV): NodeJS.ProcessEnv {
  const copy: Partial<typeof S3_ENV> = { ...env };
  delete copy[key];
  return copy;
}

const DEFAULT_CONFIG: ServerConfig = {
  port: 4141,
  publicBaseUrl: "http://localhost:4141",
  webDistDir: PATHS.webDistDir,
  storage: { backend: "disk", dataDir: PATHS.dataDir },
  limits: { maxActiveSessions: 20, maxStreamsPerSession: 10 },
  maxSessionDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
  retentionDays: 7,
  sweepIntervalSeconds: 3600,
  tickIntervalSeconds: 5,
  evictEndedAfterSeconds: 600,
  sseKeepaliveSeconds: 15,
};

describe("loadConfig", () => {
  it("applies every default when nothing is set, ignoring unrelated variables", () => {
    const config = loadConfig({ HOME: "/Users/someone", PATH: "/usr/bin" }, PATHS);

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("treats an empty value as unset", () => {
    const config = loadConfig({ AFK_PORT: "", AFK_STORAGE: "" }, PATHS);

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("uses an overridden port for the default public base URL", () => {
    const config = loadConfig({ AFK_PORT: "5000" }, PATHS);

    expect(config).toMatchObject({ port: 5000, publicBaseUrl: "http://localhost:5000" });
  });

  it("takes every tunable from its variable", () => {
    const config = loadConfig(
      {
        AFK_PUBLIC_BASE_URL: "https://afk.test",
        AFK_WEB_DIST: "/srv/dist",
        AFK_DATA_DIR: "/srv/data",
        AFK_MAX_ACTIVE_SESSIONS: "3",
        AFK_MAX_STREAMS_PER_SESSION: "2",
        AFK_MAX_SESSION_DURATION_SECONDS: "120",
        AFK_RETENTION_DAYS: "0",
        AFK_SWEEP_INTERVAL_SECONDS: "5",
        AFK_TICK_INTERVAL_SECONDS: "1",
        AFK_EVICT_ENDED_AFTER_SECONDS: "0",
        AFK_SSE_KEEPALIVE_SECONDS: "30",
      },
      PATHS,
    );

    expect(config).toEqual({
      port: 4141,
      publicBaseUrl: "https://afk.test",
      webDistDir: "/srv/dist",
      storage: { backend: "disk", dataDir: "/srv/data" },
      limits: { maxActiveSessions: 3, maxStreamsPerSession: 2 },
      maxSessionDurationSeconds: 120,
      retentionDays: 0,
      sweepIntervalSeconds: 5,
      tickIntervalSeconds: 1,
      evictEndedAfterSeconds: 0,
      sseKeepaliveSeconds: 30,
    });
  });

  it("builds the s3 storage config when AFK_STORAGE=s3 and every required variable is set", () => {
    const config = loadConfig({ ...S3_ENV, AFK_S3_ENDPOINT: "http://minio:9000" }, PATHS);

    expect(config.storage).toEqual({
      backend: "s3",
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://minio:9000",
      accessKeyId: "AKIATESTKEYID",
      secretAccessKey: "verySecretValue",
    });
  });

  it("rejects a number that is not a whole number, naming the variable and the value", () => {
    expect(() => loadConfig({ AFK_PORT: "abc" }, PATHS)).toThrow(
      'AFK_PORT: expected a whole number between 1 and 65535, got "abc"',
    );
  });

  it("rejects a number below its minimum", () => {
    expect(() => loadConfig({ AFK_MAX_ACTIVE_SESSIONS: "0" }, PATHS)).toThrow(
      'AFK_MAX_ACTIVE_SESSIONS: expected a whole number >= 1, got "0"',
    );
  });

  it("rejects an unknown storage backend, listing the valid ones", () => {
    expect(() => loadConfig({ AFK_STORAGE: "azure" }, PATHS)).toThrow(
      'AFK_STORAGE: expected one of disk, s3, got "azure"',
    );
  });

  it("names the missing variable when AFK_STORAGE=s3 is missing AFK_S3_BUCKET", () => {
    expect(() => loadConfig(withoutVar(S3_ENV, "AFK_S3_BUCKET"), PATHS)).toThrow(
      "AFK_S3_BUCKET: required when AFK_STORAGE=s3",
    );
  });

  it("names the missing variable when AFK_STORAGE=s3 is missing AFK_S3_SECRET_ACCESS_KEY", () => {
    expect(() => loadConfig(withoutVar(S3_ENV, "AFK_S3_SECRET_ACCESS_KEY"), PATHS)).toThrow(
      "AFK_S3_SECRET_ACCESS_KEY: required when AFK_STORAGE=s3",
    );
  });

  it("does not require the s3 variables for disk storage", () => {
    expect(() => loadConfig({ AFK_STORAGE: "disk" }, PATHS)).not.toThrow();
  });

  it("reports every problem at once as a ConfigError", () => {
    let thrown: unknown;
    try {
      loadConfig({ AFK_PORT: "-1", AFK_RETENTION_DAYS: "week" }, PATHS);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).problems).toEqual([
      expect.stringContaining("AFK_PORT"),
      expect.stringContaining("AFK_RETENTION_DAYS"),
    ]);
  });
});

describe("describeConfig", () => {
  it("summarizes disk storage with its data dir on one line", () => {
    const line = describeConfig(loadConfig({}, PATHS));

    expect(line).not.toContain("\n");
    expect(line).toContain("storage disk (/var/lib/afk)");
    expect(line).toContain("limits 20 sessions x 10 streams");
    expect(line).toContain("retention 7d (sweep every 3600s)");
  });

  it("names the bucket and region for s3 storage but never the credentials", () => {
    const line = describeConfig(loadConfig(S3_ENV, PATHS));

    expect(line).toContain("storage s3 (bucket test-bucket, region us-east-1)");
    expect(line).not.toContain("verySecretValue");
    expect(line).not.toContain("AKIATESTKEYID");
  });
});
