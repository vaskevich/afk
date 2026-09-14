/**
 * Contract test: the real bash client (cli/afk) talking to the real server over HTTP,
 * proving the wire contract in docs/PROTOCOL.md end to end. It lives next to the CLI
 * because it drives `afk start` and `afk run` as child processes; the server side is
 * the same `createApp` the unit tests use, listening on a random local port with an
 * in-memory store so the test can read back what the client sent.
 *
 * Unlike the rest of the suite this test needs wall-clock time (the client samples at
 * 1 Hz) and a real socket. Every wait is a bounded poll with a deadline rather than a
 * fixed sleep, every child process is killed in `afterEach`, and the whole file is
 * skipped off macOS because the collectors only exist there. See docs/TESTING.md.
 */
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FramesResponse,
  ServiceStats,
  SessionSummary,
  StoredFrame,
  StreamEventName,
} from "@afk/shared";
import type { HostInfo, RunFrame } from "@afk/shared";
import { createApp } from "../packages/server/src/app.ts";
import {
  DEFAULT_LIMITS,
  DEFAULT_MINIMUM_VERSIONS,
  DEFAULT_SSE_KEEPALIVE_MS,
} from "../packages/server/src/env.ts";
import type { AdmissionLimits } from "../packages/server/src/env.ts";
import { SessionStore } from "../packages/server/src/store/sessions.ts";
import { MemorySessionStorage } from "../packages/server/src/store/storage.ts";

const execFileAsync = promisify(execFile);
const AFK_SCRIPT = fileURLToPath(new URL("./afk", import.meta.url));
const LOOPBACK = "127.0.0.1";

/** Each scenario runs the 1 Hz client for a few seconds; this leaves headroom for a slow machine. */
const TEST_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;
/** Deadline for a condition that needs one or two client ticks. */
const WAIT_DEADLINE_MS = 5_000;
/** After an outage the client backs off 1 s before its first retry, then needs more ticks to catch up. */
const CATCH_UP_DEADLINE_MS = 8_000;
/** How long a signalled client gets to run its shutdown trap before it is killed outright. */
const KILL_GRACE_MS = 3_000;
/** How many system frames to wait for before acting on a session; two proves sequencing. */
const MIN_SYSTEM_FRAMES = 2;
/** How far past the pre-outage sequence the client must get to show it resumed live sampling. */
const CATCH_UP_SEQUENCES = 3;
/** Wall time the wrapped command in the owner scenario runs, so its session collects system frames. */
const OWNED_RUN_SECONDS = 2;

const SINGLE_SESSION_LIMITS: AdmissionLimits = {
  maxActiveSessions: 1,
  maxStreamsPerSession: DEFAULT_LIMITS.maxStreamsPerSession,
};

/** The dashboard URL the client prints; the capture group is the session id. */
const DASHBOARD_URL_PATTERN = /\/s\/([A-Za-z0-9]+)/;
const RUN_STREAM_PATTERN = /^run:([0-9a-f]+)$/;

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

/** Polls `probe` until it returns a value, or fails with `description` once the deadline passes. */
async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined> | T | undefined,
  deadlineMs = WAIT_DEADLINE_MS,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  while (true) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${deadlineMs} ms waiting for ${description}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** `waitFor` for a plain condition. */
async function waitUntil(
  description: string,
  condition: () => Promise<boolean> | boolean,
  deadlineMs = WAIT_DEADLINE_MS,
): Promise<void> {
  await waitFor(description, async () => ((await condition()) ? true : undefined), deadlineMs);
}

// ---------------------------------------------------------------------------
// the server under test
// ---------------------------------------------------------------------------

interface TestServer {
  url: string;
  /** Closes the listener but keeps the store, like a server outage or restart. */
  stop(): Promise<void>;
  /** Listens again on the same port after `stop`. */
  resume(): Promise<void>;
  close(): Promise<void>;
}

/** The real app on a random loopback port, backed by an in-memory store. */
async function startServer(limits: AdmissionLimits, webDistDir: string): Promise<TestServer> {
  const store = new SessionStore(new MemorySessionStorage(), { limits });
  // The app is built once the port is known, since dashboard URLs embed it. No request
  // can arrive before then because nobody knows the port either.
  const wiring: { app?: ReturnType<typeof createApp> } = {};
  let listener: Server | undefined;

  async function listen(port: number): Promise<number> {
    const server = serve({
      fetch: (request) => {
        if (!wiring.app) {
          throw new Error("request arrived before the app was wired");
        }
        return wiring.app.fetch(request);
      },
      port,
      hostname: LOOPBACK,
      overrideGlobalObjects: false,
    }) as Server;
    await once(server, "listening");
    listener = server;
    return (server.address() as AddressInfo).port;
  }

  async function stop(): Promise<void> {
    if (!listener) {
      return;
    }
    const server = listener;
    listener = undefined;
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  }

  const port = await listen(0);
  const url = `http://${LOOPBACK}:${port}`;
  wiring.app = createApp(
    {
      publicBaseUrl: url,
      webDistDir,
      clientScriptPath: AFK_SCRIPT,
      limits,
      sseKeepaliveMs: DEFAULT_SSE_KEEPALIVE_MS,
      minimumVersions: DEFAULT_MINIMUM_VERSIONS,
    },
    store,
  );

  return {
    url,
    stop,
    resume: async () => {
      await listen(port);
    },
    close: stop,
  };
}

// ---------------------------------------------------------------------------
// the client under test
// ---------------------------------------------------------------------------

interface AfkProcess {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** The exit code once the process has exited and its output has been drained. */
  exited: Promise<number | null>;
}

/** Sends `signal` to the process group `pid` leads; ignores a group that is already gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: nothing left to signal.
  }
}

/**
 * Asks the process to end (its TERM trap ends the session), then kills its whole
 * process group so a background sender loop or a `sleep` never outlives the test.
 */
async function terminate(proc: AfkProcess): Promise<void> {
  const { child } = proc;
  if (child.pid === undefined) {
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exit, delay(KILL_GRACE_MS)]);
  }
  signalGroup(child.pid, "SIGKILL");
}

let server: TestServer;
let afkHome: string;
let webDistDir: string;
const children: AfkProcess[] = [];
const tempDirs: string[] = [];

/** A fresh directory for one test, removed in afterEach. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), "afk-contract-"));
  tempDirs.push(dir);
  return dir;
}

/** Runs `afk <args>` against the test server with `afkHome` as its state directory. */
function spawnAfk(args: string[], home: string): AfkProcess {
  const child = spawn("/bin/bash", [AFK_SCRIPT, ...args], {
    env: { ...process.env, AFK_HOME: home, AFK_SERVER: server.url },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so cleanup can reach the background subshells too.
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  const proc: AfkProcess = { child, stdout: () => stdout, stderr: () => stderr, exited };
  children.push(proc);
  return proc;
}

/** The session id from the dashboard URL the client prints once its session exists. */
async function dashboardSessionId(proc: AfkProcess): Promise<string> {
  return waitFor("the client to print its dashboard URL", () => {
    const match = DASHBOARD_URL_PATTERN.exec(proc.stdout());
    return match?.[1];
  });
}

/** `afk start`, resolved once it has a session. */
async function startSession(home: string): Promise<{ proc: AfkProcess; sessionId: string }> {
  const proc = spawnAfk(["start"], home);
  const sessionId = await dashboardSessionId(proc);
  return { proc, sessionId };
}

// ---------------------------------------------------------------------------
// reading the server, through its own API, validated against the shared schemas
// ---------------------------------------------------------------------------

async function readFrames(sessionId: string): Promise<FramesResponse> {
  const res = await fetch(`${server.url}/api/sessions/${sessionId}/frames`);
  const parsed = FramesResponse.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`frames response violates the schema: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

async function readSummary(sessionId: string): Promise<SessionSummary> {
  const res = await fetch(`${server.url}/api/sessions/${sessionId}`);
  return SessionSummary.parse(await res.json());
}

async function readStats(): Promise<ServiceStats> {
  const res = await fetch(`${server.url}/api/stats`);
  return ServiceStats.parse(await res.json());
}

function systemSequences(frames: StoredFrame[]): number[] {
  return frames.filter((f) => f.frame.collector === "system").map((f) => f.frame.sequence);
}

/** The highest-sequence frame of the session's single `run:` stream, once it has exited. */
function finalRunFrame(frames: StoredFrame[]): (StoredFrame & { frame: RunFrame }) | undefined {
  const runFrames = frames.filter(
    (f): f is StoredFrame & { frame: RunFrame } => f.frame.collector === "run",
  );
  const last = runFrames.at(-1);
  return last?.frame.data.state === "exited" ? last : undefined;
}

async function waitForSystemFrames(sessionId: string, count: number): Promise<FramesResponse> {
  return waitFor(`${count} system frames`, async () => {
    const response = await readFrames(sessionId);
    return systemSequences(response.frames).length >= count ? response : undefined;
  });
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** What the client should report about this machine, from the same sources it reads. */
async function thisHost(): Promise<HostInfo> {
  const { stdout } = await execFileAsync("sw_vers", ["-productVersion"]);
  return {
    hostname: os.hostname().replace(/\..*$/, ""),
    platform: process.platform,
    osVersion: stdout.trim(),
    cpuCount: os.cpus().length,
    memoryTotalBytes: os.totalmem(),
  };
}

/** One parsed `event: ... \n data: ... \n id: ...` SSE message. */
interface ParsedSSE {
  event: string;
  id?: string;
  data: unknown;
}

/** Parses an SSE body into its messages, dropping bare keepalive comments. */
function parseSSE(text: string): ParsedSSE[] {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("event: "))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))!.slice("event: ".length);
      const id = lines.find((l) => l.startsWith("id: "))?.slice("id: ".length);
      const dataLine = lines.find((l) => l.startsWith("data: "))!.slice("data: ".length);
      return { event, id, data: JSON.parse(dataLine) };
    });
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "darwin")(
  "cli/afk against the server over HTTP",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    beforeEach(async () => {
      afkHome = await makeTempDir();
      webDistDir = await makeTempDir();
      server = await startServer(DEFAULT_LIMITS, webDistDir);
    });

    afterEach(async () => {
      await Promise.all(children.splice(0).map((proc) => terminate(proc)));
      await server.close();
      await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it("afk start creates a session for this host, streams schema-valid system frames, and ends it on SIGTERM", async () => {
      const { proc, sessionId } = await startSession(afkHome);
      const { session, frames } = await waitForSystemFrames(sessionId, MIN_SYSTEM_FRAMES);

      proc.child.kill("SIGTERM");
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(session).toMatchObject({ sessionId, status: "active", host: await thisHost() });
      // readFrames already validated every frame against the shared Frame schema. The
      // client also runs other machine collectors (processes, ...) on their own
      // intervals, so pin only the contract: session-wide indexes are contiguous and
      // the system stream's sequences are contiguous from 1.
      expect(frames.map((f) => f.index)).toEqual(range(1, frames.length));
      expect(systemSequences(frames)).toEqual(range(1, systemSequences(frames).length));
      expect(new Set(frames.map((f) => f.frame.stream))).toContain("system");
      expect(await readSummary(sessionId)).toMatchObject({ sessionId, status: "ended" });
      expect(await readdir(join(afkHome, "sessions", sessionId, "queue"))).toEqual([]);
    });

    it("resends after an outage so every system sequence lands exactly once, with no gaps or duplicates", async () => {
      const { proc, sessionId } = await startSession(afkHome);
      const before = await waitForSystemFrames(sessionId, MIN_SYSTEM_FRAMES);
      const lastBefore = Math.max(...systemSequences(before.frames));

      await server.stop();
      await waitUntil("the client to log a retry", () => proc.stderr().includes("retrying"));
      await server.resume();
      await waitUntil(
        "the client to deliver the frames sampled during the outage and resume live",
        async () => {
          const { frames } = await readFrames(sessionId);
          return Math.max(...systemSequences(frames)) >= lastBefore + CATCH_UP_SEQUENCES;
        },
        CATCH_UP_DEADLINE_MS,
      );
      proc.child.kill("SIGTERM");
      await proc.exited;

      const { frames } = await readFrames(sessionId);
      const sequences = systemSequences(frames);
      expect(sequences.length).toBeGreaterThan(lastBefore);
      expect(sequences).toEqual(range(1, sequences.length));
      expect(proc.stderr()).toMatch(/send failed.*retrying/);
    });

    it("afk run joins the session afk start owns and reports the command's output volume and exit code", async () => {
      const { sessionId } = await startSession(afkHome);
      // The owner ships its first batch a tick after starting; wait for it so the run's
      // frames land in a session that already has its system stream.
      await waitForSystemFrames(sessionId, MIN_SYSTEM_FRAMES);

      const run = spawnAfk(["run", "--", "sh", "-c", "echo out; echo err >&2; exit 3"], afkHome);
      const exitCode = await run.exited;

      expect(exitCode).toBe(3);
      expect(run.stdout()).toContain("out");
      const { session, frames } = await waitFor("the run's exited frame", async () => {
        const response = await readFrames(sessionId);
        return finalRunFrame(response.frames) ? response : undefined;
      });
      // One run stream on top of however many machine streams the owner collects.
      expect(session).toMatchObject({ sessionId, status: "active" });
      expect(session.streamCount).toBe(new Set(frames.map((f) => f.frame.stream)).size);
      const final = finalRunFrame(frames)!;
      expect(final.frame.stream).toMatch(RUN_STREAM_PATTERN);
      // `pid` is deliberately not pinned: PROTOCOL.md says it is 0 once the process is
      // gone, but the client's final frame still carries the pid it recorded at start.
      expect(final.frame.data).toMatchObject({
        command: "sh -c echo out; echo err >&2; exit 3",
        state: "exited",
        exitCode: 3,
        output: { flavor: "volume" },
      });
      expect(final.frame.data.output.stdoutBytes).toBeGreaterThanOrEqual("out\n".length);
      expect(final.frame.data.output.stderrBytes).toBeGreaterThanOrEqual("err\n".length);
      const runId = RUN_STREAM_PATTERN.exec(final.frame.stream)![1]!;
      const joinerQueue = join(afkHome, "sessions", sessionId, "runs", runId, "queue");
      expect(await readdir(joinerQueue)).toEqual([]);
    });

    it("afk run without afk start creates its own session with system frames and ends it when the command exits", async () => {
      const run = spawnAfk(["run", "--", "sleep", String(OWNED_RUN_SECONDS)], afkHome);
      const sessionId = await dashboardSessionId(run);

      const exitCode = await run.exited;

      expect(exitCode).toBe(0);
      const { session, frames } = await readFrames(sessionId);
      expect(session).toMatchObject({ sessionId, status: "ended" });
      expect(session.streamCount).toBe(new Set(frames.map((f) => f.frame.stream)).size);
      expect(systemSequences(frames).length).toBeGreaterThanOrEqual(1);
      expect(finalRunFrame(frames)?.frame.data).toMatchObject({
        command: `sleep ${OWNED_RUN_SECONDS}`,
        state: "exited",
        exitCode: 0,
      });
      expect(finalRunFrame(frames)?.frame.data.elapsedSeconds).toBeGreaterThanOrEqual(
        OWNED_RUN_SECONDS,
      );
      expect(await readdir(join(afkHome, "sessions", sessionId, "queue"))).toEqual([]);
    });

    it("at capacity, afk start waits for a slot and afk run falls back to running without telemetry", async () => {
      await server.close();
      server = await startServer(SINGLE_SESSION_LIMITS, webDistDir);
      await startSession(afkHome);
      // Other machines: no `current` session file to join.
      const waiting = spawnAfk(["start"], await makeTempDir());
      const fallback = spawnAfk(
        ["run", "--", "sh", "-c", "echo alone; exit 7"],
        await makeTempDir(),
      );

      await waitUntil("the second afk start to announce its wait", () =>
        waiting.stderr().includes("retrying in"),
      );
      const exitCode = await fallback.exited;

      expect(waiting.stderr()).toContain("at capacity");
      expect(waiting.child.exitCode).toBeNull();
      expect(waiting.stdout()).not.toMatch(DASHBOARD_URL_PATTERN);
      expect(exitCode).toBe(7);
      expect(fallback.stdout()).toContain("alone");
      expect(fallback.stdout()).not.toMatch(DASHBOARD_URL_PATTERN);
      expect(fallback.stderr()).toContain("running without telemetry");
      expect(await readStats()).toMatchObject({ activeSessions: 1, maxActiveSessions: 1 });
      await terminate(waiting);
    });

    it("the stream replays session, then frames whose id is their index, then end for an ended session", async () => {
      const { proc, sessionId } = await startSession(afkHome);
      await waitForSystemFrames(sessionId, MIN_SYSTEM_FRAMES);
      proc.child.kill("SIGTERM");
      await proc.exited;

      const res = await fetch(`${server.url}/api/sessions/${sessionId}/stream`);
      // The server closes the stream after `end`, so the whole body can be read at once.
      const body = await res.text();

      expect(res.headers.get("content-type")).toContain("text/event-stream");
      // Anomaly events depend on the machine's state (memory pressure), so they are not pinned.
      const messages = parseSSE(body).filter((m) => m.event !== StreamEventName.Event);
      const frames = messages.slice(1, -1);
      expect(frames.length).toBeGreaterThanOrEqual(MIN_SYSTEM_FRAMES);
      expect(messages.map((m) => m.event)).toEqual([
        StreamEventName.Session,
        ...frames.map(() => StreamEventName.Frame),
        StreamEventName.End,
      ]);
      expect(messages[0]!.data).toMatchObject({ sessionId, status: "ended" });
      expect(frames.map((m) => ({ id: m.id, index: StoredFrame.parse(m.data).index }))).toEqual(
        range(1, frames.length).map((n) => ({ id: String(n), index: n })),
      );
      expect(messages.at(-1)!.data).toMatchObject({ sessionId, status: "ended" });
    });
  },
);
