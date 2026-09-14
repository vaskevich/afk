import { DiskSessionStorage } from "./disk-storage.ts";
import { S3SessionStorage } from "./s3-storage.ts";
import type { SessionStorage } from "./storage.ts";

/**
 * Picks a `SessionStorage` backend from the environment: `AFK_STORAGE=disk` (the
 * default, for local dev and self-hosting) or `AFK_STORAGE=s3` (Lightsail object
 * storage, real S3, or MinIO, for the hosted deployment). See infra/README.md and
 * docs/EXTENDING.md's "Adding a storage backend" section.
 */
export function createStorageFromEnv(
  env: NodeJS.ProcessEnv,
  defaultDataDir: string,
): SessionStorage {
  const backend = env.AFK_STORAGE ?? "disk";

  if (backend === "disk") {
    return new DiskSessionStorage(env.AFK_DATA_DIR ?? defaultDataDir);
  }

  if (backend === "s3") {
    return new S3SessionStorage({
      bucket: requireEnv(env, "AFK_S3_BUCKET"),
      region: requireEnv(env, "AFK_S3_REGION"),
      // Optional: only set for a local/self-hosted S3-compatible store (MinIO).
      // Lightsail buckets and real S3 use the default regional endpoint.
      endpoint: env.AFK_S3_ENDPOINT,
      accessKeyId: requireEnv(env, "AFK_S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv(env, "AFK_S3_SECRET_ACCESS_KEY"),
    });
  }

  throw new Error(`unknown AFK_STORAGE backend "${backend}" (expected "disk" or "s3")`);
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`AFK_STORAGE=s3 requires the ${name} environment variable`);
  }
  return value;
}
