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
import { existsSync } from "node:fs";
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
import { DEFAULT_LIMITS } from "../packages/server/src/env.ts";
import { makeAppConfig } from "../packages/server/src/routes/test-helpers.ts";
import type { AdmissionLimits } from "../packages/server/src/env.ts";
import { SessionStore } from "../packages/server/src/store/sessions.ts";
import { MemorySessionStorage } from "../packages/server/src/store/storage.ts";

const execFileAsync = promisify(execFile);
const AFK_SCRIPT = fileURLToPath(new URL("./afk", import.meta.url));
const LOOPBACK = "127.0.0.1";

/**
 * Each scenario runs the 1 Hz client for a few seconds; this leaves headroom for a
 * slow machine, and for the waits below to report what they were waiting for rather
 * than being cut short by the scenario's own deadline.
 */
const TEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
/**
 * Deadline for a condition that needs one or two client ticks. A tick is a second of
 * sampling plus however long the collectors take, and the frame it produces waits for
 * the sender's next second, so two ticks are three or four seconds on an idle machine
 * and more on a busy one (this suite runs several clients at once, and CI runs it
 * beside everything else). The deadline is generous because it costs nothing until a
 * test is failing anyway, and a deadline tighter than the client's own cadence fails
 * tests that are about to pass.
 */
const WAIT_DEADLINE_MS = 12_000;
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
/**
 * The chain scenario runs the server with this cap: the client chains a quarter of it
 * (3 s) before the cap, so the successor exists about 9 s in.
 */
const CHAIN_CAP_SECONDS = 12;
/**
 * A joiner that outlives the first session, so its run stream has to follow the chain:
 * long enough to span the chain moment on a slow machine, short enough to exit before
 * the successor chains in turn.
 */
const CHAIN_RUN_SECONDS = 11;
/** Deadline for the successor's URL to appear: the chain moment plus a slow machine. */
const CHAIN_DEADLINE_MS = 15_000;
/** The chain scenario needs the whole cap plus shutdown, more than the default. */
const CHAIN_TEST_TIMEOUT_MS = 40_000;
/**
 * The delete scenario's command prints once a second for this long: enough for the
 * session to collect frames, be deleted under it, and still have lines left to print.
 */
const DELETED_RUN_SECONDS = 4;
/** How many `afk run`s join one `afk start` at once in the concurrency scenario. */
const CONCURRENT_RUNS = 5;
/** Each of them prints a line a second for this long. */
const CONCURRENT_RUN_SECONDS = 10;
/** A run joined to an owning `afk run` outlives the owner's command (OWNED_RUN_SECONDS) by this much. */
const JOINED_RUN_SECONDS = 5;
/** The concurrency scenarios run their commands for up to ten seconds, plus startup and shutdown. */
const CONCURRENT_TEST_TIMEOUT_MS = 40_000;
/** The streams `afk start` opens on its own: system, processes, agents. */
const FIXED_STREAMS = 3;

const SINGLE_SESSION_LIMITS: AdmissionLimits = { ...DEFAULT_LIMITS, maxActiveSessions: 1 };
/** Room for the owner's streams and exactly one run. */
const ONE_RUN_LIMITS: AdmissionLimits = {
  ...DEFAULT_LIMITS,
  maxStreamsPerSession: FIXED_STREAMS + 1,
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
  /** Every request the app has seen, in arrival order: `METHOD /path` and when. */
  requests: { line: string; at: number }[];
  /** Closes the listener but keeps the store, like a server outage or restart. */
  stop(): Promise<void>;
  /** Listens again on the same port after `stop`. */
  resume(): Promise<void>;
  close(): Promise<void>;
}

/** The real app on a random loopback port, backed by an in-memory store. */
async function startServer(
  limits: AdmissionLimits,
  webDistDir: string,
  storeOptions: { maxSessionDurationSeconds?: number } = {},
): Promise<TestServer> {
  const store = new SessionStore(new MemorySessionStorage(), { limits, ...storeOptions });
  // The app is built once the port is known, since dashboard URLs embed it. No request
  // can arrive before then because nobody knows the port either.
  const wiring: { app?: ReturnType<typeof createApp> } = {};
  const requests: TestServer["requests"] = [];
  let listener: Server | undefined;

  async function listen(port: number): Promise<number> {
    const server = serve({
      fetch: (request) => {
        if (!wiring.app) {
          throw new Error("request arrived before the app was wired");
        }
        requests.push({
          line: `${request.method} ${new URL(request.url).pathname}`,
          at: Date.now(),
        });
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
    makeAppConfig({ publicBaseUrl: url, webDistDir, clientScriptPath: AFK_SCRIPT, limits }),
    store,
  );

  return {
    url,
    requests,
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

/** The `run:` streams whose last frame says the command exited. */
function exitedRunStreams(frames: StoredFrame[]): string[] {
  const last = new Map<string, RunFrame>();
  for (const { frame } of frames) {
    if (frame.collector === "run") {
      last.set(frame.stream, frame);
    }
  }
  return [...last.entries()].filter(([, f]) => f.data.state === "exited").map(([s]) => s);
}

/**
 * How many seconds each `run:` stream covers: its last frame's timestamp less its
 * first's, which is how long the run was sampled for. Timestamps are whole seconds,
 * so a span is a second either side of the wall time it stands for.
 */
function runSpanSeconds(frames: StoredFrame[]): Map<string, number> {
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  for (const { frame } of frames) {
    if (frame.collector === "run") {
      if (!first.has(frame.stream)) {
        first.set(frame.stream, frame.timestamp);
      }
      last.set(frame.stream, frame.timestamp);
    }
  }
  return new Map([...last].map(([stream, end]) => [stream, end - first.get(stream)!]));
}

/** Each `run:` stream's sequences in arrival order. */
function runSequences(frames: StoredFrame[]): Map<string, number[]> {
  const sequences = new Map<string, number[]>();
  for (const { frame } of frames) {
    if (frame.collector === "run") {
      sequences.set(frame.stream, [...(sequences.get(frame.stream) ?? []), frame.sequence]);
    }
  }
  return sequences;
}

/** A shell command that prints `run <n> line <i>` once a second for `seconds` seconds. */
function countingCommand(seconds: number, n: number): string {
  return `i=1; while [ $i -le ${seconds} ]; do echo "run ${n} line $i"; sleep 1; i=$((i + 1)); done`;
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
        // A failed command ships the tail of what it printed on its final frame.
        output: { flavor: "volume", tail: { stdout: ["out"], stderr: ["err"], truncated: false } },
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

    it(
      "afk start chains to a successor before the cap, linked both ways, with sequences restarting at 1, and a joined afk run follows it",
      { timeout: CHAIN_TEST_TIMEOUT_MS },
      async () => {
        await server.close();
        server = await startServer(DEFAULT_LIMITS, webDistDir, {
          maxSessionDurationSeconds: CHAIN_CAP_SECONDS,
        });
        const { proc, sessionId: first } = await startSession(afkHome);
        await waitForSystemFrames(first, MIN_SYSTEM_FRAMES);
        const run = spawnAfk(["run", "--", "sleep", String(CHAIN_RUN_SECONDS)], afkHome);

        const second = await waitFor(
          "the client to print its successor's URL",
          () => {
            const ids = [...proc.stdout().matchAll(new RegExp(DASHBOARD_URL_PATTERN, "g"))];
            return ids.map((match) => match[1]).find((id) => id !== first);
          },
          CHAIN_DEADLINE_MS,
        );
        await run.exited;
        // The joiner re-attaches a second after its first 410, then resends.
        const { session: secondSession, frames: secondFrames } = await waitFor(
          "the run's exited frame in the successor",
          async () => {
            const response = await readFrames(second);
            return finalRunFrame(response.frames) ? response : undefined;
          },
          CATCH_UP_DEADLINE_MS,
        );
        proc.child.kill("SIGTERM");
        await proc.exited;

        const firstSession = await readSummary(first);
        const { frames: firstFrames } = await readFrames(first);
        expect(firstSession).toMatchObject({
          status: "ended",
          previousSessionId: null,
          nextSessionId: second,
        });
        // Ended by the chain, before its cap, and with its whole queue delivered first.
        expect(firstSession.endedAt).toBeLessThan(
          firstSession.startedAt + CHAIN_CAP_SECONDS * 1000,
        );
        expect(await readdir(join(afkHome, "sessions", first, "queue"))).toEqual([]);
        expect(await readdir(join(afkHome, "sessions", first))).toContain("done");
        expect(secondSession).toMatchObject({
          status: "active",
          previousSessionId: first,
          nextSessionId: null,
        });
        expect(secondSession.startedAt).toBeGreaterThanOrEqual(firstSession.endedAt!);
        const secondSequences = systemSequences(secondFrames);
        expect(secondSequences).toEqual(range(1, secondSequences.length));
        expect(secondFrames.map((f) => f.index)).toEqual(range(1, secondFrames.length));
        // The joiner's run stream spans the chain: sampled in the first session, exited in the second.
        const runStream = finalRunFrame(secondFrames)!.frame.stream;
        expect(firstFrames.some((f) => f.frame.stream === runStream)).toBe(true);
        expect(finalRunFrame(secondFrames)!.frame.data).toMatchObject({ exitCode: 0 });
        expect(run.stderr()).toContain(`session ${first} ended; continuing in session ${second}`);
        expect(proc.stderr()).toContain(
          `session ${first} reached its ${CHAIN_CAP_SECONDS}s cap; continuing in session ${second}`,
        );
        expect(await readSummary(second)).toMatchObject({ status: "ended" });
        expect(await readStats()).toMatchObject({ activeSessions: 0 });
      },
    );

    it(
      "an afk run that owns its session chains before the cap and finishes the run in the successor, ending it",
      { timeout: CHAIN_TEST_TIMEOUT_MS },
      async () => {
        await server.close();
        server = await startServer(DEFAULT_LIMITS, webDistDir, {
          maxSessionDurationSeconds: CHAIN_CAP_SECONDS,
        });
        const run = spawnAfk(["run", "--", "sleep", String(CHAIN_RUN_SECONDS)], afkHome);
        const first = await dashboardSessionId(run);

        const second = await waitFor(
          "the run to print its successor's URL",
          () => {
            const ids = [...run.stdout().matchAll(new RegExp(DASHBOARD_URL_PATTERN, "g"))];
            return ids.map((match) => match[1]).find((id) => id !== first);
          },
          CHAIN_DEADLINE_MS,
        );
        const exitCode = await run.exited;

        expect(exitCode).toBe(0);
        const firstSession = await readSummary(first);
        const { frames: firstFrames } = await readFrames(first);
        const { session: secondSession, frames: secondFrames } = await readFrames(second);
        expect(firstSession).toMatchObject({ status: "ended", nextSessionId: second });
        expect(secondSession).toMatchObject({
          status: "ended",
          previousSessionId: first,
          nextSessionId: null,
        });
        // The run's stream spans the chain: sampled in the first session, exited in the
        // second with its sequence still counting up.
        const final = finalRunFrame(secondFrames)!;
        expect(final.frame.data).toMatchObject({
          command: `sleep ${CHAIN_RUN_SECONDS}`,
          exitCode: 0,
        });
        const runStream = final.frame.stream;
        const firstRunSequences = firstFrames
          .filter((f) => f.frame.stream === runStream)
          .map((f) => f.frame.sequence);
        expect(firstRunSequences.length).toBeGreaterThan(0);
        expect(final.frame.sequence).toBeGreaterThan(Math.max(...firstRunSequences));
        expect(systemSequences(secondFrames)[0]).toBe(1);
        expect(run.stderr()).toContain(
          `session ${first} reached its ${CHAIN_CAP_SECONDS}s cap; continuing in session ${second}`,
        );
        expect(await readStats()).toMatchObject({ activeSessions: 0 });
        expect(await readdir(join(afkHome, "sessions", first, "queue"))).toEqual([]);
        expect(await readdir(join(afkHome, "sessions", second, "queue"))).toEqual([]);
      },
    );

    it("deleting a session from the dashboard side stops the client's telemetry, leaves its command running, and makes the session a 404", async () => {
      const command = `for i in 1 2 3 ${DELETED_RUN_SECONDS}; do echo out $i; sleep 1; done`;
      const run = spawnAfk(["run", "--", "sh", "-c", command], afkHome);
      const sessionId = await dashboardSessionId(run);
      await waitForSystemFrames(sessionId, MIN_SYSTEM_FRAMES);

      // The dashboard's call: no token, no client header, just the link.
      const deleted = await fetch(`${server.url}/api/sessions/${sessionId}`, { method: "DELETE" });
      const deletedAt = Date.now();
      const exitCode = await run.exited;

      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({ sessionId });
      expect(exitCode).toBe(0);
      expect(run.stdout()).toContain(`out 1\nout 2\nout 3\nout ${DELETED_RUN_SECONDS}\n`);
      expect(run.stderr()).toContain(
        `afk: session ${sessionId} was deleted on the server; telemetry stopped`,
      );
      // The client learned of the deletion from one 404 and sent nothing after it: no
      // more batches, no end, and no successor session.
      const afterDelete = server.requests
        .filter((req) => req.at >= deletedAt)
        .map((req) => req.line);
      expect(afterDelete.filter((line) => line.endsWith("/frames"))).toHaveLength(1);
      expect(afterDelete.filter((line) => line.endsWith("/end"))).toEqual([]);
      expect(afterDelete.filter((line) => line === "POST /api/sessions")).toEqual([]);
      const summary = await fetch(`${server.url}/api/sessions/${sessionId}`);
      expect(summary.status).toBe(404);
      expect(await summary.json()).toMatchObject({ details: { reason: "deleted" } });
      expect(await readStats()).toMatchObject({ activeSessions: 0 });
      expect(await readdir(join(afkHome, "sessions", sessionId, "queue"))).toEqual([]);
    });

    it(
      "five afk runs joined to one afk start each land a contiguous run stream, leave the system stream whole, and empty their queues",
      { timeout: CONCURRENT_TEST_TIMEOUT_MS },
      async () => {
        const { proc, sessionId } = await startSession(afkHome);
        await waitForSystemFrames(sessionId, MIN_SYSTEM_FRAMES);

        const runs = Array.from({ length: CONCURRENT_RUNS }, (_, i) =>
          spawnAfk(["run", "--", "sh", "-c", countingCommand(CONCURRENT_RUN_SECONDS, i)], afkHome),
        );
        const exitCodes = await Promise.all(runs.map((run) => run.exited));
        const { frames } = await waitFor(
          `${CONCURRENT_RUNS} exited run frames`,
          async () => {
            const response = await readFrames(sessionId);
            return exitedRunStreams(response.frames).length === CONCURRENT_RUNS
              ? response
              : undefined;
          },
          CATCH_UP_DEADLINE_MS,
        );
        proc.child.kill("SIGTERM");
        await proc.exited;

        expect(exitCodes).toEqual(runs.map(() => 0));
        runs.forEach((run, i) => {
          expect(run.stdout()).toContain(`run ${i} line ${CONCURRENT_RUN_SECONDS}`);
          expect(run.stderr()).not.toMatch(/server closed|rejected|no room|send failed/);
        });
        // Every run stream's sequences are contiguous from 1 (no gap, no duplicate),
        // and each run sampled from the start of its command to the end of it. The
        // span, not a frame count, is what says so: a run sampler sleeps a second
        // between samples, so its frames are a second plus a sample apart and five
        // runs sampling at once on a busy machine drift to nine frames in ten
        // seconds without missing any of them.
        const sequences = runSequences(frames);
        expect(sequences.size).toBe(CONCURRENT_RUNS);
        for (const streamSequences of sequences.values()) {
          expect(streamSequences).toEqual(range(1, streamSequences.length));
        }
        for (const span of runSpanSeconds(frames).values()) {
          expect(span).toBeGreaterThanOrEqual(CONCURRENT_RUN_SECONDS - 1);
        }
        expect(systemSequences(frames)).toEqual(range(1, systemSequences(frames).length));
        expect(frames.map((f) => f.index)).toEqual(range(1, frames.length));
        expect(await readSummary(sessionId)).toMatchObject({
          status: "ended",
          streamCount: new Set(frames.map((f) => f.frame.stream)).size,
        });
        expect(await readdir(join(afkHome, "sessions", sessionId, "queue"))).toEqual([]);
        for (const runId of await readdir(join(afkHome, "sessions", sessionId, "runs"))) {
          const runDir = join(afkHome, "sessions", sessionId, "runs", runId);
          expect(await readdir(join(runDir, "queue"))).toEqual([]);
          expect(await readdir(runDir)).not.toContain("rejected");
        }
      },
    );

    it(
      "an afk run that owns its session keeps it open for the runs that joined it until they finish, then ends it",
      { timeout: CONCURRENT_TEST_TIMEOUT_MS },
      async () => {
        const owner = spawnAfk(["run", "--", "sleep", String(OWNED_RUN_SECONDS)], afkHome);
        const sessionId = await dashboardSessionId(owner);
        const joiners = [0, 1].map((i) =>
          spawnAfk(["run", "--", "sh", "-c", countingCommand(JOINED_RUN_SECONDS, i)], afkHome),
        );

        const joinerExits = await Promise.all(joiners.map((run) => run.exited));
        const joinersDoneAt = Date.now();
        const ownerExit = await owner.exited;
        const ownerDoneAt = Date.now();

        expect(joinerExits).toEqual([0, 0]);
        expect(ownerExit).toBe(0);
        for (const joiner of joiners) {
          expect(joiner.stderr()).toContain(`joining session ${sessionId}`);
          expect(joiner.stderr()).not.toMatch(/server closed the session|send failed/);
        }
        expect(owner.stderr()).toContain(
          `2 joined afk run(s) still going; keeping session ${sessionId} open until they finish`,
        );
        // The owner's command was over long before; the owner itself outlived the joiners.
        expect(ownerDoneAt).toBeGreaterThanOrEqual(joinersDoneAt);
        const { session, frames } = await readFrames(sessionId);
        expect(session).toMatchObject({ sessionId, status: "ended" });
        // All three runs exited inside the one session, each stream contiguous.
        expect(exitedRunStreams(frames)).toHaveLength(3);
        for (const streamSequences of runSequences(frames).values()) {
          expect(streamSequences).toEqual(range(1, streamSequences.length));
        }
        expect(systemSequences(frames).length).toBeGreaterThanOrEqual(JOINED_RUN_SECONDS);
        expect(await readStats()).toMatchObject({ activeSessions: 0 });
        expect(await readdir(join(afkHome, "sessions", sessionId, "queue"))).toEqual([]);
        // The owner's own run has no queue of its own (it spools with the session); the joiners do.
        const runDirs = await readdir(join(afkHome, "sessions", sessionId, "runs"));
        const joinerQueues = (
          await Promise.all(
            runDirs.map((runId) => join(afkHome, "sessions", sessionId, "runs", runId, "queue")),
          )
        ).filter((queue) => existsSync(queue));
        expect(joinerQueues).toHaveLength(2);
        for (const queue of joinerQueues) {
          expect(await readdir(queue)).toEqual([]);
        }
      },
    );

    it(
      "at the stream cap, of two afk runs joining at once the one past the cap runs without telemetry and the rest of the session is untouched",
      { timeout: CONCURRENT_TEST_TIMEOUT_MS },
      async () => {
        await server.close();
        server = await startServer(ONE_RUN_LIMITS, webDistDir);
        const { proc, sessionId } = await startSession(afkHome);
        // The owner's three streams are what the cap leaves one slot beside.
        await waitUntil(
          "the owner's fixed streams to land",
          async () => (await readSummary(sessionId)).streamCount === FIXED_STREAMS,
        );

        // Both check the stream count before either's first batch lands, so both join
        // and the server turns the second first batch away.
        const runs = [0, 1].map((i) =>
          spawnAfk(["run", "--", "sh", "-c", countingCommand(JOINED_RUN_SECONDS, i)], afkHome),
        );
        const exitCodes = await Promise.all(runs.map((run) => run.exited));
        const before = await readFrames(sessionId);
        await waitForSystemFrames(sessionId, systemSequences(before.frames).length + 2);
        proc.child.kill("SIGTERM");
        await proc.exited;

        expect(exitCodes).toEqual([0, 0]);
        runs.forEach((run, i) => {
          expect(run.stdout()).toContain(`run ${i} line ${JOINED_RUN_SECONDS}`);
          expect(run.stderr()).toContain(`joining session ${sessionId}`);
        });
        const noRoom = runs.filter((run) =>
          run
            .stderr()
            .includes(
              `session ${sessionId} has no room for another run (the server allows ${ONE_RUN_LIMITS.maxStreamsPerSession} streams per session); running without telemetry`,
            ),
        );
        expect(noRoom).toHaveLength(1);
        const withRoom = runs.find((run) => run !== noRoom[0])!;
        expect(withRoom.stderr()).not.toMatch(/no room|rejected|send failed/);
        const { session, frames } = await readFrames(sessionId);
        expect(session).toMatchObject({ status: "ended", streamCount: FIXED_STREAMS + 1 });
        expect(exitedRunStreams(frames)).toHaveLength(1);
        for (const streamSequences of runSequences(frames).values()) {
          expect(streamSequences).toEqual(range(1, streamSequences.length));
        }
        expect(systemSequences(frames)).toEqual(range(1, systemSequences(frames).length));
        // The turned-away run dropped its queue rather than parking it, and left its marker.
        const runDirs = await readdir(join(afkHome, "sessions", sessionId, "runs"));
        expect(runDirs).toHaveLength(2);
        const markers = await Promise.all(
          runDirs.map((runId) => readdir(join(afkHome, "sessions", sessionId, "runs", runId))),
        );
        expect(markers.filter((names) => names.includes("no-room"))).toHaveLength(1);
        expect(markers.some((names) => names.includes("rejected"))).toBe(false);
        for (const runId of runDirs) {
          expect(
            await readdir(join(afkHome, "sessions", sessionId, "runs", runId, "queue")),
          ).toEqual([]);
        }
      },
    );

    it("two afk runs started in the same instant with no session running share one session: one creates it, the other joins", async () => {
      const runs = [0, 1].map(() =>
        spawnAfk(["run", "--", "sleep", String(OWNED_RUN_SECONDS)], afkHome),
      );

      const exitCodes = await Promise.all(runs.map((run) => run.exited));

      expect(exitCodes).toEqual([0, 0]);
      const creates = server.requests.filter((req) => req.line === "POST /api/sessions");
      expect(creates).toHaveLength(1);
      const sessionId = await dashboardSessionId(runs[0]!);
      expect(await dashboardSessionId(runs[1]!)).toBe(sessionId);
      const logs = runs.map((run) => run.stderr());
      expect(
        logs.filter((log) => log.includes(`started ${sessionId} with machine telemetry`)),
      ).toHaveLength(1);
      expect(logs.filter((log) => log.includes(`joining session ${sessionId}`))).toHaveLength(1);
      const { session, frames } = await readFrames(sessionId);
      expect(session).toMatchObject({ sessionId, status: "ended" });
      expect(exitedRunStreams(frames)).toHaveLength(2);
      expect(await readStats()).toMatchObject({ activeSessions: 0 });
      expect(await readdir(join(afkHome, "sessions", sessionId, "queue"))).toEqual([]);
    });
  },
);
