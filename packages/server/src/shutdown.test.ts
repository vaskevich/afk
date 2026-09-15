import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHost, makeSystemFrame } from "@afk/shared/testing";
import { createApp } from "./app.ts";
import { log } from "./log/logger.ts";
import { makeAppConfig } from "./routes/test-helpers.ts";
import { EXIT_CODE_CLEAN, EXIT_CODE_FORCED, SHUTDOWN_TIMEOUT_MS, shutdown } from "./shutdown.ts";
import { SessionStore } from "./store/sessions.ts";
import { MemorySessionStorage } from "./store/storage.ts";

const LOOPBACK = "127.0.0.1";

/** Holds every `appendFrames` on `storage` until the returned function is called. */
function gateAppends(storage: MemorySessionStorage): () => void {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const append = storage.appendFrames.bind(storage);
  vi.spyOn(storage, "appendFrames").mockImplementation(async (sessionId, frames) => {
    await gate;
    await append(sessionId, frames);
  });
  return release;
}

/** A storage that buffers, the way the bucket backend does, whose flush the test controls. */
class BufferingStorage extends MemorySessionStorage {
  flushCalls = 0;
  failFlush = false;

  async flush(): Promise<void> {
    this.flushCalls++;
    if (this.failFlush) {
      throw new Error("simulated flush failure");
    }
  }
}

/** A store with one active session whose first batch is stuck behind the returned gate. */
async function storeWithPendingWrite() {
  const storage = new MemorySessionStorage();
  const store = new SessionStore(storage);
  const { session } = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
  const release = gateAppends(storage);
  const ingest = store.ingest(session, [makeSystemFrame(0)]);
  return { storage, store, session, release, ingest };
}

/** A real listening server on a loopback port, closed after the test if still open. */
async function listeningServer(): Promise<Server> {
  const server = createServer();
  server.listen(0, LOOPBACK);
  await once(server, "listening");
  openServers.push(server);
  return server;
}

/** Everything `shutdown` needs besides the store and server, all spies. */
function makeDeps() {
  return { stopTicker: vi.fn(), stopSweeper: vi.fn(), exit: vi.fn() };
}

/** Lets pending I/O callbacks run without advancing any timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Reads until the stream ends or the socket is destroyed under the reader. */
async function readUntilClosed(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    }
  } catch {
    // The server destroyed the socket, which is the other way a stream ends.
  }
}

const openServers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const server of openServers.splice(0)) {
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

describe("shutdown", () => {
  it("stops the ticker and sweeper, closes the listener, waits for every pending write, then exits 0", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    const { storage, store, session, release, ingest } = await storeWithPendingWrite();
    const server = await listeningServer();
    const deps = makeDeps();

    const done = shutdown("SIGTERM", { server, store, ...deps });
    await settle();
    expect(deps.stopTicker).toHaveBeenCalledOnce();
    expect(deps.stopSweeper).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
    expect(deps.exit).not.toHaveBeenCalled();

    release();
    await done;
    await ingest;

    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(EXIT_CODE_CLEAN);
    await expect(storage.readFrames(session.sessionId)).resolves.toHaveLength(1);
  });

  it("flushes what storage still buffers once the writes have drained", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    const storage = new BufferingStorage();
    const store = new SessionStore(storage);
    const { session } = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
    const release = gateAppends(storage);
    const ingest = store.ingest(session, [makeSystemFrame(0)]);
    const server = await listeningServer();
    const deps = makeDeps();

    const done = shutdown("SIGTERM", { server, store, ...deps });
    await settle();
    expect(storage.flushCalls).toBe(0);
    release();
    await done;
    await ingest;

    expect(storage.flushCalls).toBe(1);
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(EXIT_CODE_CLEAN);
  });

  it("still exits cleanly when the storage flush fails, logging the failure", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    const storage = new BufferingStorage();
    storage.failFlush = true;
    const store = new SessionStore(storage);
    const server = await listeningServer();
    const deps = makeDeps();

    await shutdown("SIGTERM", { server, store, ...deps });

    expect(error).toHaveBeenCalledExactlyOnceWith("storage flush failed", {
      signal: "SIGTERM",
      error: "simulated flush failure",
    });
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(EXIT_CODE_CLEAN);
  });

  it("exits with the forced code once the timeout passes while a drain is still pending", async () => {
    vi.useFakeTimers();
    vi.spyOn(log, "info").mockImplementation(() => {});
    vi.spyOn(log, "error").mockImplementation(() => {});
    const { store, release, ingest } = await storeWithPendingWrite();
    const server = await listeningServer();
    const deps = makeDeps();

    const done = shutdown("SIGTERM", { server, store, ...deps });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);
    expect(deps.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(EXIT_CODE_FORCED);

    release();
    await done;
    await ingest;
  });

  it("honours a custom timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(log, "info").mockImplementation(() => {});
    vi.spyOn(log, "error").mockImplementation(() => {});
    const { store, release, ingest } = await storeWithPendingWrite();
    const server = await listeningServer();
    const deps = makeDeps();

    const done = shutdown("SIGINT", { server, store, timeoutMs: 250, ...deps });
    await vi.advanceTimersByTimeAsync(250);

    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(EXIT_CODE_FORCED);

    release();
    await done;
    await ingest;
  });

  it("ends an open SSE stream so a viewer reconnects instead of hanging", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    const store = new SessionStore(new MemorySessionStorage());
    const { session } = await store.create({ host: makeHost(), clientVersion: "0.1.0" });
    const app = createApp(makeAppConfig(), store);
    const server = serve({ fetch: app.fetch, port: 0, hostname: LOOPBACK }) as Server;
    openServers.push(server);
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://${LOOPBACK}:${port}/api/sessions/${session.sessionId}/stream`);
    const reader = res.body!.getReader();
    await reader.read();
    const deps = makeDeps();

    const done = shutdown("SIGTERM", { server, store, ...deps });
    // A stream that stayed open would hang here and fail as a test timeout.
    await readUntilClosed(reader);
    await done;

    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(EXIT_CODE_CLEAN);
  });
});
