import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { ConfigError, describeConfig, loadConfig, type ServerConfig } from "./config.ts";
import type { AppConfig } from "./env.ts";
import { log } from "./log/logger.ts";
import { createStorage } from "./store/create-storage.ts";
import { SessionStore } from "./store/sessions.ts";
import { MS_PER_DAY, startSweeper } from "./store/sweeper.ts";

const MS_PER_SECOND = 1000;

function loadConfigOrExit(): ServerConfig {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      for (const problem of err.problems) {
        log.error("invalid configuration", { problem });
      }
      process.exit(1);
    }
    throw err;
  }
}

const config = loadConfigOrExit();
log.setLevel(config.logLevel);

const storage = createStorage(config.storage);
const store = new SessionStore(storage, {
  limits: config.limits,
  maxSessionDurationSeconds: config.maxSessionDurationSeconds,
  evictEndedAfterMs: config.evictEndedAfterSeconds * MS_PER_SECOND,
});
store.startTicker(config.tickIntervalSeconds * MS_PER_SECOND);
startSweeper({
  storage,
  store,
  retentionMs: config.retentionDays * MS_PER_DAY,
  intervalMs: config.sweepIntervalSeconds * MS_PER_SECOND,
});

const appConfig: AppConfig = {
  publicBaseUrl: config.publicBaseUrl,
  webDistDir: config.webDistDir,
  clientScriptPath: config.clientScriptPath,
  limits: config.limits,
  sseKeepaliveMs: config.sseKeepaliveSeconds * MS_PER_SECOND,
  minimumVersions: config.minimumVersions,
};
const app = createApp(appConfig, store);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info(`afk server listening on http://localhost:${info.port} (${describeConfig(config)})`);
});
