import type { StorageConfig } from "../config.ts";
import { DiskSessionStorage } from "./disk-storage.ts";
import { S3SessionStorage } from "./s3-storage.ts";
import type { SessionStorage } from "./storage.ts";

/**
 * Builds the `SessionStorage` backend the configuration asks for: `disk` (the default,
 * for local dev and self-hosting) or `s3` (Lightsail object storage, real S3, or MinIO,
 * for the hosted deployment). The choice and its settings come from `AFK_STORAGE` and
 * friends, parsed and validated in config.ts. See docs/CONFIGURATION.md and
 * docs/EXTENDING.md's "Adding a storage backend" section.
 */
export function createStorage(config: StorageConfig): SessionStorage {
  if (config.backend === "disk") {
    return new DiskSessionStorage(config.dataDir);
  }
  return new S3SessionStorage({
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
}
