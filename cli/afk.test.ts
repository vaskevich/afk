import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  Frame,
  PROCESSES_TOP_MAX,
  ProcessesCollectorData,
  RUN_TAIL_MAX_LINE_CHARS,
  RUN_TAIL_MAX_LINES,
  RunCollectorData,
  RunOutputTail,
  SystemCollectorData,
} from "@afk/shared";
import type { RunFrame } from "@afk/shared";

/** True when the path exists; the tests use it to assert a file was deleted or moved. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The queue's frame files in name order, which is the order the sender ships them in. */
async function queueFiles(sessionDir: string): Promise<string[]> {
  const names = await readdir(join(sessionDir, "queue"));
  return names.filter((name) => name.endsWith(".ndjson")).sort();
}

/** Every queued frame, parsed, in the order the sender ships them. */
async function queuedFrames(sessionDir: string): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (const name of await queueFiles(sessionDir)) {
    const content = await readFile(join(sessionDir, "queue", name), "utf8");
    for (const line of content.split("\n").filter((entry) => entry !== "")) {
      frames.push(Frame.parse(JSON.parse(line)));
    }
  }
  return frames;
}

/**
 * Drives cli/afk through bash rather than reimplementing it: the script is sourced
 * with AFK_SOURCED=1 (see the bottom of cli/afk) so its functions become callable
 * without running `main`. See docs/TESTING.md, "cli" section.
 */

const execFileAsync = promisify(execFile);
const AFK_SCRIPT = fileURLToPath(new URL("./afk", import.meta.url));

interface BashResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Sources cli/afk and runs `snippet` under bash 3.2 (/bin/bash on macOS), with `env` merged in. */
async function runBash(
  snippet: string,
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 5000,
): Promise<BashResult> {
  const script = `source "${AFK_SCRIPT}"\n${snippet}`;
  try {
    const { stdout, stderr } = await execFileAsync("/bin/bash", ["-c", script], {
      env: { ...process.env, AFK_SOURCED: "1", ...env },
      timeout: timeoutMs,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

/** Runs cli/afk itself (not sourced), the way a user would, with `env` merged in. */
async function runAfk(args: string[], env: NodeJS.ProcessEnv = {}): Promise<BashResult> {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/bash", [AFK_SCRIPT, ...args], {
      env: { ...process.env, AFK_SOURCED: "0", ...env },
      timeout: 5000,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

interface AfkProcess {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** The exit code once the process has exited and its output has been drained. */
  exited: Promise<number | null>;
}

const spawned: AfkProcess[] = [];

/**
 * Starts cli/afk as a long-running child (an `afk start` to be stopped from outside),
 * in its own process group so a failing test can still kill its background jobs.
 */
function spawnAfk(args: string[], env: NodeJS.ProcessEnv = {}): AfkProcess {
  const child = spawn("/bin/bash", [AFK_SCRIPT, ...args], {
    env: { ...process.env, AFK_SOURCED: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  const proc: AfkProcess = { child, stdout: () => stdout, stderr: () => stderr, exited };
  spawned.push(proc);
  return proc;
}

afterEach(() => {
  for (const { child } of spawned.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

const POLL_INTERVAL_MS = 50;

/** Polls `condition` until it holds, or fails with `description` once the deadline passes. */
async function waitUntil(
  description: string,
  condition: () => boolean | Promise<boolean>,
  deadlineMs: number,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${deadlineMs} ms waiting for ${description}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** The pids of every process whose arguments mention `text`, e.g. a curl talking to a test server. */
async function processesMentioning(text: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", text]);
    return stdout.split("\n").filter((line) => line !== "");
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
}

/** Parses the `key=value` lines a test snippet prints back out of a bash function's variables. */
function parseKeyValueLines(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    if (line === "") {
      continue;
    }
    const separator = line.indexOf("=");
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

const tempDirs: string[] = [];

/** A fresh directory for one test, removed in afterEach. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "afk-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface TestServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

const servers: TestServer[] = [];

interface TestResponse {
  status: number;
  body?: string;
}

/** A response that never comes: the server holds the request open until it closes. */
const HOLD_REQUEST = new Promise<TestResponse>(() => {
  // Never resolves.
});

/**
 * A local HTTP server that records every request and answers each with `respond`'s
 * result, once it resolves (HOLD_REQUEST keeps a request in flight until the server
 * closes, which drops every open connection).
 */
async function startServer(
  respond: (req: RecordedRequest) => TestResponse | Promise<TestResponse>,
): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      void (async () => {
        const { status, body } = await respond(recorded);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body ?? "{}");
      })();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  const testServer: TestServer = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  servers.push(testServer);
  return testServer;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("json_string", () => {
  it("escapes backslashes, quotes, and tabs and strips newlines", async () => {
    const backslash = "\\";
    const quote = '"';
    const tab = "\t";
    const newline = "\n";
    const input = `back${backslash}slash${quote}quote${tab}tab${newline}line`;
    const expected = `back${backslash}${backslash}slash${backslash}${quote}quote${backslash}ttabline`;

    const { stdout } = await runBash('printf "%s" "$(json_string "$INPUT")"', { INPUT: input });

    expect(stdout).toBe(expected);
  });
});

describe("json_get_string", () => {
  it("extracts a top-level string value from compact JSON", async () => {
    const { stdout } = await runBash('json_get_string "$JSON" sessionId', {
      JSON: '{"sessionId":"abc123","status":"active"}',
    });

    expect(stdout.trim()).toBe("abc123");
  });

  it("returns empty for a missing key", async () => {
    const { stdout } = await runBash('json_get_string "$JSON" dashboardUrl', {
      JSON: '{"sessionId":"abc123"}',
    });

    expect(stdout.trim()).toBe("");
  });
});

describe("json_get_number", () => {
  it("extracts a top-level number value from compact JSON", async () => {
    const { stdout } = await runBash('json_get_number "$JSON" maxDurationSeconds', {
      JSON: '{"maxDurationSeconds":3600,"status":"active"}',
    });

    expect(stdout.trim()).toBe("3600");
  });

  it("returns empty for a missing key", async () => {
    const { stdout } = await runBash('json_get_number "$JSON" maxDurationSeconds', {
      JSON: '{"status":"active"}',
    });

    expect(stdout.trim()).toBe("");
  });
});

describe("log", () => {
  /** The test process has no tty; a snippet that wants the terminal path says so. */
  const AT_A_TERMINAL = "stderr_is_terminal() { return 0; }";
  const TAG = "[1;33mafk ▸[0m ";

  it("prefixes its messages with the plain afk: on stderr when stderr is not a terminal", async () => {
    const { stdout, stderr } = await runBash("log hello world");

    expect(stderr).toBe("afk: hello world\n");
    expect(stdout).toBe("");
  });

  it("tags its messages in bold yellow on a terminal, so they stand apart from a command's output", async () => {
    const { stderr } = await runBash(`${AT_A_TERMINAL}; log hello world`);

    expect(stderr).toBe(`${TAG}hello world\n`);
  });

  it("keeps the plain prefix on a terminal when NO_COLOR is set", async () => {
    const { stderr } = await runBash(`${AT_A_TERMINAL}; log hello world`, { NO_COLOR: "1" });

    expect(stderr).toBe("afk: hello world\n");
  });

  it("ignores an empty NO_COLOR, as the convention says", async () => {
    const { stderr } = await runBash(`${AT_A_TERMINAL}; log hello`, { NO_COLOR: "" });

    expect(stderr).toBe(`${TAG}hello\n`);
  });

  it("puts the same tag on die and on the update question", async () => {
    const { stderr, code } = await runBash(
      [
        AT_A_TERMINAL,
        "can_prompt() { return 0; }",
        "AFK_VERSION=0.1.0; LATEST_CLIENT_VERSION=0.2.0; UPDATE_PROMPT_TIMEOUT_SECONDS=1",
        "check_client_update prompt </dev/null",
        "die boom",
      ].join("\n"),
    );

    expect(code).toBe(1);
    expect(stderr).toContain(`${TAG}update now? [y/N] `);
    expect(stderr).toContain(`${TAG}error: boom\n`);
    expect(stderr).not.toContain("afk: ");
  });
});

describe("collect_system", () => {
  // Uses ps, sysctl, and vm_stat, which only exist on macOS.
  it.skipIf(process.platform !== "darwin")(
    "prints a frame body that validates as SystemCollectorData",
    async () => {
      const { stdout, stderr, code } = await runBash("gather_host_info\ncollect_system");

      expect(code, stderr).toBe(0);
      const result = SystemCollectorData.safeParse(JSON.parse(stdout));
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(
        true,
      );
    },
  );
});

describe("collect_processes", () => {
  // Uses ps with macOS column names.
  it.skipIf(process.platform !== "darwin")(
    "prints a frame body that validates as ProcessesCollectorData, cpu descending, capped at the top max",
    async () => {
      const { stdout, stderr, code } = await runBash("collect_processes");

      expect(code, stderr).toBe(0);
      const result = ProcessesCollectorData.safeParse(JSON.parse(stdout));
      expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(
        true,
      );
      if (result.success) {
        const { top, sampledCount } = result.data;
        expect(top.length).toBeLessThanOrEqual(PROCESSES_TOP_MAX);
        expect(sampledCount).toBeGreaterThanOrEqual(top.length);
        const cpus = top.map((entry) => entry.cpuPercent);
        expect(cpus).toEqual([...cpus].sort((a, b) => b - a));
        // comm is the path the process was execed with, which may be relative, so only
        // check that every entry has one.
        expect(top.every((entry) => entry.command.length > 0)).toBe(true);
      }
    },
  );
});

describe("sample_once", () => {
  // Runs the real collectors, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "emits a processes frame on the first tick and then only every PROCESSES_INTERVAL_SECONDS",
    async () => {
      const sessionDir = await makeTempDir();
      await mkdir(join(sessionDir, "queue"));

      const { code, stderr } = await runBash(
        "gather_host_info\nPROCESSES_INTERVAL_SECONDS=3\nsample_once; sample_once; sample_once; sample_once",
        { SESSION_DIR: sessionDir },
      );

      expect(code, stderr).toBe(0);
      const frames = await queuedFrames(sessionDir);
      const byStream = (stream: string) =>
        frames.filter((frame) => frame.stream === stream).map((frame) => frame.sequence);
      expect(byStream("system")).toEqual([1, 2, 3, 4]);
      expect(byStream("processes")).toEqual([1, 2]);
    },
  );
});

describe("emit_frame", () => {
  it("writes the frame as its own queue file, named by sequence and stream, that validates as a Frame", async () => {
    const sessionDir = await makeTempDir();
    await mkdir(join(sessionDir, "queue"));
    const data: SystemCollectorData = {
      cpu: { percent: 12.3 },
      loadAverage: { oneMinute: 1, fiveMinutes: 1.5, fifteenMinutes: 2 },
      memory: {
        pressureLevel: 1,
        totalBytes: 1000,
        freeBytes: 200,
        activeBytes: 300,
        inactiveBytes: 200,
        wiredBytes: 200,
        compressedBytes: 100,
        swapUsedBytes: 0,
        swapTotalBytes: 500,
      },
    };

    const { code, stderr } = await runBash('emit_frame system system 3 "$DATA_JSON"', {
      SESSION_DIR: sessionDir,
      DATA_JSON: JSON.stringify(data),
    });

    expect(code, stderr).toBe(0);
    expect(await queueFiles(sessionDir)).toEqual(["0000000003-system.ndjson"]);
    const content = await readFile(join(sessionDir, "queue", "0000000003-system.ndjson"), "utf8");
    const lines = content.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0]!);
    const result = Frame.safeParse(parsed);
    expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
    expect(parsed).toMatchObject({ stream: "system", collector: "system", sequence: 3, data });
  });

  it("leaves no temp file behind, so the sender only ever sees whole frames", async () => {
    const sessionDir = await makeTempDir();
    await mkdir(join(sessionDir, "queue"));

    const { code, stderr } = await runBash(
      'emit_frame system system 1 "{}"; emit_frame system system 2 "{}"',
      {
        SESSION_DIR: sessionDir,
      },
    );

    expect(code, stderr).toBe(0);
    expect((await readdir(join(sessionDir, "queue"))).sort()).toEqual([
      "0000000001-system.ndjson",
      "0000000002-system.ndjson",
    ]);
  });
});

describe("flush_queue", () => {
  const baseEnv = { INGEST_TOKEN: "test-token", SESSION_ID: "sess123", AFK_VERSION: "0.1.0" };

  // Regression: SIGTERM landing between emit_frame's write and its rename left a
  // whole frame behind as `.0000000003-system.ndjson.tmp`, which the sender never
  // picked up and the contract test found still in the queue after the session ended.
  it("queues and sends a frame whose rename a trap interrupted, leaving no temp file", async () => {
    const sessionDir = await makeTempDir();
    await mkdir(join(sessionDir, "queue"));
    await writeFile(join(sessionDir, "queue", "0000000002-system.ndjson"), "BBB\n");
    await writeFile(join(sessionDir, "queue", ".0000000003-system.ndjson.tmp"), "CCC\n");
    const server = await startServer(() => ({ status: 200, body: '{"accepted":2}' }));

    const { stdout, stderr } = await runBash('flush_queue; printf "RC=%d" "$?"', {
      ...baseEnv,
      SESSION_DIR: sessionDir,
      AFK_SERVER: server.url,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "0" });
    expect(server.requests.map((request) => request.body).join("")).toBe("BBB\nCCC\n");
    expect(await readdir(join(sessionDir, "queue"))).toEqual([]);
  });
});

describe("send_oldest_batch", () => {
  async function makeQueue(): Promise<string> {
    const sessionDir = await makeTempDir();
    await mkdir(join(sessionDir, "queue"));
    return sessionDir;
  }

  const baseEnv = { INGEST_TOKEN: "test-token", SESSION_ID: "sess123", AFK_VERSION: "0.1.0" };

  it("sends the oldest queued files first, with the bearer token and ndjson content type", async () => {
    const sessionDir = await makeQueue();
    await writeFile(join(sessionDir, "queue", "0000000001.ndjson"), "AAA\n");
    await writeFile(join(sessionDir, "queue", "0000000002.ndjson"), "BBB\n");
    const server = await startServer(() => ({ status: 200 }));

    const { stdout, stderr } = await runBash('send_oldest_batch; printf "RC=%d" "$?"', {
      ...baseEnv,
      SESSION_DIR: sessionDir,
      AFK_SERVER: server.url,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "0" });
    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request).toMatchObject({
      method: "POST",
      url: "/api/sessions/sess123/frames",
      headers: expect.objectContaining({
        authorization: "Bearer test-token",
        "content-type": "application/x-ndjson",
      }),
      body: "AAA\nBBB\n",
    });
  });

  it("deletes the queued files on a 200 response", async () => {
    const sessionDir = await makeQueue();
    await writeFile(join(sessionDir, "queue", "0000000001.ndjson"), "AAA\n");
    const server = await startServer(() => ({ status: 200, body: '{"accepted":1}' }));

    await runBash("send_oldest_batch", {
      ...baseEnv,
      SESSION_DIR: sessionDir,
      AFK_SERVER: server.url,
    });

    expect(await exists(join(sessionDir, "queue", "0000000001.ndjson"))).toBe(false);
  });

  it("keeps the queued files and returns 1 on a 500 response", async () => {
    const sessionDir = await makeQueue();
    await writeFile(join(sessionDir, "queue", "0000000001.ndjson"), "AAA\n");
    const server = await startServer(() => ({ status: 500, body: '{"error":"boom"}' }));

    const { stdout, stderr } = await runBash('send_oldest_batch; printf "RC=%d" "$?"', {
      ...baseEnv,
      SESSION_DIR: sessionDir,
      AFK_SERVER: server.url,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "1" });
    const kept = await readFile(join(sessionDir, "queue", "0000000001.ndjson"), "utf8");
    expect(kept).toBe("AAA\n");
  });

  it("returns 2 on a 410 response", async () => {
    const sessionDir = await makeQueue();
    await writeFile(join(sessionDir, "queue", "0000000001.ndjson"), "AAA\n");
    const server = await startServer(() => ({ status: 410, body: '{"error":"ended"}' }));

    const { stdout, stderr } = await runBash('send_oldest_batch; printf "RC=%d" "$?"', {
      ...baseEnv,
      SESSION_DIR: sessionDir,
      AFK_SERVER: server.url,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "2" });
    const kept = await readFile(join(sessionDir, "queue", "0000000001.ndjson"), "utf8");
    expect(kept).toBe("AAA\n");
  });

  it("returns 4 and keeps the queued files, without parking them, on a 404 response", async () => {
    const sessionDir = await makeQueue();
    await writeFile(join(sessionDir, "queue", "0000000001.ndjson"), "AAA\n");
    const server = await startServer(() => ({
      status: 404,
      body: '{"error":"session deleted","details":{"reason":"deleted"}}',
    }));

    const { stdout, stderr } = await runBash('send_oldest_batch; printf "RC=%d" "$?"', {
      ...baseEnv,
      SESSION_DIR: sessionDir,
      AFK_SERVER: server.url,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "4" });
    expect(await queueFiles(sessionDir)).toEqual(["0000000001.ndjson"]);
    expect(await exists(join(sessionDir, "rejected"))).toBe(false);
  });

  it("returns 3, keeps the queued files, and prints the upgrade hint on a 426 response", async () => {
    const sessionDir = await makeQueue();
    await writeFile(join(sessionDir, "queue", "0000000001.ndjson"), "AAA\n");
    const server = await startServer(() => ({
      status: 426,
      body: JSON.stringify({
        error: "client version 0.1.0 is below the minimum 0.3.0; update afk",
        details: { minimumClientVersion: "0.3.0", minimumProtocolVersion: 2, yourVersion: "0.1.0" },
      }),
    }));

    const { stdout, stderr } = await runBash('send_oldest_batch; printf "RC=%d" "$?"', {
      ...baseEnv,
      SESSION_DIR: sessionDir,
      AFK_SERVER: server.url,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "3" });
    expect(stderr).toContain("below the minimum 0.3.0");
    expect(stderr).toContain("client 0.3.0 and protocol 2 or newer");
    expect(stderr).toContain(`update with: curl -fsSL ${server.url}/install | sh`);
    const kept = await readFile(join(sessionDir, "queue", "0000000001.ndjson"), "utf8");
    expect(kept).toBe("AAA\n");
    expect(await exists(join(sessionDir, "rejected"))).toBe(false);
  });

  // With --fail-with-body curl exits 22 on these; the status must still be read.
  it("still returns 1 on a 500 and 2 on a 410 with --fail-with-body enabled", async () => {
    const sessionDir = await makeQueue();
    await writeFile(join(sessionDir, "queue", "0000000001.ndjson"), "AAA\n");
    let status = 500;
    const server = await startServer(() => ({ status, body: '{"error":"boom"}' }));

    const first = await runBash('detect_curl_features; send_oldest_batch; printf "RC=%d" "$?"', {
      ...baseEnv,
      SESSION_DIR: sessionDir,
      AFK_SERVER: server.url,
    });
    status = 410;
    const second = await runBash('detect_curl_features; send_oldest_batch; printf "RC=%d" "$?"', {
      ...baseEnv,
      SESSION_DIR: sessionDir,
      AFK_SERVER: server.url,
    });

    expect(parseKeyValueLines(first.stdout), first.stderr).toMatchObject({ RC: "1" });
    expect(parseKeyValueLines(second.stdout), second.stderr).toMatchObject({ RC: "2" });
    expect(await exists(join(sessionDir, "queue", "0000000001.ndjson"))).toBe(true);
  });

  it("returns 1 and records curl's reason when the server is unreachable", async () => {
    const sessionDir = await makeQueue();
    await writeFile(join(sessionDir, "queue", "0000000001.ndjson"), "AAA\n");

    const { stdout, stderr } = await runBash(
      'send_oldest_batch; printf "RC=%d\\nSTATUS=%s\\nERROR=%s\\n" "$?" "$HTTP_STATUS" "$HTTP_ERROR"',
      { ...baseEnv, SESSION_DIR: sessionDir, AFK_SERVER: "http://127.0.0.1:1" },
    );

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({
      RC: "1",
      STATUS: "000",
      ERROR: expect.stringMatching(/connect/i),
    });
    expect(await exists(join(sessionDir, "queue", "0000000001.ndjson"))).toBe(true);
  });

  it("moves the queued files to rejected/ on a 400 response", async () => {
    const sessionDir = await makeQueue();
    await writeFile(join(sessionDir, "queue", "0000000001.ndjson"), "AAA\n");
    const server = await startServer(() => ({ status: 400, body: '{"error":"bad request"}' }));

    const { stdout, stderr } = await runBash('send_oldest_batch; printf "RC=%d" "$?"', {
      ...baseEnv,
      SESSION_DIR: sessionDir,
      AFK_SERVER: server.url,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "0" });
    const rejected = await readFile(join(sessionDir, "rejected", "0000000001.ndjson"), "utf8");
    expect(rejected).toBe("AAA\n");
    expect(await exists(join(sessionDir, "queue", "0000000001.ndjson"))).toBe(false);
  });

  it("ships frames emitted by two streams in sequence order within each stream", async () => {
    const sessionDir = await makeQueue();
    const server = await startServer(() => ({ status: 200 }));

    const { stdout, stderr } = await runBash(
      [
        'emit_frame system system 1 "{}"',
        'emit_frame run:ab12cd34 run 1 "{}"',
        'emit_frame system system 2 "{}"',
        'emit_frame run:ab12cd34 run 2 "{}"',
        'emit_frame system system 3 "{}"',
        'send_oldest_batch; printf "RC=%d" "$?"',
      ].join("\n"),
      { ...baseEnv, SESSION_DIR: sessionDir, AFK_SERVER: server.url },
    );

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "0" });
    expect(server.requests).toHaveLength(1);
    const sent = server.requests[0]!.body.split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { stream: string; sequence: number })
      .map((frame) => `${frame.stream}#${frame.sequence}`);
    expect(sent).toEqual(["run:ab12cd34#1", "system#1", "run:ab12cd34#2", "system#2", "system#3"]);
    expect(await queueFiles(sessionDir)).toEqual([]);
  });

  it("sends at most SEND_MAX_FILES_PER_BATCH of the oldest files per request", async () => {
    const sessionDir = await makeQueue();
    await writeFile(join(sessionDir, "queue", "0000000001-system.ndjson"), "AAA\n");
    await writeFile(join(sessionDir, "queue", "0000000002-system.ndjson"), "BBB\n");
    await writeFile(join(sessionDir, "queue", "0000000003-system.ndjson"), "CCC\n");
    const server = await startServer(() => ({ status: 200 }));

    const { stdout, stderr } = await runBash(
      'SEND_MAX_FILES_PER_BATCH=2\nsend_oldest_batch; printf "RC=%d" "$?"',
      { ...baseEnv, SESSION_DIR: sessionDir, AFK_SERVER: server.url },
    );

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "0" });
    expect(server.requests.map((request) => request.body)).toEqual(["AAA\nBBB\n"]);
    expect(await queueFiles(sessionDir)).toEqual(["0000000003-system.ndjson"]);
  });
});

describe("the ingest token", () => {
  const TOKEN = "tok-secret-abc";
  const hostEnv = {
    HOST_NAME: "test-host",
    HOST_PLATFORM: "darwin",
    HOST_OS_VERSION: "26.0",
    HOST_CPU_COUNT: "8",
    HOST_MEMORY_BYTES: "17179869184",
  };
  const successor =
    '{"sessionId":"newSession","ingestToken":"tok-new","dashboardUrl":"http://example.test/s/newSession","maxDurationSeconds":3600}';
  const accepted = '{"accepted":1,"duplicates":0,"latestSequence":{}}';
  const QR_TEXT = "█████████\nhttp://example.test/s/sess123\n";

  /** The argument lists of every process mentioning `text`: what `ps` shows any user. */
  async function processArgumentsMentioning(text: string): Promise<string[]> {
    const pids = await processesMentioning(text);
    if (pids.length === 0) {
      return [];
    }
    const { stdout } = await execFileAsync("ps", ["-o", "args=", "-p", pids.join(",")]);
    return stdout.split("\n").filter((line) => line !== "");
  }

  // Regression: the token used to be a `-H` argument, visible to every user of a shared
  // Mac through `ps`. Reads the file mode with BSD stat -f, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "is not in curl's arguments while frames, qr, end, and a chained create are in flight, yet reaches the server as the bearer",
    async () => {
      const afkHome = await makeTempDir();
      const sessionDir = join(afkHome, "sessions", "sess123");
      await mkdir(join(sessionDir, "queue"), { recursive: true });
      await writeFile(join(sessionDir, "queue", "0000000001-system.ndjson"), "AAA\n");
      const inFlight: string[][] = [];
      const server = await startServer(async (req) => {
        // Taken while curl is waiting for the answer.
        inFlight.push(await processArgumentsMentioning(`http://${req.headers.host}`));
        if (req.url === "/api/sessions") {
          return { status: 201, body: successor };
        }
        if (req.url.endsWith("/qr")) {
          return { status: 200, body: QR_TEXT };
        }
        return { status: 200, body: accepted };
      });

      const { stdout, stderr } = await runBash(
        [
          'send_oldest_batch; printf "SEND=%s\\n" "$?"',
          'fetch_qr > /dev/null; printf "QR=%s\\n" "$?"',
          'end_session; printf "END=%s\\n" "$?"',
          'create_session sess123 "$INGEST_TOKEN"; printf "CREATE=%s\\n" "$?"',
          'printf "MODE=%s\\n" "$(stat -f %Lp "$AFK_HOME/sessions/sess123/auth")"',
        ].join("\n"),
        {
          ...hostEnv,
          AFK_HOME: afkHome,
          AFK_SERVER: server.url,
          SESSION_ID: "sess123",
          INGEST_TOKEN: TOKEN,
          SESSION_DIR: sessionDir,
        },
      );

      expect(inFlight).toHaveLength(4);
      for (const processes of inFlight) {
        expect(processes.some((args) => args.includes("curl"))).toBe(true);
        expect(processes.join("\n")).not.toContain(TOKEN);
      }
      expect(server.requests.map((req) => [req.url, req.headers.authorization])).toEqual([
        ["/api/sessions/sess123/frames", `Bearer ${TOKEN}`],
        ["/api/sessions/sess123/qr", `Bearer ${TOKEN}`],
        ["/api/sessions/sess123/end", `Bearer ${TOKEN}`],
        ["/api/sessions", `Bearer ${TOKEN}`],
      ]);
      for (const req of server.requests) {
        expect(req.headers["x-afk-client"]).toMatch(/^bash\/\d+\.\d+\.\d+$/);
      }
      expect(parseKeyValueLines(stdout), stderr).toEqual({
        SEND: "0",
        QR: "0",
        END: "0",
        CREATE: "0",
        MODE: "600",
      });
    },
  );
});

describe("enforce_spool_cap", () => {
  /** Five 40-byte frames named in emission order. */
  async function makeOverfullQueue(): Promise<string> {
    const sessionDir = await makeTempDir();
    await mkdir(join(sessionDir, "queue"));
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      const name = `${String(sequence).padStart(10, "0")}-system.ndjson`;
      await writeFile(join(sessionDir, "queue", name), "x".repeat(39) + "\n");
    }
    return sessionDir;
  }

  // Sizes files with BSD stat -f, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "drops the oldest frames until the queue is back under the cap",
    async () => {
      const sessionDir = await makeOverfullQueue();

      const { code, stderr } = await runBash("enforce_spool_cap", {
        SESSION_DIR: sessionDir,
        AFK_SPOOL_MAX_BYTES: "100",
      });

      expect(code, stderr).toBe(0);
      expect(await queueFiles(sessionDir)).toEqual([
        "0000000004-system.ndjson",
        "0000000005-system.ndjson",
      ]);
    },
  );

  // Sizes files with BSD stat -f, so macOS only.
  it.skipIf(process.platform !== "darwin")("leaves a queue under the cap alone", async () => {
    const sessionDir = await makeOverfullQueue();

    const { code, stderr } = await runBash("enforce_spool_cap", {
      SESSION_DIR: sessionDir,
      AFK_SPOOL_MAX_BYTES: "200",
    });

    expect(code, stderr).toBe(0);
    expect(await queueFiles(sessionDir)).toHaveLength(5);
    expect(stderr).toBe("");
  });

  // Sizes files with BSD stat -f, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "reports what it dropped at most once a minute",
    async () => {
      const sessionDir = await makeOverfullQueue();

      const { code, stderr } = await runBash(
        [
          "enforce_spool_cap",
          'head -c 40 /dev/zero > "$SESSION_DIR/queue/0000000006-system.ndjson"',
          'head -c 40 /dev/zero > "$SESSION_DIR/queue/0000000007-system.ndjson"',
          "enforce_spool_cap",
        ].join("\n"),
        { SESSION_DIR: sessionDir, AFK_SPOOL_MAX_BYTES: "100" },
      );

      expect(code, stderr).toBe(0);
      expect(stderr.split("\n").filter((line) => line.includes("dropped"))).toHaveLength(1);
      expect(await queueFiles(sessionDir)).toEqual([
        "0000000006-system.ndjson",
        "0000000007-system.ndjson",
      ]);
    },
  );

  // Regression: dropped frames vanished without a trace once the log line had gone by.
  // Sizes files with BSD stat -f, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "keeps a running count of what it dropped in the session's dropped file across enforcements",
    async () => {
      const sessionDir = await makeOverfullQueue();

      // 200 bytes over a 100-byte cap drops three 40-byte frames; two more files
      // (160 bytes) drop another two.
      const { code, stderr } = await runBash(
        [
          "enforce_spool_cap",
          'head -c 40 /dev/zero > "$SESSION_DIR/queue/0000000006-system.ndjson"',
          'head -c 40 /dev/zero > "$SESSION_DIR/queue/0000000007-system.ndjson"',
          "enforce_spool_cap",
        ].join("\n"),
        { SESSION_DIR: sessionDir, AFK_SPOOL_MAX_BYTES: "100" },
      );

      expect(code, stderr).toBe(0);
      expect(await readFile(join(sessionDir, "dropped"), "utf8")).toBe("5 200\n");
      expect(stderr).toContain(
        "dropped the oldest 3 frames (120 bytes), 3 frames since the session started",
      );
    },
  );
});

describe("system_sampler_loop", () => {
  /**
   * Runs the loop against a fake clock: `sleep` advances it and prints what it was
   * asked for, and each fake tick costs `tickCost` seconds (with an optional jump on
   * one tick, standing in for the machine sleeping). Stops after `ticks` ticks.
   */
  async function runLoop(options: {
    tickCost: number;
    ticks: number;
    jumpOnTick?: number;
    jumpSeconds?: number;
  }): Promise<{ lines: string[]; stderr: string; code: number }> {
    const sessionDir = await makeTempDir();
    const { stdout, stderr, code } = await runBash(
      [
        "FAKE_NOW=1000; TICKS=0",
        "now_seconds() { printf '%s' \"$FAKE_NOW\"; }",
        "sleep() { printf 'sleep=%s\\n' \"$1\"; FAKE_NOW=$((FAKE_NOW + $1)); }",
        "sample_once() {",
        "  TICKS=$((TICKS + 1)); printf 'tick=%s\\n' \"$FAKE_NOW\"",
        "  FAKE_NOW=$((FAKE_NOW + TICK_COST))",
        '  [ "$TICKS" = "$JUMP_ON_TICK" ] && FAKE_NOW=$((FAKE_NOW + JUMP_SECONDS))',
        '  [ "$TICKS" -ge "$MAX_TICKS" ] && touch "$SESSION_DIR/stop"',
        "  return 0",
        "}",
        "system_sampler_loop",
      ].join("\n"),
      {
        SESSION_DIR: sessionDir,
        MAX_DURATION_SECONDS: "100000",
        TICK_COST: String(options.tickCost),
        MAX_TICKS: String(options.ticks),
        JUMP_ON_TICK: String(options.jumpOnTick ?? 0),
        JUMP_SECONDS: String(options.jumpSeconds ?? 0),
      },
    );
    return { lines: stdout.split("\n").filter((line) => line !== ""), stderr, code };
  }

  it("sleeps to the next whole second when the collectors finish early", async () => {
    const { lines, stderr, code } = await runLoop({ tickCost: 0, ticks: 3 });

    expect(code, stderr).toBe(0);
    expect(lines).toEqual(["tick=1000", "sleep=1", "tick=1001", "sleep=1", "tick=1002", "sleep=1"]);
  });

  it("does not sleep after a tick that took a whole second, so the rate stays 1 Hz", async () => {
    const { lines, stderr, code } = await runLoop({ tickCost: 1, ticks: 3 });

    expect(code, stderr).toBe(0);
    expect(lines).toEqual(["tick=1000", "tick=1001", "tick=1002"]);
  });

  it("skips ahead instead of catching up tick by tick after the clock jumps", async () => {
    const { lines, stderr, code } = await runLoop({
      tickCost: 0,
      ticks: 4,
      jumpOnTick: 2,
      jumpSeconds: 3600,
    });

    expect(code, stderr).toBe(0);
    expect(lines).toEqual([
      "tick=1000",
      "sleep=1",
      "tick=1001",
      "tick=4601",
      "sleep=1",
      "tick=4602",
      "sleep=1",
    ]);
  });

  it("stops at the cap without chaining unless SESSION_CHAINING is set", async () => {
    const sessionDir = await makeTempDir();

    const { stdout, stderr, code } = await runBash(
      [
        "FAKE_NOW=1000",
        "now_seconds() { printf '%s' \"$FAKE_NOW\"; }",
        "sleep() { FAKE_NOW=$((FAKE_NOW + $1)); }",
        "sample_once() { printf 'tick=%s\\n' \"$FAKE_NOW\"; }",
        "chain_session() { printf 'chain=%s\\n' \"$FAKE_NOW\"; return 0; }",
        "system_sampler_loop",
      ].join("\n"),
      { SESSION_DIR: sessionDir, MAX_DURATION_SECONDS: "3" },
    );

    expect(code, stderr).toBe(0);
    expect(stdout.split("\n").filter((line) => line !== "")).toEqual([
      "tick=1000",
      "tick=1001",
      "tick=1002",
    ]);
    expect(stderr).toContain("reached the maximum session length");
    expect(await exists(join(sessionDir, "stop"))).toBe(true);
  });
});

describe("system_sampler_loop chaining", () => {
  /**
   * The loop against a fake clock with a stub chain_session that reports when it was
   * called and succeeds or fails as told. Runs until `ticks` samples have been taken.
   */
  async function runChainingLoop(options: {
    maxDurationSeconds: number;
    ticks: number;
    chainResult: number;
    goneOnTick?: number;
  }): Promise<{ lines: string[]; stderr: string; code: number; sessionDir: string }> {
    const sessionDir = await makeTempDir();
    const { stdout, stderr, code } = await runBash(
      [
        "FAKE_NOW=1000; TICKS=0",
        "now_seconds() { printf '%s' \"$FAKE_NOW\"; }",
        "sleep() { FAKE_NOW=$((FAKE_NOW + $1)); }",
        "sample_once() {",
        "  TICKS=$((TICKS + 1)); printf 'tick=%s\\n' \"$FAKE_NOW\"",
        '  [ "$TICKS" = "$GONE_ON_TICK" ] && touch "$SESSION_DIR/gone"',
        '  [ "$TICKS" -ge "$MAX_TICKS" ] && touch "$SESSION_DIR/stop"',
        "  return 0",
        "}",
        "chain_session() {",
        "  printf 'chain=%s\\n' \"$FAKE_NOW\"",
        '  [ "$CHAIN_RESULT" = 0 ] && rm -f "$SESSION_DIR/gone"',
        '  return "$CHAIN_RESULT"',
        "}",
        "system_sampler_loop",
      ].join("\n"),
      {
        SESSION_DIR: sessionDir,
        SESSION_CHAINING: "1",
        MAX_DURATION_SECONDS: String(options.maxDurationSeconds),
        MAX_TICKS: String(options.ticks),
        CHAIN_RESULT: String(options.chainResult),
        GONE_ON_TICK: String(options.goneOnTick ?? 0),
      },
    );
    return { lines: stdout.split("\n").filter((line) => line !== ""), stderr, code, sessionDir };
  }

  it("chains a quarter of a short cap before it and again a cap later, counting from the successor", async () => {
    // Cap 20 s: chain 5 s before, at 15 s of each session.
    const { lines, stderr, code } = await runChainingLoop({
      maxDurationSeconds: 20,
      ticks: 32,
      chainResult: 0,
    });

    expect(code, stderr).toBe(0);
    expect(lines.filter((line) => line.startsWith("chain="))).toEqual(["chain=1015", "chain=1030"]);
    expect(lines).toHaveLength(34);
    expect(stderr).not.toContain("reached the maximum session length");
  });

  it("chains 30 s before the default hour, a quarter of a short cap, and never under 2 s", async () => {
    const before = async (maxDurationSeconds: number) =>
      (
        await runBash("chain_before_cap_seconds", {
          MAX_DURATION_SECONDS: String(maxDurationSeconds),
        })
      ).stdout.trim();

    expect(await before(3600)).toBe("30");
    expect(await before(120)).toBe("30");
    expect(await before(40)).toBe("10");
    expect(await before(12)).toBe("3");
    expect(await before(4)).toBe("2");
  });

  it("retries a failed chain every CHAIN_RETRY_SECONDS and stops at the cap like before", async () => {
    const { lines, stderr, code, sessionDir } = await runChainingLoop({
      maxDurationSeconds: 20,
      ticks: 40,
      chainResult: 1,
    });

    expect(code, stderr).toBe(0);
    expect(lines.filter((line) => line.startsWith("chain="))).toEqual(["chain=1015", "chain=1020"]);
    expect(lines.filter((line) => line.startsWith("tick=")).at(-1)).toBe("tick=1019");
    expect(stderr).toContain("reached the maximum session length");
    expect(await exists(join(sessionDir, "stop"))).toBe(true);
  });

  it("chains at once when the sender reports the session gone, once the session is old enough", async () => {
    // Cap 400 s: the sender marks the session gone at tick 3 (session age 2 s); the
    // chain waits until the session is CHAIN_MIN_SESSION_SECONDS (60 s) old.
    const { lines, stderr, code } = await runChainingLoop({
      maxDurationSeconds: 400,
      ticks: 70,
      chainResult: 0,
      goneOnTick: 3,
    });

    expect(code, stderr).toBe(0);
    expect(lines.filter((line) => line.startsWith("chain="))).toEqual(["chain=1060"]);
  });
});

describe("create_session", () => {
  const hostEnv = {
    HOST_NAME: "test-host",
    HOST_PLATFORM: "darwin",
    HOST_OS_VERSION: "26.0",
    HOST_CPU_COUNT: "8",
    HOST_MEMORY_BYTES: "17179869184",
  };

  it("sets session variables, writes AFK_HOME/current, and creates the queue directory", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({
      status: 201,
      body: '{"sessionId":"D3FzMqK8qOLVva9LoHF9uc","ingestToken":"tok-abc","dashboardUrl":"http://example.test/s/D3FzMqK8qOLVva9LoHF9uc","maxDurationSeconds":3600}',
    }));

    const { stdout, stderr } = await runBash(
      [
        "create_session",
        'printf "SESSION_ID=%s\\n" "$SESSION_ID"',
        'printf "INGEST_TOKEN=%s\\n" "$INGEST_TOKEN"',
        'printf "DASHBOARD_URL=%s\\n" "$DASHBOARD_URL"',
        'printf "MAX_DURATION_SECONDS=%s\\n" "$MAX_DURATION_SECONDS"',
        'printf "SESSION_DIR=%s\\n" "$SESSION_DIR"',
        'printf "PID=%s\\n" "$$"',
        // The owner removes both files when it exits, so read them while it is alive.
        'printf "CURRENT_FILE=%s\\n" "$(tr "\\n" "|" < "$AFK_HOME/current")"',
        'printf "OWNER_PID_FILE=%s\\n" "$(cat "$AFK_HOME/owner.pid")"',
        'printf "SESSION_RECORD=%s\\n" "$(cat "$SESSION_DIR/session.json")"',
      ].join("\n"),
      { ...hostEnv, AFK_HOME: afkHome, AFK_SERVER: server.url },
    );

    const values = parseKeyValueLines(stdout);
    expect(values, stderr).toEqual({
      SESSION_ID: "D3FzMqK8qOLVva9LoHF9uc",
      INGEST_TOKEN: "tok-abc",
      DASHBOARD_URL: "http://example.test/s/D3FzMqK8qOLVva9LoHF9uc",
      MAX_DURATION_SECONDS: "3600",
      SESSION_DIR: `${afkHome}/sessions/D3FzMqK8qOLVva9LoHF9uc`,
      PID: expect.stringMatching(/^[0-9]+$/),
      CURRENT_FILE:
        "sessionId=D3FzMqK8qOLVva9LoHF9uc|" +
        "ingestToken=tok-abc|" +
        `server=${server.url}|` +
        "dashboardUrl=http://example.test/s/D3FzMqK8qOLVva9LoHF9uc|",
      // The creating process is the owner; afk status/stop and joiners check it is alive.
      OWNER_PID_FILE: values.PID,
      // Stays with the session's queue after current is gone, for resend_leftover_queues.
      SESSION_RECORD: JSON.stringify({
        sessionId: "D3FzMqK8qOLVva9LoHF9uc",
        ingestToken: "tok-abc",
        server: server.url,
        dashboardUrl: "http://example.test/s/D3FzMqK8qOLVva9LoHF9uc",
      }),
    });
    const queueStat = await stat(join(afkHome, "sessions", "D3FzMqK8qOLVva9LoHF9uc", "queue"));
    expect(queueStat.isDirectory()).toBe(true);
  });

  // The owner removes `current` on exit, so its mode is read from inside the script.
  it.skipIf(process.platform !== "darwin")(
    "writes current, which holds the ingest token, readable by the user alone",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startServer(() => ({
        status: 201,
        body: '{"sessionId":"abc123","ingestToken":"tok-abc","dashboardUrl":"http://example.test/s/abc123","maxDurationSeconds":3600}',
      }));

      const { stdout, stderr } = await runBash(
        'create_session; printf "MODE=%s\\n" "$(stat -f %Lp "$AFK_HOME/current")"',
        { ...hostEnv, AFK_HOME: afkHome, AFK_SERVER: server.url },
      );

      expect(parseKeyValueLines(stdout), stderr).toEqual({ MODE: "600" });
    },
  );

  it("exits 1 with the upgrade hint on a 426 response, without the capacity retry loop", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({
      status: 426,
      body: JSON.stringify({
        error: "client version 0.1.0 is below the minimum 0.3.0; update afk",
        details: { minimumClientVersion: "0.3.0", minimumProtocolVersion: 2, yourVersion: "0.1.0" },
      }),
    }));

    // create_session_or_wait is the `afk start` path: a 503 would make it sleep and retry.
    const { code, stderr } = await runBash('create_session_or_wait; printf "RC=%d" "$?"', {
      ...hostEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code).toBe(1);
    expect(server.requests).toHaveLength(1);
    expect(stderr).toContain("below the minimum 0.3.0");
    expect(stderr).toContain("client 0.3.0 and protocol 2 or newer");
    expect(stderr).toContain(`update with: curl -fsSL ${server.url}/install | sh`);
    expect(await exists(join(afkHome, "current"))).toBe(false);
  });
});

describe("check_platform", () => {
  // Dies off macOS before it reaches the directory.
  it.skipIf(process.platform !== "darwin")(
    "makes AFK_HOME private even when an older version created it with wider permissions",
    async () => {
      const afkHome = join(await makeTempDir(), ".afk");
      await mkdir(afkHome, { mode: 0o755 });

      const { code, stderr } = await runBash("check_platform", { AFK_HOME: afkHome });

      expect(code, stderr).toBe(0);
      expect((await stat(afkHome)).mode & 0o777).toBe(0o700);
    },
  );
});

describe("create_session failures", () => {
  const hostEnv = {
    HOST_NAME: "test-host",
    HOST_PLATFORM: "darwin",
    HOST_OS_VERSION: "26.0",
    HOST_CPU_COUNT: "8",
    HOST_MEMORY_BYTES: "17179869184",
  };

  it("returns 2 when the server is at capacity, with --fail-with-body enabled", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 503, body: '{"error":"at capacity"}' }));

    const { stdout, stderr } = await runBash(
      'detect_curl_features; create_session; printf "RC=%d" "$?"',
      { ...hostEnv, AFK_HOME: afkHome, AFK_SERVER: server.url },
    );

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "2" });
    expect(await exists(join(afkHome, "current"))).toBe(false);
  });

  it("returns 3 naming curl's reason when the server is unreachable, and afk start's wait loop exits 1 on that", async () => {
    const afkHome = await makeTempDir();
    const env = { ...hostEnv, AFK_HOME: afkHome, AFK_SERVER: "http://127.0.0.1:1" };

    const direct = await runBash('create_session; printf "RC=%d" "$?"', env);
    const waited = await runBash("create_session_or_wait", env);

    expect(parseKeyValueLines(direct.stdout), direct.stderr).toMatchObject({ RC: "3" });
    expect(direct.stderr).toMatch(/could not reach http:\/\/127\.0\.0\.1:1: .*connect/i);
    expect(waited.code).toBe(1);
    expect(waited.stderr).toMatch(/could not reach/);
  });

  it("returns 1 rather than exiting when the server refuses with a 500, so a chain can retry", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 500, body: '{"error":"boom"}' }));

    const { stdout, stderr } = await runBash('create_session; printf "RC=%d" "$?"', {
      ...hostEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "1" });
    expect(stderr).toContain("HTTP 500");
    expect(await exists(join(afkHome, "current"))).toBe(false);
  });
});

describe("create_session with a previous session", () => {
  const hostEnv = {
    HOST_NAME: "test-host",
    HOST_PLATFORM: "darwin",
    HOST_OS_VERSION: "26.0",
    HOST_CPU_COUNT: "8",
    HOST_MEMORY_BYTES: "17179869184",
  };

  it("sends previousSessionId with the previous session's token as the bearer and switches to the successor", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({
      status: 201,
      body: '{"sessionId":"newSession","ingestToken":"tok-new","dashboardUrl":"http://example.test/s/newSession","maxDurationSeconds":3600}',
    }));

    const { stdout, stderr } = await runBash(
      [
        'create_session oldSession tok-old; printf "RC=%d\\n" "$?"',
        'printf "SESSION_ID=%s\\nINGEST_TOKEN=%s\\n" "$SESSION_ID" "$INGEST_TOKEN"',
        'printf "CURRENT_ID=%s\\n" "$(sed -n "s/^sessionId=//p" "$AFK_HOME/current")"',
      ].join("\n"),
      { ...hostEnv, AFK_HOME: afkHome, AFK_SERVER: server.url },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({
      RC: "0",
      SESSION_ID: "newSession",
      INGEST_TOKEN: "tok-new",
      CURRENT_ID: "newSession",
    });
    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request).toMatchObject({
      method: "POST",
      url: "/api/sessions",
      headers: expect.objectContaining({ authorization: "Bearer tok-old" }),
    });
    expect(JSON.parse(request!.body)).toMatchObject({ previousSessionId: "oldSession" });
  });

  it("sends no bearer without a previous session", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({
      status: 201,
      body: '{"sessionId":"abc123","ingestToken":"tok","dashboardUrl":"http://example.test/s/abc123","maxDurationSeconds":3600}',
    }));

    await runBash("create_session", { ...hostEnv, AFK_HOME: afkHome, AFK_SERVER: server.url });

    expect(server.requests[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(server.requests[0]!.body)).not.toHaveProperty("previousSessionId");
  });
});

/**
 * A stand-in for the real server during a chain: the old session's ingest answers as
 * configured, the create answers 201 with a new session, the new session's ingest
 * answers 200.
 */
function chainServer(oldSessionId: string, newSessionId: string, oldIngestStatus = 200) {
  return startServer((req) => {
    if (req.url === "/api/sessions") {
      return {
        status: 201,
        body: `{"sessionId":"${newSessionId}","ingestToken":"tok-new","dashboardUrl":"http://example.test/s/${newSessionId}","maxDurationSeconds":3600}`,
      };
    }
    if (req.url === `/api/sessions/${oldSessionId}/frames`) {
      return { status: oldIngestStatus, body: '{"error":"session ended"}' };
    }
    return { status: 200, body: '{"accepted":1,"duplicates":0,"latestSequence":{}}' };
  });
}

describe("chain_session", () => {
  const hostEnv = {
    HOST_NAME: "test-host",
    HOST_PLATFORM: "darwin",
    HOST_OS_VERSION: "26.0",
    HOST_CPU_COUNT: "8",
    HOST_MEMORY_BYTES: "17179869184",
  };

  /** The old session as `afk start` leaves it: current, owner.pid, and a queue with one frame. */
  async function makeOldSession(afkHome: string, serverUrl: string): Promise<string> {
    const sessionDir = join(afkHome, "sessions", "oldSession");
    await mkdir(join(sessionDir, "queue"), { recursive: true });
    await writeFile(join(sessionDir, "queue", "0000000007-system.ndjson"), "OLD\n");
    await writeFile(
      join(afkHome, "current"),
      `sessionId=oldSession\ningestToken=tok-old\nserver=${serverUrl}\ndashboardUrl=http://example.test/s/oldSession\n`,
    );
    return sessionDir;
  }

  const sessionEnv = (afkHome: string, serverUrl: string) => ({
    ...hostEnv,
    AFK_HOME: afkHome,
    AFK_SERVER: serverUrl,
    SESSION_ID: "oldSession",
    INGEST_TOKEN: "tok-old",
    SESSION_DIR: join(afkHome, "sessions", "oldSession"),
    MAX_DURATION_SECONDS: "3600",
    SEQ_SYSTEM: "7",
    SEQ_PROCESSES: "2",
    SAMPLE_TICK: "7",
  });

  it("flushes the old queue, creates the successor from it, rewrites current, restarts the sender, and resets sequences", async () => {
    const afkHome = await makeTempDir();
    const server = await chainServer("oldSession", "newSession");
    const oldDir = await makeOldSession(afkHome, server.url);

    const { stdout, stderr } = await runBash(
      [
        // A sleeping background job stands in for the old sender.
        "sleep 30 & SENDER_PID=$!; OLD_SENDER=$!",
        'chain_session > "$AFK_HOME/chain.out"; printf "RC=%d\\n" "$?"',
        'printf "SESSION_ID=%s\\nINGEST_TOKEN=%s\\nSESSION_DIR=%s\\n" "$SESSION_ID" "$INGEST_TOKEN" "$SESSION_DIR"',
        'printf "SEQ=%s/%s/%s\\n" "$SEQ_SYSTEM" "$SEQ_PROCESSES" "$SAMPLE_TICK"',
        'printf "CURRENT_ID=%s\\n" "$(sed -n "s/^sessionId=//p" "$AFK_HOME/current")"',
        'printf "OLD_SENDER_ALIVE=%s\\n" "$(kill -0 "$OLD_SENDER" 2>/dev/null && echo yes || echo no)"',
        'printf "NEW_SENDER_ALIVE=%s\\n" "$(kill -0 "$SENDER_PID" 2>/dev/null && echo yes || echo no)"',
        'printf "OLD_DONE=%s\\n" "$(test -e "$OLD_DIR/done" && echo yes || echo no)"',
        'printf "URL=%s\\n" "$DASHBOARD_URL"',
        'printf "PRINTED=%s\\n" "$(tr -d "\\n " < "$AFK_HOME/chain.out")"',
        'kill "$SENDER_PID"; wait "$SENDER_PID" 2>/dev/null',
      ].join("\n"),
      { ...sessionEnv(afkHome, server.url), OLD_DIR: oldDir },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({
      RC: "0",
      SESSION_ID: "newSession",
      INGEST_TOKEN: "tok-new",
      SESSION_DIR: join(afkHome, "sessions", "newSession"),
      SEQ: "0/0/0",
      CURRENT_ID: "newSession",
      OLD_SENDER_ALIVE: "no",
      NEW_SENDER_ALIVE: "yes",
      OLD_DONE: "yes",
      URL: "http://example.test/s/newSession",
      // The new URL is printed the way the first one was; no QR off a terminal.
      PRINTED: "http://example.test/s/newSession",
    });
    // The old queue went to the old session before the successor was asked for.
    expect(server.requests.map((req) => req.url)).toEqual([
      "/api/sessions/oldSession/frames",
      "/api/sessions",
    ]);
    expect(server.requests[0]!.body).toBe("OLD\n");
    expect(server.requests[1]!.headers.authorization).toBe("Bearer tok-old");
    expect(JSON.parse(server.requests[1]!.body)).toMatchObject({ previousSessionId: "oldSession" });
    expect(await queueFiles(oldDir)).toEqual([]);
    expect(stderr).toContain("continuing in session newSession");
  });

  it("does not create the successor while the old queue cannot be flushed, and restarts the old sender", async () => {
    const afkHome = await makeTempDir();
    const server = await chainServer("oldSession", "newSession", 500);
    const oldDir = await makeOldSession(afkHome, server.url);

    const { stdout, stderr } = await runBash(
      [
        "sleep 30 & SENDER_PID=$!",
        'chain_session > "$AFK_HOME/chain.out"; printf "RC=%d\\n" "$?"',
        'printf "SESSION_ID=%s\\n" "$SESSION_ID"',
        'printf "SENDER_ALIVE=%s\\n" "$(kill -0 "$SENDER_PID" 2>/dev/null && echo yes || echo no)"',
        'kill "$SENDER_PID"; wait "$SENDER_PID" 2>/dev/null',
      ].join("\n"),
      sessionEnv(afkHome, server.url),
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({
      RC: "1",
      SESSION_ID: "oldSession",
      SENDER_ALIVE: "yes",
    });
    expect(server.requests.map((req) => req.url)).toEqual(["/api/sessions/oldSession/frames"]);
    expect(await queueFiles(oldDir)).toEqual(["0000000007-system.ndjson"]);
  });

  it("goes ahead when the old session already answers 410, since nothing more can reach it", async () => {
    const afkHome = await makeTempDir();
    const server = await chainServer("oldSession", "newSession", 410);
    await makeOldSession(afkHome, server.url);

    const { stdout, stderr } = await runBash(
      [
        "sleep 30 & SENDER_PID=$!",
        'chain_session > "$AFK_HOME/chain.out"; printf "RC=%d\\n" "$?"',
        'printf "SESSION_ID=%s\\n" "$SESSION_ID"',
        'kill "$SENDER_PID"; wait "$SENDER_PID" 2>/dev/null',
      ].join("\n"),
      sessionEnv(afkHome, server.url),
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "0", SESSION_ID: "newSession" });
    expect(server.requests.map((req) => req.url)).toEqual([
      "/api/sessions/oldSession/frames",
      "/api/sessions",
    ]);
  });
});

describe("sender_loop when the session is over on the server", () => {
  const baseEnv = { INGEST_TOKEN: "tok-old", SESSION_ID: "oldSession", AFK_VERSION: "0.1.0" };

  /** A joiner's queue: one run frame under its run directory. */
  async function makeJoinerQueue(afkHome: string): Promise<string> {
    const runDir = join(afkHome, "sessions", "oldSession", "runs", "ab12cd34");
    await mkdir(join(runDir, "queue"), { recursive: true });
    await writeFile(join(runDir, "queue", "0000000003-run:ab12cd34.ndjson"), "RUN\n");
    return runDir;
  }

  it("re-attaches a joiner to the successor named in current and resends its queue there", async () => {
    const afkHome = await makeTempDir();
    const server = await chainServer("oldSession", "newSession", 410);
    const runDir = await makeJoinerQueue(afkHome);
    await writeFile(
      join(afkHome, "current"),
      `sessionId=newSession\ningestToken=tok-new\nserver=${server.url}\ndashboardUrl=http://example.test/s/newSession\n`,
    );

    const { stdout, stderr } = await runBash(
      [
        'echo "$$" > "$AFK_HOME/owner.pid"',
        'sender_loop 2>"$AFK_HOME/sender.log" & SENDER=$!',
        // 410, a one second look again at current, the resend, then idle.
        "sleep 3",
        'kill "$SENDER"; wait "$SENDER" 2>/dev/null',
        'cat "$AFK_HOME/sender.log"',
        'printf "STOP=%s\\n" "$(test -e "$SESSION_DIR/stop" && echo yes || echo no)"',
      ].join("\n"),
      {
        ...baseEnv,
        AFK_HOME: afkHome,
        AFK_SERVER: server.url,
        SESSION_DIR: runDir,
        SESSION_ROLE: "joiner",
      },
    );

    expect(stdout, stderr).toContain("session oldSession ended; continuing in session newSession");
    expect(stdout).toContain("STOP=no");
    expect(server.requests.map((req) => [req.url, req.headers.authorization])).toEqual([
      ["/api/sessions/oldSession/frames", "Bearer tok-old"],
      ["/api/sessions/newSession/frames", "Bearer tok-new"],
    ]);
    expect(server.requests[1]!.body).toBe("RUN\n");
    expect(await queueFiles(runDir)).toEqual([]);
  });

  it("stops a joiner when current still names the ended session", async () => {
    const afkHome = await makeTempDir();
    const server = await chainServer("oldSession", "newSession", 410);
    const runDir = await makeJoinerQueue(afkHome);
    await writeFile(
      join(afkHome, "current"),
      `sessionId=oldSession\ningestToken=tok-old\nserver=${server.url}\ndashboardUrl=http://example.test/s/oldSession\n`,
    );

    const { code, stderr } = await runBash('echo "$$" > "$AFK_HOME/owner.pid"; sender_loop', {
      ...baseEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
      SESSION_DIR: runDir,
      SESSION_ROLE: "joiner",
    });

    expect(code, stderr).toBe(0);
    expect(server.requests.map((req) => req.url)).toEqual(["/api/sessions/oldSession/frames"]);
    expect(await exists(join(runDir, "stop"))).toBe(true);
    expect(await queueFiles(runDir)).toEqual(["0000000003-run:ab12cd34.ndjson"]);
  });

  it("leaves a gone marker for a chaining owner and a stop marker otherwise", async () => {
    const afkHome = await makeTempDir();
    const server = await chainServer("oldSession", "newSession", 410);
    const sessionDir = join(afkHome, "sessions", "oldSession");
    await mkdir(join(sessionDir, "queue"), { recursive: true });
    await writeFile(join(sessionDir, "queue", "0000000001-system.ndjson"), "SYS\n");
    const env = { ...baseEnv, AFK_HOME: afkHome, AFK_SERVER: server.url, SESSION_DIR: sessionDir };

    const chaining = await runBash("sender_loop", { ...env, SESSION_CHAINING: "1" });
    const plain = await runBash('rm -f "$SESSION_DIR/gone"; sender_loop', env);

    expect(chaining.code, chaining.stderr).toBe(0);
    expect(plain.code, plain.stderr).toBe(0);
    expect(server.requests).toHaveLength(2);
    expect(await exists(join(sessionDir, "gone"))).toBe(false);
    expect(await exists(join(sessionDir, "stop"))).toBe(true);
  });
});

describe("sender_loop when the session was deleted on the server", () => {
  const baseEnv = { INGEST_TOKEN: "tok-old", SESSION_ID: "oldSession", AFK_VERSION: "0.1.0" };
  const DELETED_LINE = "afk: session oldSession was deleted on the server; telemetry stopped";

  /** A server that has forgotten every session: 404 to everything. */
  function deletedServer(): Promise<TestServer> {
    return startServer(() => ({
      status: 404,
      body: '{"error":"session deleted","details":{"reason":"deleted"}}',
    }));
  }

  async function makeOwnerQueue(afkHome: string): Promise<string> {
    const sessionDir = join(afkHome, "sessions", "oldSession");
    await mkdir(join(sessionDir, "queue"), { recursive: true });
    await writeFile(join(sessionDir, "queue", "0000000001-system.ndjson"), "SYS\n");
    await writeFile(join(sessionDir, "queue", "0000000002-system.ndjson"), "SYS\n");
    return sessionDir;
  }

  it("stops, drops the queue, leaves deleted and stop markers, and says so once, even for a chaining owner", async () => {
    const afkHome = await makeTempDir();
    const server = await deletedServer();
    const sessionDir = await makeOwnerQueue(afkHome);

    const { code, stderr } = await runBash("sender_loop", {
      ...baseEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
      SESSION_DIR: sessionDir,
      SESSION_CHAINING: "1",
    });

    expect(code, stderr).toBe(0);
    expect(stderr.split("\n").filter((line) => line === DELETED_LINE)).toHaveLength(1);
    expect(server.requests.map((req) => req.url)).toEqual(["/api/sessions/oldSession/frames"]);
    expect(await queueFiles(sessionDir)).toEqual([]);
    expect(await exists(join(sessionDir, "deleted"))).toBe(true);
    expect(await exists(join(sessionDir, "stop"))).toBe(true);
    // Not a `gone` marker: that is what makes the sampler loop open a successor.
    expect(await exists(join(sessionDir, "gone"))).toBe(false);
  });

  it("does not chain from the sampler loop, even when the session is old enough to", async () => {
    const afkHome = await makeTempDir();
    const server = await deletedServer();
    const sessionDir = await makeOwnerQueue(afkHome);

    // The sampler loop with a sender under it, the way afk start runs; the sender's 404
    // must stop the loop rather than leave it chaining at the cap.
    const { code, stderr } = await runBash(
      [
        "collect_system() { echo '{}'; }; collect_processes() { echo '{}'; }",
        "sender_loop & SENDER_PID=$!",
        "SESSION_CHAINING=1 MAX_DURATION_SECONDS=4 system_sampler_loop",
        'printf "QUEUE=%s\\n" "$(queue_count)"',
      ].join("\n"),
      { ...baseEnv, AFK_HOME: afkHome, AFK_SERVER: server.url, SESSION_DIR: sessionDir },
      10_000,
    );

    expect(code, stderr).toBe(0);
    expect(stderr).toContain(DELETED_LINE);
    expect(server.requests.filter((req) => req.url === "/api/sessions")).toEqual([]);
    expect(await exists(join(sessionDir, "deleted"))).toBe(true);
  });

  it("stops a joiner too, in its own run directory, leaving the owner's files alone", async () => {
    const afkHome = await makeTempDir();
    const server = await deletedServer();
    const runDir = join(afkHome, "sessions", "oldSession", "runs", "ab12cd34");
    await mkdir(join(runDir, "queue"), { recursive: true });
    await writeFile(join(runDir, "queue", "0000000003-run:ab12cd34.ndjson"), "RUN\n");
    await writeFile(
      join(afkHome, "current"),
      `sessionId=oldSession\ningestToken=tok-old\nserver=${server.url}\ndashboardUrl=http://example.test/s/oldSession\n`,
    );

    const { code, stderr } = await runBash('echo "$$" > "$AFK_HOME/owner.pid"; sender_loop', {
      ...baseEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
      SESSION_DIR: runDir,
      SESSION_ROLE: "joiner",
    });

    expect(code, stderr).toBe(0);
    expect(stderr).toContain(DELETED_LINE);
    expect(await queueFiles(runDir)).toEqual([]);
    expect(await exists(join(runDir, "deleted"))).toBe(true);
    expect(await exists(join(afkHome, "current"))).toBe(true);
  });

  it("follows a joiner to the successor named in current when only the old session was deleted", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer((req) =>
      req.url.startsWith("/api/sessions/oldSession/")
        ? { status: 404, body: '{"error":"session deleted","details":{"reason":"deleted"}}' }
        : { status: 200, body: '{"accepted":1,"duplicates":0,"latestSequence":{}}' },
    );
    const runDir = join(afkHome, "sessions", "oldSession", "runs", "ab12cd34");
    await mkdir(join(runDir, "queue"), { recursive: true });
    await writeFile(join(runDir, "queue", "0000000003-run:ab12cd34.ndjson"), "RUN\n");
    await writeFile(
      join(afkHome, "current"),
      `sessionId=newSession\ningestToken=tok-new\nserver=${server.url}\ndashboardUrl=http://example.test/s/newSession\n`,
    );

    const { stdout, stderr } = await runBash(
      [
        'echo "$$" > "$AFK_HOME/owner.pid"',
        'sender_loop 2>"$AFK_HOME/sender.log" & SENDER=$!',
        "sleep 3",
        'kill "$SENDER"; wait "$SENDER" 2>/dev/null',
        'cat "$AFK_HOME/sender.log"',
      ].join("\n"),
      {
        ...baseEnv,
        AFK_HOME: afkHome,
        AFK_SERVER: server.url,
        SESSION_DIR: runDir,
        SESSION_ROLE: "joiner",
      },
    );

    expect(stdout, stderr).toContain(
      "session oldSession was deleted; continuing in session newSession",
    );
    expect(server.requests.map((req) => [req.url, req.headers.authorization])).toEqual([
      ["/api/sessions/oldSession/frames", "Bearer tok-old"],
      ["/api/sessions/newSession/frames", "Bearer tok-new"],
    ]);
    expect(await exists(join(runDir, "deleted"))).toBe(false);
  });
});

describe("flush_queue when the session was deleted on the server", () => {
  it("drops the rest of the queue, leaves the markers, and prints the deleted line once", async () => {
    const afkHome = await makeTempDir();
    const sessionDir = join(afkHome, "sessions", "oldSession");
    await mkdir(join(sessionDir, "queue"), { recursive: true });
    await writeFile(join(sessionDir, "queue", "0000000001-system.ndjson"), "SYS\n");
    await writeFile(join(sessionDir, "queue", "0000000002-system.ndjson"), "SYS\n");
    const server = await startServer(() => ({ status: 404, body: '{"error":"unknown session"}' }));

    const { code, stderr } = await runBash("flush_queue; flush_queue", {
      INGEST_TOKEN: "tok-old",
      SESSION_ID: "oldSession",
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
      SESSION_DIR: sessionDir,
    });

    expect(code, stderr).toBe(0);
    expect(stderr.split("\n").filter((line) => line.includes("was deleted"))).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
    expect(await queueFiles(sessionDir)).toEqual([]);
    expect(await exists(join(sessionDir, "deleted"))).toBe(true);
  });
});

describe("owner exit", () => {
  const hostEnv = {
    HOST_NAME: "test-host",
    HOST_PLATFORM: "darwin",
    HOST_OS_VERSION: "26.0",
    HOST_CPU_COUNT: "8",
    HOST_MEMORY_BYTES: "17179869184",
  };
  const created =
    '{"sessionId":"abc123","ingestToken":"tok-abc","dashboardUrl":"http://example.test/s/abc123","maxDurationSeconds":3600}';

  it("removes current and owner.pid however the owner exits, including through die", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 201, body: created }));

    const { code } = await runBash('create_session; die "something broke"', {
      ...hostEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code).toBe(1);
    expect(await exists(join(afkHome, "current"))).toBe(false);
    expect(await exists(join(afkHome, "owner.pid"))).toBe(false);
  });

  it("leaves them in place when only a background subshell of the owner exits", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 201, body: created }));

    const { stdout, stderr } = await runBash(
      [
        "create_session",
        '( : ) & wait "$!"; x=$(true)',
        'printf "CURRENT=%s\\nOWNER=%s\\n" "$(test -f "$AFK_HOME/current" && echo yes || echo no)" "$(test -f "$AFK_HOME/owner.pid" && echo yes || echo no)"',
      ].join("\n"),
      { ...hostEnv, AFK_HOME: afkHome, AFK_SERVER: server.url },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ CURRENT: "yes", OWNER: "yes" });
  });
});

describe("load_current_session", () => {
  it("returns success and reads session details for an active session", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({
      status: 200,
      body: '{"status":"active","maxDurationSeconds":1800}',
    }));
    await writeFile(
      join(afkHome, "current"),
      "sessionId=abc123\ningestToken=tok-abc\n" +
        `server=${server.url}\n` +
        "dashboardUrl=http://example.test/s/abc123\n",
    );

    const { stdout, stderr } = await runBash(
      [
        'load_current_session; printf "RC=%d\\n" "$?"',
        'printf "SESSION_DIR=%s\\n" "$SESSION_DIR"',
        'printf "MAX_DURATION_SECONDS=%s\\n" "$MAX_DURATION_SECONDS"',
      ].join("\n"),
      { AFK_HOME: afkHome, AFK_SERVER: server.url },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({
      RC: "0",
      SESSION_DIR: `${afkHome}/sessions/abc123`,
      MAX_DURATION_SECONDS: "1800",
    });
    // Unlike the ended-session case below, an active session's file is left in place.
    await expect(readFile(join(afkHome, "current"), "utf8")).resolves.not.toBeNull();
  });

  it("fails and removes the file when the session has ended", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: '{"status":"ended"}' }));
    await writeFile(
      join(afkHome, "current"),
      "sessionId=abc123\ningestToken=tok-abc\n" +
        `server=${server.url}\n` +
        "dashboardUrl=http://example.test/s/abc123\n",
    );

    const { stdout, stderr } = await runBash('load_current_session; printf "RC=%d" "$?"', {
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "1" });
    expect(await exists(join(afkHome, "current"))).toBe(false);
  });

  it("fails when there is no current session file", async () => {
    const afkHome = await makeTempDir();

    const { stdout, stderr } = await runBash('load_current_session; printf "RC=%d" "$?"', {
      AFK_HOME: afkHome,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "1" });
  });

  it("fails and removes the files without asking the server when the owner pid is dead", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: '{"status":"active"}' }));
    await writeFile(
      join(afkHome, "current"),
      "sessionId=abc123\ningestToken=tok-abc\n" +
        `server=${server.url}\n` +
        "dashboardUrl=http://example.test/s/abc123\n",
    );

    // A subshell that has already exited: its pid is certainly not alive.
    const { stdout, stderr } = await runBash(
      [
        '(exit 0) & wait "$!"; echo "$!" > "$AFK_HOME/owner.pid"',
        'load_current_session; printf "RC=%d" "$?"',
      ].join("\n"),
      { AFK_HOME: afkHome, AFK_SERVER: server.url },
    );

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "1" });
    expect(server.requests).toHaveLength(0);
    expect(await exists(join(afkHome, "current"))).toBe(false);
    expect(await exists(join(afkHome, "owner.pid"))).toBe(false);
  });

  it("asks the server when the owner pid is alive", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: '{"status":"active"}' }));
    await writeFile(
      join(afkHome, "current"),
      "sessionId=abc123\ningestToken=tok-abc\n" +
        `server=${server.url}\n` +
        "dashboardUrl=http://example.test/s/abc123\n",
    );

    const { stdout, stderr } = await runBash(
      ['echo "$$" > "$AFK_HOME/owner.pid"', 'load_current_session; printf "RC=%d" "$?"'].join("\n"),
      { AFK_HOME: afkHome, AFK_SERVER: server.url },
    );

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "0" });
    expect(server.requests.map((request) => request.url)).toEqual(["/api/sessions/abc123"]);
    expect(await exists(join(afkHome, "current"))).toBe(true);
  });
});

describe("end_session", () => {
  it("tells the server, removes current and owner.pid, and leaves a done marker", async () => {
    const afkHome = await makeTempDir();
    const sessionDir = join(afkHome, "sessions", "abc123");
    await mkdir(join(sessionDir, "queue"), { recursive: true });
    await writeFile(join(afkHome, "current"), "sessionId=abc123\ningestToken=tok-abc\n");
    await writeFile(join(afkHome, "owner.pid"), "12345\n");
    const server = await startServer(() => ({ status: 200, body: '{"status":"ended"}' }));

    const { code, stderr } = await runBash("end_session", {
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
      SESSION_ID: "abc123",
      INGEST_TOKEN: "tok-abc",
      SESSION_DIR: sessionDir,
    });

    expect(code, stderr).toBe(0);
    expect(server.requests).toMatchObject([{ method: "POST", url: "/api/sessions/abc123/end" }]);
    expect(await exists(join(afkHome, "current"))).toBe(false);
    expect(await exists(join(afkHome, "owner.pid"))).toBe(false);
    expect(await exists(join(sessionDir, "done"))).toBe(true);
  });

  it("returns 1 and says the session was deleted when the server answers 404, still clearing the state", async () => {
    const afkHome = await makeTempDir();
    const sessionDir = join(afkHome, "sessions", "abc123");
    await mkdir(join(sessionDir, "queue"), { recursive: true });
    await writeFile(join(afkHome, "current"), "sessionId=abc123\ningestToken=tok-abc\n");
    const server = await startServer(() => ({
      status: 404,
      body: '{"error":"session deleted","details":{"reason":"deleted"}}',
    }));

    const { stdout, stderr } = await runBash('end_session; printf "RC=%d\\n" "$?"', {
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
      SESSION_ID: "abc123",
      INGEST_TOKEN: "tok-abc",
      SESSION_DIR: sessionDir,
    });

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "1" });
    expect(stderr).toContain("afk: session abc123 was deleted on the server; telemetry stopped");
    expect(await exists(join(afkHome, "current"))).toBe(false);
    expect(await exists(join(sessionDir, "deleted"))).toBe(true);
    expect(await exists(join(sessionDir, "done"))).toBe(true);
  });
});

describe("cleanup_old_sessions", () => {
  /** Session directories aged with touch -t: two that ended, two that never did. */
  async function makeAgedSessions(afkHome: string): Promise<void> {
    for (const id of ["ended-old", "ended-fresh", "orphan-old", "orphan-fresh"]) {
      await mkdir(join(afkHome, "sessions", id, "queue"), { recursive: true });
    }
    await writeFile(join(afkHome, "sessions", "ended-old", "done"), "");
    await writeFile(join(afkHome, "sessions", "ended-fresh", "done"), "");
    await runBash(
      [
        'touch -t "$(date -v-25H +%Y%m%d%H%M.%S)" "$AFK_HOME/sessions/ended-old/done"',
        'touch -t "$(date -v-23H +%Y%m%d%H%M.%S)" "$AFK_HOME/sessions/ended-fresh/done"',
        'touch -t "$(date -v-49H +%Y%m%d%H%M.%S)" "$AFK_HOME/sessions/orphan-old"',
        'touch -t "$(date -v-47H +%Y%m%d%H%M.%S)" "$AFK_HOME/sessions/orphan-fresh"',
      ].join("\n"),
      { AFK_HOME: afkHome },
    );
  }

  // Ages files with BSD date -v and reads them back with BSD stat -f, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "removes sessions that ended over a day ago and orphans untouched for over two days",
    async () => {
      const afkHome = await makeTempDir();
      await makeAgedSessions(afkHome);

      const { code, stderr } = await runBash("cleanup_old_sessions", { AFK_HOME: afkHome });

      expect(code, stderr).toBe(0);
      expect((await readdir(join(afkHome, "sessions"))).sort()).toEqual([
        "ended-fresh",
        "orphan-fresh",
      ]);
    },
  );

  it("does nothing when there is no sessions directory yet", async () => {
    const afkHome = await makeTempDir();

    const { code, stderr } = await runBash("cleanup_old_sessions", { AFK_HOME: afkHome });

    expect(code, stderr).toBe(0);
  });
});

describe("resend_leftover_queues", () => {
  const accepted = '{"accepted":1,"duplicates":0,"latestSequence":{}}';

  /** A session whose owner exited with frames still queued: its record and queue, no `current`. */
  async function makeLeftoverSession(
    afkHome: string,
    serverUrl: string,
    id = "oldSession",
  ): Promise<string> {
    const sessionDir = join(afkHome, "sessions", id);
    await mkdir(join(sessionDir, "queue"), { recursive: true });
    await writeFile(
      join(sessionDir, "session.json"),
      JSON.stringify({
        sessionId: id,
        ingestToken: `tok-${id}`,
        server: serverUrl,
        dashboardUrl: `http://example.test/s/${id}`,
      }),
    );
    await writeFile(join(sessionDir, "queue", "0000000007-system.ndjson"), "SEVEN\n");
    await writeFile(join(sessionDir, "queue", "0000000008-system.ndjson"), "EIGHT\n");
    return sessionDir;
  }

  it("sends an old session's queue with its own token and server, deletes what was accepted, and logs it", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: accepted }));
    const oldDir = await makeLeftoverSession(afkHome, server.url);

    const { code, stderr } = await runBash("resend_leftover_queues", {
      AFK_HOME: afkHome,
      AFK_SERVER: "http://the-new-server.test",
    });

    expect(code, stderr).toBe(0);
    expect(server.requests).toMatchObject([
      {
        url: "/api/sessions/oldSession/frames",
        headers: expect.objectContaining({ authorization: "Bearer tok-oldSession" }),
        body: "SEVEN\nEIGHT\n",
      },
    ]);
    expect(await queueFiles(oldDir)).toEqual([]);
    expect(stderr).toContain("sent 2 frames left over from session oldSession");
  });

  it("goes back to the server afk start was given once the old queues are done", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: accepted }));
    await makeLeftoverSession(afkHome, server.url);

    const { stdout, stderr } = await runBash(
      'resend_leftover_queues; printf "AFK_SERVER=%s\\n" "$AFK_SERVER"',
      { AFK_HOME: afkHome, AFK_SERVER: "http://the-new-server.test" },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({
      AFK_SERVER: "http://the-new-server.test",
    });
  });

  it.each([410, 404])(
    "drops the queue and marks the session done when the server answers %i, since the session is over",
    async (status) => {
      const afkHome = await makeTempDir();
      const server = await startServer(() => ({ status, body: '{"error":"gone"}' }));
      const oldDir = await makeLeftoverSession(afkHome, server.url);

      const { code, stderr } = await runBash("resend_leftover_queues", { AFK_HOME: afkHome });

      expect(code, stderr).toBe(0);
      expect(server.requests).toHaveLength(1);
      expect(await exists(join(oldDir, "queue"))).toBe(false);
      expect(await exists(join(oldDir, "done"))).toBe(true);
      expect(stderr).toContain("session oldSession is over on the server");
    },
  );

  it("keeps the queue for the next start when the server cannot be reached", async () => {
    const afkHome = await makeTempDir();
    const oldDir = await makeLeftoverSession(afkHome, "http://127.0.0.1:1");

    const { code, stderr } = await runBash("resend_leftover_queues", { AFK_HOME: afkHome });

    expect(code, stderr).toBe(0);
    expect(await queueFiles(oldDir)).toEqual([
      "0000000007-system.ndjson",
      "0000000008-system.ndjson",
    ]);
    expect(stderr).toMatch(/could not send the 2 frames left over from session oldSession/);
  });

  it("keeps the rest of the queue when a batch fails part way", async () => {
    const afkHome = await makeTempDir();
    let batches = 0;
    const server = await startServer(() => {
      batches += 1;
      return batches === 1 ? { status: 200, body: accepted } : { status: 500, body: "{}" };
    });
    const oldDir = await makeLeftoverSession(afkHome, server.url);

    const { code, stderr } = await runBash("SEND_MAX_FILES_PER_BATCH=1\nresend_leftover_queues", {
      AFK_HOME: afkHome,
    });

    expect(code, stderr).toBe(0);
    expect(await queueFiles(oldDir)).toEqual(["0000000008-system.ndjson"]);
    expect(stderr).toContain("could not send the 1 frames left over");
  });

  it("leaves a queue without a session record alone, since it has no token to send it with", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: accepted }));
    const oldDir = await makeLeftoverSession(afkHome, server.url);
    await rm(join(oldDir, "session.json"));

    const { code, stderr } = await runBash("resend_leftover_queues", { AFK_HOME: afkHome });

    expect(code, stderr).toBe(0);
    expect(server.requests).toHaveLength(0);
    expect(await queueFiles(oldDir)).toHaveLength(2);
  });

  // check_platform runs first and only passes on macOS.
  it.skipIf(process.platform !== "darwin")(
    "afk start sends the leftovers before it creates its own session",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startServer((req) =>
        req.url === "/api/sessions"
          ? {
              status: 201,
              body: '{"sessionId":"newSession","ingestToken":"tok-new","dashboardUrl":"http://example.test/s/newSession","maxDurationSeconds":3600}',
            }
          : { status: 200, body: accepted },
      );
      await makeLeftoverSession(afkHome, server.url);

      const { stdout, stderr } = await runBash(
        [
          'main start --no-qr > "$AFK_HOME/out.txt" 2> "$AFK_HOME/err.txt" & START=$!',
          'for _ in $(seq 1 40); do grep -q "/s/newSession" "$AFK_HOME/out.txt" 2>/dev/null && break; sleep 0.1; done',
          'kill -TERM "$START"; wait "$START"; printf "START_RC=%d\\n" "$?"',
          'printf "LEFTOVER_LOG=%s\\n" "$(grep -c "left over from session oldSession" "$AFK_HOME/err.txt")"',
        ].join("\n"),
        { AFK_HOME: afkHome, AFK_SERVER: server.url },
      );

      expect(parseKeyValueLines(stdout), stderr).toEqual({ START_RC: "0", LEFTOVER_LOG: "1" });
      expect(
        server.requests.slice(0, 2).map((req) => [req.url, req.headers.authorization]),
      ).toEqual([
        ["/api/sessions/oldSession/frames", "Bearer tok-oldSession"],
        ["/api/sessions", undefined],
      ]);
    },
  );
});

describe("afk status", () => {
  it("reports no session and exits 1 when there is no current file", async () => {
    const afkHome = await makeTempDir();

    const { stdout, code } = await runBash("main status", { AFK_HOME: afkHome });

    expect(code).toBe(1);
    expect(stdout).toBe("no session running on this machine\n");
  });

  // Sizes files with BSD stat -f, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "prints the session, dashboard, a live owner, and the queue size",
    async () => {
      const afkHome = await makeTempDir();
      const queue = join(afkHome, "sessions", "abc123", "queue");
      await mkdir(queue, { recursive: true });
      await writeFile(join(queue, "0000000001-system.ndjson"), "x".repeat(10));
      await writeFile(join(queue, "0000000002-system.ndjson"), "x".repeat(30));
      await writeFile(
        join(afkHome, "current"),
        "sessionId=abc123\ningestToken=tok-abc\nserver=http://example.test\ndashboardUrl=http://example.test/s/abc123\n",
      );

      const { stdout, stderr, code } = await runBash(
        'echo "$$" > "$AFK_HOME/owner.pid"; main status',
        { AFK_HOME: afkHome },
      );

      expect(code, stderr).toBe(0);
      expect(stdout).toMatch(/^session\s+abc123\n/);
      expect(stdout).toMatch(/\ndashboard\s+http:\/\/example.test\/s\/abc123\n/);
      expect(stdout).toMatch(/\nowner\s+pid [0-9]+, running\n/);
      expect(stdout).toMatch(/\nqueue\s+2 frames, 40 bytes\n$/);
    },
  );

  it("says when the owner is no longer running", async () => {
    const afkHome = await makeTempDir();
    await mkdir(join(afkHome, "sessions", "abc123", "queue"), { recursive: true });
    await writeFile(join(afkHome, "current"), "sessionId=abc123\ningestToken=tok-abc\n");

    const { stdout, stderr, code } = await runBash(
      '(exit 0) & wait "$!"; echo "$!" > "$AFK_HOME/owner.pid"; main status',
      { AFK_HOME: afkHome },
    );

    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(/\nowner\s+pid [0-9]+, not running/);
  });

  // Sizes files with BSD stat -f, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "counts the joined runs' queues too and lists the runs still going with their command",
    async () => {
      const afkHome = await makeTempDir();
      const sessionDir = join(afkHome, "sessions", "abc123");
      await mkdir(join(sessionDir, "queue"), { recursive: true });
      await writeFile(join(sessionDir, "queue", "0000000001-system.ndjson"), "x".repeat(10));
      const running = join(sessionDir, "runs", "ab12cd34");
      const finished = join(sessionDir, "runs", "ef56ab78");
      for (const runDir of [running, finished]) {
        await mkdir(join(runDir, "queue"), { recursive: true });
        await writeFile(join(runDir, "queue", "0000000003-run.ndjson"), "x".repeat(30));
      }
      await writeFile(join(running, "command"), "npm test -- --watch\n");
      await writeFile(join(finished, "command"), "make\n");
      await writeFile(
        join(afkHome, "current"),
        "sessionId=abc123\ningestToken=tok-abc\nserver=http://example.test\ndashboardUrl=http://example.test/s/abc123\n",
      );

      // This shell stands in for the running command; an exited subshell for the finished one.
      const { stdout, stderr, code } = await runBash(
        [
          'echo "$$" > "$AFK_HOME/owner.pid"',
          'echo "$$" > "$RUNNING/pid"',
          '(exit 0) & wait "$!"; echo "$!" > "$FINISHED/pid"',
          "main status",
        ].join("\n"),
        { AFK_HOME: afkHome, RUNNING: running, FINISHED: finished },
      );

      expect(code, stderr).toBe(0);
      expect(stdout).toMatch(/\nqueue\s+3 frames, 70 bytes\n/);
      expect(stdout).not.toContain("dropped");
      expect(stdout.split("\n").filter((line) => line.startsWith("run "))).toEqual([
        expect.stringMatching(/^run\s+pid [0-9]+, running: npm test -- --watch$/),
      ]);
    },
  );

  it("shows what the queue cap dropped, the owner's and the joined runs' together", async () => {
    const afkHome = await makeTempDir();
    const sessionDir = join(afkHome, "sessions", "abc123");
    await mkdir(join(sessionDir, "runs", "ab12cd34", "queue"), { recursive: true });
    await mkdir(join(sessionDir, "queue"), { recursive: true });
    await writeFile(join(sessionDir, "dropped"), "5 200\n");
    await writeFile(join(sessionDir, "runs", "ab12cd34", "dropped"), "2 80\n");
    await writeFile(join(afkHome, "current"), "sessionId=abc123\ningestToken=tok-abc\n");

    const { stdout, stderr, code } = await runBash(
      'echo "$$" > "$AFK_HOME/owner.pid"; main status',
      {
        AFK_HOME: afkHome,
        AFK_SPOOL_MAX_BYTES: "1000",
      },
    );

    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(/\ndropped\s+7 frames, 280 bytes \(queue over 1000 bytes/);
  });
});

describe("afk stop", () => {
  it("sends SIGTERM to the owner pid", async () => {
    const afkHome = await makeTempDir();
    await writeFile(join(afkHome, "current"), "sessionId=abc123\ningestToken=tok-abc\n");

    // A sleeping background job stands in for the owner; wait reports the signal that ended it.
    const { stdout, stderr } = await runBash(
      [
        'sleep 30 & echo "$!" > "$AFK_HOME/owner.pid"',
        'main stop; printf "STOP_RC=%d\\n" "$?"',
        'wait "$!"; printf "OWNER_RC=%d\\n" "$?"',
      ].join("\n"),
      { AFK_HOME: afkHome },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ STOP_RC: "0", OWNER_RC: "143" });
  });

  it("clears the stale files and exits 1 when the owner is already gone", async () => {
    const afkHome = await makeTempDir();
    await writeFile(join(afkHome, "current"), "sessionId=abc123\ningestToken=tok-abc\n");

    const { code } = await runBash(
      '(exit 0) & wait "$!"; echo "$!" > "$AFK_HOME/owner.pid"; main stop',
      { AFK_HOME: afkHome },
    );

    expect(code).toBe(1);
    expect(await exists(join(afkHome, "current"))).toBe(false);
    expect(await exists(join(afkHome, "owner.pid"))).toBe(false);
  });

  it("exits 1 when there is no session", async () => {
    const afkHome = await makeTempDir();

    const { code, stderr } = await runBash("main stop", { AFK_HOME: afkHome });

    expect(code).toBe(1);
    expect(stderr).toContain("no session running");
  });
});

describe("afk stop while the sender has a request in flight", () => {
  const created =
    '{"sessionId":"abc123","ingestToken":"tok-abc","dashboardUrl":"http://example.test/s/abc123","maxDurationSeconds":3600}';
  const accepted = '{"accepted":1,"duplicates":0,"latestSequence":{}}';
  /** How long the owner may take to exit after `afk stop`; without the fix it is curl's 20 s --max-time. */
  const STOP_DEADLINE_MS = 3_000;
  /** For the sender's first batch to be on the wire. */
  const IN_FLIGHT_DEADLINE_MS = 5_000;
  /** For the killed curl to be reaped. */
  const REAP_DEADLINE_MS = 1_000;

  // Regression: the sender is a subshell that, forked under the owner's EXIT trap,
  // only acts on TERM once its curl returns, so `afk stop` used to wait out the
  // request's whole timeout. Runs the real collectors, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "takes effect within seconds and leaves no curl behind, although the server holds that request open",
    { timeout: 30_000 },
    async () => {
      const afkHome = await makeTempDir();
      let framesRequests = 0;
      const server = await startServer((req) => {
        if (req.url === "/api/sessions") {
          return { status: 201, body: created };
        }
        if (req.url.endsWith("/frames")) {
          framesRequests += 1;
          // The batch in flight when the stop arrives is never answered; the flush's is.
          return framesRequests === 1 ? HOLD_REQUEST : { status: 200, body: accepted };
        }
        return { status: 200, body: '{"status":"ended"}' };
      });
      const owner = spawnAfk(["start", "--no-qr"], { AFK_HOME: afkHome, AFK_SERVER: server.url });
      await waitUntil(
        "the first batch to be in flight",
        () => framesRequests >= 1,
        IN_FLIGHT_DEADLINE_MS,
      );

      const stoppedAt = Date.now();
      const stop = await runAfk(["stop"], { AFK_HOME: afkHome });
      const exitCode = await owner.exited;
      const elapsedMs = Date.now() - stoppedAt;

      expect(stop.code, stop.stderr).toBe(0);
      expect(exitCode, owner.stderr()).toBe(0);
      expect(elapsedMs).toBeLessThan(STOP_DEADLINE_MS);
      expect(server.requests.map((req) => req.url)).toEqual([
        "/api/sessions",
        "/api/sessions/abc123/frames",
        "/api/sessions/abc123/frames",
        "/api/sessions/abc123/end",
      ]);
      // The held request's curl died with its sender rather than living on to its timeout.
      await waitUntil(
        "the held request's curl to be gone",
        async () =>
          (await processesMentioning(`${server.url}/api/sessions/abc123/frames`)).length === 0,
        REAP_DEADLINE_MS,
      );
      expect(await exists(join(afkHome, "current"))).toBe(false);
    },
  );
});

describe("afk start with a session already running", () => {
  const created =
    '{"sessionId":"newSession","ingestToken":"tok-new","dashboardUrl":"http://example.test/s/newSession","maxDurationSeconds":3600}';

  /** A server with one active session and room for another; frames and ends are accepted. */
  function startGuardServer(): Promise<TestServer> {
    return startServer((req) => {
      if (req.url === "/api/sessions" && req.method === "POST") {
        return { status: 201, body: created };
      }
      if (req.url === "/api/sessions/oldSession") {
        return {
          status: 200,
          body: '{"status":"active","maxDurationSeconds":3600,"streamCount":1,"maxStreams":10}',
        };
      }
      return { status: 200, body: '{"accepted":1,"duplicates":0,"latestSequence":{}}' };
    });
  }

  async function writeCurrent(afkHome: string, serverUrl: string): Promise<void> {
    await writeFile(
      join(afkHome, "current"),
      `sessionId=oldSession\ningestToken=tok-old\nserver=${serverUrl}\ndashboardUrl=http://example.test/s/oldSession\n`,
    );
  }

  // check_platform runs first and only passes on macOS.
  it.skipIf(process.platform !== "darwin")(
    "refuses with the running session's URL and the hint, exiting 1 without creating anything",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startGuardServer();
      await writeCurrent(afkHome, server.url);

      const { stdout, stderr, code } = await runBash(
        'echo "$$" > "$AFK_HOME/owner.pid"; main start --no-qr',
        { AFK_HOME: afkHome, AFK_SERVER: server.url },
      );

      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("already running on this machine");
      expect(stderr).toContain("http://example.test/s/oldSession");
      expect(stderr).toContain("afk start --force");
      expect(server.requests.map((req) => req.url)).toEqual(["/api/sessions/oldSession"]);
      expect(await exists(join(afkHome, "current"))).toBe(true);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "--force ends the old owner, clears its files, and starts a new session on the given server",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startGuardServer();
      await writeCurrent(afkHome, server.url);

      // A sleeping background job stands in for the old owner; it dies of the SIGTERM
      // without cleaning up, the way a crashed owner would.
      const { stdout, stderr } = await runBash(
        [
          'sleep 30 & OWNER=$!; echo "$OWNER" > "$AFK_HOME/owner.pid"',
          'main start --force --no-qr > "$AFK_HOME/out.txt" 2> "$AFK_HOME/err.txt" & START=$!',
          'for _ in $(seq 1 40); do grep -q "/s/newSession" "$AFK_HOME/out.txt" 2>/dev/null && break; sleep 0.1; done',
          'kill -TERM "$START"; wait "$START"; printf "START_RC=%d\\n" "$?"',
          'wait "$OWNER" 2>/dev/null; printf "OWNER_RC=%d\\n" "$?"',
          'printf "URL=%s\\n" "$(grep -o "http://example.test/s/[A-Za-z]*" "$AFK_HOME/out.txt")"',
          'printf "TAKEOVER=%s\\n" "$(grep -c "taking over" "$AFK_HOME/err.txt")"',
        ].join("\n"),
        { AFK_HOME: afkHome, AFK_SERVER: server.url },
      );

      expect(parseKeyValueLines(stdout), stderr).toEqual({
        START_RC: "0",
        OWNER_RC: "143",
        URL: "http://example.test/s/newSession",
        TAKEOVER: "1",
      });
      const urls = server.requests.map((req) => req.url);
      expect(urls.slice(0, 2)).toEqual(["/api/sessions/oldSession", "/api/sessions"]);
      expect(urls.at(-1)).toBe("/api/sessions/newSession/end");
      expect(await exists(join(afkHome, "current"))).toBe(false);
    },
  );
});

describe("afk with no state", () => {
  it("help prints the usage and exits 0", async () => {
    const afkHome = await makeTempDir();

    const { stdout, stderr, code } = await runAfk(["help"], { AFK_HOME: afkHome });

    expect(code, stderr).toBe(0);
    expect(stdout).toContain("afk start");
    expect(stdout).toContain("afk status");
    expect(stdout).toContain("afk stop");
  });

  it("status exits 1 with a message and no unbound variable", async () => {
    const afkHome = await makeTempDir();

    const { stdout, stderr, code } = await runAfk(["status"], { AFK_HOME: afkHome });

    expect(code).toBe(1);
    expect(stdout).toContain("no session running");
    expect(stderr).not.toContain("unbound");
  });

  it("stop exits 1 with a message and no unbound variable", async () => {
    const afkHome = await makeTempDir();

    const { stderr, code } = await runAfk(["stop"], { AFK_HOME: afkHome });

    expect(code).toBe(1);
    expect(stderr).toContain("no session running");
    expect(stderr).not.toContain("unbound");
  });

  it("rejects an unknown command", async () => {
    const afkHome = await makeTempDir();

    const { stderr, code } = await runAfk(["bogus"], { AFK_HOME: afkHome });

    expect(code).toBe(1);
    expect(stderr).toContain("unknown command: bogus");
  });
});

describe("print_dashboard_url", () => {
  /** The session as its owner set it up; SESSION_DIR is where the token file for curl goes. */
  const sessionEnv = (afkHome: string) => ({
    SESSION_ID: "sess123",
    INGEST_TOKEN: "tok-abc",
    AFK_VERSION: "0.2.0",
    DASHBOARD_URL: "http://example.test/s/sess123",
    SESSION_DIR: join(afkHome, "sessions", "sess123"),
  });
  /** What the server's text render looks like: half-block lines, then the URL. */
  const QR_TEXT = "█████████\n█▀▀▀▀▀▀▀█\n█ ▄▀▄ ▄ █\n█████████\nhttp://example.test/s/sess123\n";
  /** The URL on a line of its own, for when the QR is not shown. */
  const URL_LINE = "\n  http://example.test/s/sess123\n\n";
  /** The test process has no tty, so a snippet that wants the terminal path says so. */
  const ON_A_TERMINAL = "stdout_is_terminal() { return 0; }";

  it("prints the QR the server returns with the URL under it, fetched with the bearer token and the client header", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: QR_TEXT }));

    const { stdout, stderr, code } = await runBash(`${ON_A_TERMINAL}\nprint_dashboard_url`, {
      ...sessionEnv(afkHome),
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code, stderr).toBe(0);
    expect(stdout).toBe(`\n${QR_TEXT}\n`);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      url: "/api/sessions/sess123/qr",
      headers: expect.objectContaining({
        authorization: "Bearer tok-abc",
        "x-afk-client": "bash/0.2.0",
      }),
    });
  });

  // Regression: the QR check once used grep on a partial UTF-8 byte pair, which macOS
  // grep rejects with "illegal byte sequence" under a UTF-8 locale (the user's shell).
  it("prints the QR under a UTF-8 locale too", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: QR_TEXT }));

    const { stdout, stderr, code } = await runBash(`${ON_A_TERMINAL}\nprint_dashboard_url`, {
      ...sessionEnv(afkHome),
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    });

    expect(code, stderr).toBe(0);
    expect(stderr).not.toContain("illegal byte sequence");
    expect(stdout).toBe(`\n${QR_TEXT}\n`);
  });

  // Regression: an older server answered the QR path with the dashboard's index.html and
  // a 200 from its single-page fallback, and the client printed the whole page.
  it("prints the URL alone when a 200 response is not a QR code", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({
      status: 200,
      body: "<!doctype html>\n<html><body>afk dashboard</body></html>\n",
    }));

    const { stdout, code } = await runBash(`${ON_A_TERMINAL}\nprint_dashboard_url`, {
      ...sessionEnv(afkHome),
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code).toBe(0);
    expect(stdout).toBe(URL_LINE);
  });

  it("prints the URL alone and asks the server for nothing with AFK_NO_QR=1", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: QR_TEXT }));

    const { stdout, code } = await runBash(`${ON_A_TERMINAL}\nprint_dashboard_url`, {
      ...sessionEnv(afkHome),
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
      AFK_NO_QR: "1",
    });

    expect(code).toBe(0);
    expect(stdout).toBe(URL_LINE);
    expect(server.requests).toHaveLength(0);
  });

  it("prints the URL alone when stdout is not a terminal", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: QR_TEXT }));

    const { stdout, code } = await runBash("print_dashboard_url", {
      ...sessionEnv(afkHome),
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code).toBe(0);
    expect(stdout).toBe(URL_LINE);
    expect(server.requests).toHaveLength(0);
  });

  it("prints the URL alone and still succeeds when the server answers with an error", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 500, body: '{"error":"boom"}' }));

    const { stdout, code } = await runBash(`${ON_A_TERMINAL}\nprint_dashboard_url`, {
      ...sessionEnv(afkHome),
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code).toBe(0);
    expect(stdout).toBe(URL_LINE);
  });

  it("prints the URL alone and still succeeds when the server cannot be reached", async () => {
    const afkHome = await makeTempDir();

    const { stdout, code } = await runBash(`${ON_A_TERMINAL}\nprint_dashboard_url`, {
      ...sessionEnv(afkHome),
      AFK_HOME: afkHome,
      // Port 1 needs root to bind and nothing listens there: the connection is refused.
      AFK_SERVER: "http://127.0.0.1:1",
    });

    expect(code).toBe(0);
    expect(stdout).toBe(URL_LINE);
  });
});

// Regression: `afk start` once printed the URL on its own line and then again under the
// QR code. These run the whole command, so they need the macOS collectors.
describe("afk start printing the dashboard URL", () => {
  const URL = "http://example.test/s/newSession";
  const created = `{"sessionId":"newSession","ingestToken":"tok-new","dashboardUrl":"${URL}","maxDurationSeconds":3600}`;
  const QR_TEXT = `█████████\n█▀▀▀▀▀▀▀█\n█ ▄▀▄ ▄ █\n█████████\n${URL}\n`;
  const ON_A_TERMINAL = "stdout_is_terminal() { return 0; }";

  /**
   * A server that creates the session, answers the QR path with `qr`, and accepts the
   * rest. The first frame batch leaves a marker file in `afkHome`: the sampler that
   * produces it only starts once `afk start` has printed the URL and installed its
   * signal handler, so that is when the test can end the session cleanly.
   */
  function startQrServer(afkHome: string, qr: TestResponse): Promise<TestServer> {
    return startServer(async (req) => {
      if (req.url === "/api/sessions") {
        return { status: 201, body: created };
      }
      if (req.url === "/api/sessions/newSession/qr") {
        return qr;
      }
      if (req.url === "/api/sessions/newSession/frames") {
        await writeFile(join(afkHome, "frames-seen"), "");
      }
      return { status: 200, body: '{"accepted":1,"duplicates":0,"latestSequence":{}}' };
    });
  }

  /** Runs `afk start ${args}` until it is sending frames, ends it with SIGTERM, and returns its stdout. */
  async function stdoutOfStart(afkHome: string, serverUrl: string, args = ""): Promise<string> {
    const { stdout, stderr } = await runBash(
      [
        ON_A_TERMINAL,
        `main start ${args} > "$AFK_HOME/out.txt" 2> "$AFK_HOME/err.txt" & START=$!`,
        'for _ in $(seq 1 100); do [ -e "$AFK_HOME/frames-seen" ] && break; sleep 0.1; done',
        'kill -TERM "$START"; wait "$START"; printf "START_RC=%d\\n" "$?"',
      ].join("\n"),
      { AFK_HOME: afkHome, AFK_SERVER: serverUrl },
      15_000,
    );
    expect(parseKeyValueLines(stdout), stderr).toEqual({ START_RC: "0" });
    return readFile(join(afkHome, "out.txt"), "utf8");
  }

  const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

  it.skipIf(process.platform !== "darwin")(
    "prints the URL once, under the QR code, when the server renders one",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startQrServer(afkHome, { status: 200, body: QR_TEXT });

      const out = await stdoutOfStart(afkHome, server.url);

      expect(occurrences(out, URL)).toBe(1);
      expect(out).toBe(`\n${QR_TEXT}\n`);
    },
  );

  it.skipIf(process.platform !== "darwin")("prints the URL once with --no-qr", async () => {
    const afkHome = await makeTempDir();
    const server = await startQrServer(afkHome, { status: 200, body: QR_TEXT });

    const out = await stdoutOfStart(afkHome, server.url, "--no-qr");

    expect(occurrences(out, URL)).toBe(1);
    expect(out).toBe(`\n  ${URL}\n\n`);
    expect(server.requests.map((req) => req.url)).not.toContain("/api/sessions/newSession/qr");
  });

  it.skipIf(process.platform !== "darwin")(
    "prints the URL once when the QR cannot be fetched",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startQrServer(afkHome, { status: 500, body: '{"error":"boom"}' });

      const out = await stdoutOfStart(afkHome, server.url);

      expect(occurrences(out, URL)).toBe(1);
      expect(out).toBe(`\n  ${URL}\n\n`);
    },
  );
});

describe("cmd_qr", () => {
  const QR_TEXT = "█████████\n█ ▄▀▄ ▄ █\n█████████\nhttp://example.test/s/abc123\n";

  it("prints the current session's QR code whether or not stdout is a terminal", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer((req) =>
      req.url.endsWith("/qr")
        ? { status: 200, body: QR_TEXT }
        : { status: 200, body: '{"status":"active","maxDurationSeconds":3600}' },
    );
    await writeFile(
      join(afkHome, "current"),
      `sessionId=abc123\ningestToken=tok-abc\nserver=${server.url}\n` +
        "dashboardUrl=http://example.test/s/abc123\n",
    );

    const { stdout, stderr, code } = await runBash("cmd_qr", { AFK_HOME: afkHome });

    expect(code, stderr).toBe(0);
    expect(stdout).toBe(QR_TEXT);
    expect(server.requests.map((req) => req.url)).toEqual([
      "/api/sessions/abc123",
      "/api/sessions/abc123/qr",
    ]);
  });

  it("fails with a clear message when there is no active session", async () => {
    const afkHome = await makeTempDir();

    const { stdout, stderr, code } = await runBash("cmd_qr", { AFK_HOME: afkHome });

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("no active session");
  });
});

/**
 * A run directory as `afk run` keeps it while the command runs: the captured stdout and
 * stderr, each as the chunk files `split` writes (one chunk here).
 */
async function makeRunDir(stdout: string, stderr: string): Promise<string> {
  const runDir = await makeTempDir();
  await writeFile(join(runDir, "stdout.aaaaaa"), stdout);
  await writeFile(join(runDir, "stderr.aaaaaa"), stderr);
  return runDir;
}

const numberedLines = (count: number) =>
  Array.from({ length: count }, (_, i) => `processing ${i + 1}/${count} items`);

describe("run_output_tail", () => {
  it("prints the last lines of stdout and stderr as JSON with escaping intact", async () => {
    const escape = "";
    const runDir = await makeRunDir(
      `plain\nback\\slash "quoted"\ttab\ncafé ☕ 日本\n${escape}[31mred${escape}[0m\r\nno newline at end`,
      "fatal: lost connection\n",
    );

    const { stdout, stderr } = await runBash("run_output_tail 3", { RUN_DIR: runDir });

    const parsed: unknown = JSON.parse(stdout);
    expect(RunOutputTail.safeParse(parsed).success, stderr).toBe(true);
    expect(parsed).toEqual({
      stdout: ["plain", 'back\\slash "quoted"\ttab', "café ☕ 日本", "red", "no newline at end"],
      stderr: ["fatal: lost connection"],
      truncated: false,
    });
  });

  it("keeps the last lines and marks truncated when a stream had more than were kept", async () => {
    const lines = numberedLines(RUN_TAIL_MAX_LINES + 5);
    const runDir = await makeRunDir(`${lines.join("\n")}\n`, "");

    const { stdout, stderr } = await runBash("run_output_tail 1", { RUN_DIR: runDir });

    expect(JSON.parse(stdout), stderr).toEqual({
      stdout: lines.slice(5),
      stderr: [],
      truncated: true,
    });
  });

  it("is not truncated when a stream has exactly the maximum lines", async () => {
    const lines = numberedLines(RUN_TAIL_MAX_LINES);
    const runDir = await makeRunDir("", `${lines.join("\n")}\n`);

    const { stdout, stderr } = await runBash("run_output_tail 1", { RUN_DIR: runDir });

    expect(JSON.parse(stdout), stderr).toEqual({ stdout: [], stderr: lines, truncated: false });
  });

  it("cuts each line to the maximum characters", async () => {
    const runDir = await makeRunDir(`${"x".repeat(RUN_TAIL_MAX_LINE_CHARS + 100)}\n`, "");

    const { stdout, stderr } = await runBash("run_output_tail 1", { RUN_DIR: runDir });

    expect(JSON.parse(stdout), stderr).toEqual({
      stdout: ["x".repeat(RUN_TAIL_MAX_LINE_CHARS)],
      stderr: [],
      truncated: false,
    });
  });

  it("prints nothing for exit code 0", async () => {
    const runDir = await makeRunDir("done\n", "warning: deprecated\n");

    const { stdout, stderr } = await runBash("run_output_tail 0", { RUN_DIR: runDir });

    expect(stdout, stderr).toBe("");
  });

  it("prints nothing when AFK_RUN_TAIL_LINES is 0, whatever the exit code", async () => {
    const runDir = await makeRunDir("done\n", "fatal: boom\n");

    const { stdout, stderr } = await runBash("run_output_tail 3", {
      RUN_DIR: runDir,
      AFK_RUN_TAIL_LINES: "0",
    });

    expect(stdout, stderr).toBe("");
  });

  it("keeps only AFK_RUN_TAIL_LINES lines when that is below the maximum", async () => {
    const runDir = await makeRunDir("one\ntwo\nthree\n", "");

    const { stdout, stderr } = await runBash("run_output_tail 3", {
      RUN_DIR: runDir,
      AFK_RUN_TAIL_LINES: "2",
    });

    expect(JSON.parse(stdout), stderr).toEqual({
      stdout: ["two", "three"],
      stderr: [],
      truncated: true,
    });
  });

  it("caps AFK_RUN_TAIL_LINES at the maximum the server accepts", async () => {
    const lines = numberedLines(RUN_TAIL_MAX_LINES + 10);
    const runDir = await makeRunDir(`${lines.join("\n")}\n`, "");

    const { stdout, stderr } = await runBash("run_output_tail 3", {
      RUN_DIR: runDir,
      AFK_RUN_TAIL_LINES: String(RUN_TAIL_MAX_LINES + 10),
    });

    expect(JSON.parse(stdout), stderr).toEqual({
      stdout: lines.slice(10),
      stderr: [],
      truncated: true,
    });
  });
});

describe("collect_run", () => {
  const runEnv = { RUN_STARTED: "1", RUN_COMMAND_JSON: "sh -c exit 3" };

  it("puts the tail it is given under output.tail on an exited frame", async () => {
    const runDir = await makeRunDir("processing 1/2 items\n", "fatal: boom\n");

    const { stdout, stderr } = await runBash('collect_run exited 3 "$(run_output_tail 3)"', {
      ...runEnv,
      RUN_DIR: runDir,
    });

    const parsed: unknown = JSON.parse(stdout);
    const result = RunCollectorData.safeParse(parsed);
    expect(result.success, JSON.stringify(result.success ? stderr : result.error.issues)).toBe(
      true,
    );
    expect(parsed).toMatchObject({
      state: "exited",
      exitCode: 3,
      output: {
        flavor: "volume",
        tail: { stdout: ["processing 1/2 items"], stderr: ["fatal: boom"], truncated: false },
      },
    });
  });

  it("emits no tail at all when given none", async () => {
    const runDir = await makeRunDir("processing 1/2 items\n", "");

    const { stdout, stderr } = await runBash('collect_run exited 0 "$(run_output_tail 0)"', {
      ...runEnv,
      RUN_DIR: runDir,
    });

    const parsed = RunCollectorData.parse(JSON.parse(stdout));
    expect(parsed.output, stderr).toEqual({ flavor: "volume", stdoutBytes: 21, stderrBytes: 0 });
  });
});

describe("cmd_run", () => {
  const SESSION_ID = "sess123";

  /** A stand-in server that accepts a session, every frame batch, and the end. */
  async function startAcceptingServer(): Promise<TestServer> {
    return startServer((req) => {
      if (req.url === "/api/sessions") {
        return {
          status: 201,
          body: `{"sessionId":"${SESSION_ID}","ingestToken":"tok","dashboardUrl":"http://example.test/s/${SESSION_ID}","maxDurationSeconds":3600}`,
        };
      }
      return { status: 200, body: '{"accepted":1,"duplicates":0,"latestSequence":{}}' };
    });
  }

  /** The `exited` run frame across every batch the server received. */
  function exitedRunFrame(server: TestServer): RunFrame | undefined {
    const frames = server.requests
      .filter((req) => req.url === `/api/sessions/${SESSION_ID}/frames`)
      .flatMap((req) => req.body.split("\n").filter((line) => line !== ""))
      .map((line) => Frame.parse(JSON.parse(line)));
    return frames.find(
      (frame): frame is RunFrame => frame.collector === "run" && frame.data.state === "exited",
    );
  }

  /** The names of whatever `afk run` left of the command's output in its run directory. */
  async function leftoverCaptures(afkHome: string): Promise<string[]> {
    const runsDir = join(afkHome, "sessions", SESSION_ID, "runs");
    const leftovers: string[] = [];
    for (const runId of await readdir(runsDir)) {
      for (const name of await readdir(join(runsDir, runId))) {
        if (name.startsWith("stdout") || name.startsWith("stderr")) {
          leftovers.push(name);
        }
      }
    }
    return leftovers;
  }

  /** The path of the wrapped command's stdout chunks, from inside the command (it knows AFK_HOME). */
  const STDOUT_CHUNKS_GLOB = '"$AFK_HOME"/sessions/*/runs/*/stdout.*';

  it.skipIf(process.platform !== "darwin")(
    "caps the captured output on disk, still counts every byte, and deletes the capture on exit",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startAcceptingServer();
      const chunkSizesFile = join(await makeTempDir(), "chunk-sizes");
      const capBytes = 4096;
      const outputBytes = 20 * 1024;
      // Prints 20 KB, then waits for a sampler tick or two to prune the chunks and lists
      // what is left; the listing is a best effort since the sampler may delete a chunk
      // between `stat` and its read.
      const command =
        `yes | head -c ${outputBytes}; sleep 2.5; ` +
        `stat -f %z ${STDOUT_CHUNKS_GLOB} > "$1" 2>/dev/null || true`;

      const { code, stderr } = await runBash(
        `cmd_run -- sh -c '${command}' sh "${chunkSizesFile}"`,
        {
          AFK_HOME: afkHome,
          AFK_SERVER: server.url,
          AFK_RUN_CAPTURE_MAX_BYTES: String(capBytes),
        },
      );

      expect(code, stderr).toBe(0);
      const chunkSizes = (await readFile(chunkSizesFile, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map(Number);
      expect(chunkSizes.length).toBeGreaterThan(0);
      expect(chunkSizes.length).toBeLessThanOrEqual(2);
      expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(capBytes);
      expect(exitedRunFrame(server)?.data.output).toMatchObject({
        stdoutBytes: outputBytes,
        stderrBytes: 0,
      });
      expect(await leftoverCaptures(afkHome)).toEqual([]);
    },
  );

  // Runs the real collectors for the session it owns, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "puts the command's last output on the final frame when it fails",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startAcceptingServer();

      const { code, stderr } = await runBash('cmd_run -- sh -c "echo out; echo err >&2; exit 3"', {
        AFK_HOME: afkHome,
        AFK_SERVER: server.url,
      });

      expect(code, stderr).toBe(3);
      expect(exitedRunFrame(server)?.data).toMatchObject({
        exitCode: 3,
        output: { tail: { stdout: ["out"], stderr: ["err"], truncated: false } },
      });
      // The tail was the last use of the captured output.
      expect(await leftoverCaptures(afkHome)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "passes the command's stdout and stderr through on their own descriptors, in order, and exits with its status",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startAcceptingServer();
      const command = "for i in 1 2 3; do echo out $i; echo err $i >&2; done; exit 7";

      const { code, stdout, stderr } = await runBash(`cmd_run -- sh -c '${command}'`, {
        AFK_HOME: afkHome,
        AFK_SERVER: server.url,
      });

      expect(code).toBe(7);
      // stdout is the dashboard URL block, then the command's lines exactly as written.
      expect(stdout).toMatch(/^\n {2}http:\/\/example\.test\/s\/sess123\n\nout 1\nout 2\nout 3\n$/);
      // stderr has the command's lines in order, and only afk's own lines around them.
      const commandLines = stderr.split("\n").filter((line) => line.startsWith("err "));
      expect(commandLines).toEqual(["err 1", "err 2", "err 3"]);
      const afkLines = stderr.split("\n").filter((line) => line !== "" && !line.startsWith("err "));
      expect(afkLines.every((line) => line.startsWith("afk: "))).toBe(true);
      expect(stderr).not.toContain("out ");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "runs the command with the caller's umask, not the client's private one",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startAcceptingServer();
      const { stdout: callerUmask } = await execFileAsync("/bin/bash", ["-c", "umask"]);

      const { code, stdout, stderr } = await runBash("cmd_run -- sh -c umask", {
        AFK_HOME: afkHome,
        AFK_SERVER: server.url,
      });

      expect(code, stderr).toBe(0);
      expect(stdout).toContain(callerUmask.trim());
      expect(stdout).not.toContain("0077");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "sends no output on the final frame when the command succeeds",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startAcceptingServer();

      const { code, stderr } = await runBash('cmd_run -- sh -c "echo out; echo err >&2"', {
        AFK_HOME: afkHome,
        AFK_SERVER: server.url,
      });

      expect(code, stderr).toBe(0);
      const final = exitedRunFrame(server);
      expect(final?.data.exitCode).toBe(0);
      expect(final?.data.output.tail).toBeUndefined();
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "sends no output for a failed command when AFK_RUN_TAIL_LINES is 0",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startAcceptingServer();

      // The printed word is spelled with a quote pair in the command line, so it can
      // only reach the server through the output tail, never through `command`.
      const { code, stderr } = await runBash("cmd_run -- sh -c \"echo se''cret; exit 2\"", {
        AFK_HOME: afkHome,
        AFK_SERVER: server.url,
        AFK_RUN_TAIL_LINES: "0",
      });

      expect(code, stderr).toBe(2);
      const final = exitedRunFrame(server);
      expect(final?.data.exitCode).toBe(2);
      expect(final?.data.output.tail).toBeUndefined();
      expect(server.requests.some((req) => req.body.includes("secret"))).toBe(false);
    },
  );
});

describe("cmd_run when the session is deleted on the server mid-command", () => {
  const created =
    '{"sessionId":"abc123","ingestToken":"tok-abc","dashboardUrl":"http://example.test/s/abc123","maxDurationSeconds":3600}';
  const accepted = '{"accepted":1,"duplicates":0,"latestSequence":{}}';
  const deleted = '{"error":"session deleted","details":{"reason":"deleted"}}';
  const DELETED_LINE = "afk: session abc123 was deleted on the server; telemetry stopped";
  /** Long enough for the deletion to land in the middle: a batch a second, deleted after the first. */
  const RUN_SECONDS = 4;
  const RUN_TIMEOUT_MS = 15_000;

  /** Accepts the session and its first batch, then has forgotten the session for good. */
  async function deletingServer(): Promise<TestServer> {
    let batches = 0;
    return startServer((req) => {
      if (req.url === "/api/sessions") {
        return { status: 201, body: created };
      }
      if (req.url.endsWith("/frames") && batches === 0) {
        batches += 1;
        return { status: 200, body: accepted };
      }
      return { status: 404, body: deleted };
    });
  }

  // Runs the real collectors for the session it owns, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "keeps the command running with its output flowing and its exit code, stops the telemetry, and never chains or ends",
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const afkHome = await makeTempDir();
      const server = await deletingServer();
      const command = `for i in 1 2 3 ${RUN_SECONDS}; do echo out $i; echo err $i >&2; sleep 1; done; exit 5`;

      const { code, stdout, stderr } = await runBash(
        `cmd_run -- sh -c '${command}'`,
        { AFK_HOME: afkHome, AFK_SERVER: server.url },
        RUN_TIMEOUT_MS,
      );

      expect(code).toBe(5);
      expect(stdout).toContain("out 1\nout 2\nout 3\nout 4\n");
      expect(stderr).toContain("err 1\n");
      expect(stderr).toContain("err 4\n");
      expect(stderr.split("\n").filter((line) => line === DELETED_LINE)).toHaveLength(1);
      expect(stderr).toContain("command exited with status 5");
      expect(stderr).not.toContain("Dashboard stays available");
      const urls = server.requests.map((req) => req.url);
      expect(urls.filter((url) => url === "/api/sessions")).toHaveLength(1);
      expect(urls.filter((url) => url.endsWith("/end"))).toEqual([]);
      // The batch that learned of the deletion was the last one sent.
      expect(urls.filter((url) => url.endsWith("/frames"))).toHaveLength(2);
      const sessionDir = join(afkHome, "sessions", "abc123");
      expect(await exists(join(sessionDir, "deleted"))).toBe(true);
      expect(await exists(join(sessionDir, "done"))).toBe(true);
      expect(await queueFiles(sessionDir)).toEqual([]);
      expect(await exists(join(afkHome, "current"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "stops a joiner's telemetry when the owner's session is deleted, and the command still runs to the end",
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const afkHome = await makeTempDir();
      let batches = 0;
      const server = await startServer((req) => {
        if (req.url === "/api/sessions/abc123" && batches === 0) {
          return { status: 200, body: '{"status":"active","maxDurationSeconds":3600}' };
        }
        if (req.url.endsWith("/frames") && batches === 0) {
          batches += 1;
          return { status: 200, body: accepted };
        }
        return { status: 404, body: deleted };
      });
      await mkdir(join(afkHome, "sessions", "abc123"), { recursive: true });
      await writeFile(
        join(afkHome, "current"),
        `sessionId=abc123\ningestToken=tok-abc\nserver=${server.url}\ndashboardUrl=http://example.test/s/abc123\n`,
      );
      // This test process stands in for the owner, alive for the whole run.
      await writeFile(join(afkHome, "owner.pid"), `${process.pid}\n`);

      const { code, stdout, stderr } = await runBash(
        `cmd_run -- sh -c 'for i in 1 2 3; do echo out $i; sleep 1; done'`,
        { AFK_HOME: afkHome, AFK_SERVER: server.url },
        RUN_TIMEOUT_MS,
      );

      expect(code, stderr).toBe(0);
      expect(stdout).toContain("out 1\nout 2\nout 3\n");
      expect(stderr).toContain("joining session abc123");
      expect(stderr.split("\n").filter((line) => line === DELETED_LINE)).toHaveLength(1);
      const urls = server.requests.map((req) => req.url);
      expect(urls.filter((url) => url === "/api/sessions")).toEqual([]);
      expect(urls.filter((url) => url.endsWith("/end"))).toEqual([]);
      expect(urls.filter((url) => url.endsWith("/frames"))).toHaveLength(2);
      // The owner's files are the owner's to remove.
      expect(await exists(join(afkHome, "current"))).toBe(true);
    },
  );
});

describe("afk start when the session is deleted on the server", () => {
  const created =
    '{"sessionId":"abc123","ingestToken":"tok-abc","dashboardUrl":"http://example.test/s/abc123","maxDurationSeconds":3600}';
  const accepted = '{"accepted":1,"duplicates":0,"latestSequence":{}}';
  const deleted = '{"error":"session deleted","details":{"reason":"deleted"}}';
  const EXIT_DEADLINE_MS = 10_000;

  // Runs the real collectors, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "exits 0 with the deleted line, without chaining, ending, or sending anything more",
    { timeout: 20_000 },
    async () => {
      const afkHome = await makeTempDir();
      let batches = 0;
      const server = await startServer((req) => {
        if (req.url === "/api/sessions") {
          return { status: 201, body: created };
        }
        if (req.url.endsWith("/frames") && batches === 0) {
          batches += 1;
          return { status: 200, body: accepted };
        }
        return { status: 404, body: deleted };
      });
      const owner = spawnAfk(["start", "--no-qr"], { AFK_HOME: afkHome, AFK_SERVER: server.url });

      await waitUntil(
        "the owner to exit on its own",
        () => owner.child.exitCode !== null,
        EXIT_DEADLINE_MS,
      );
      const exitCode = await owner.exited;

      expect(exitCode, owner.stderr()).toBe(0);
      expect(owner.stderr()).toContain(
        "afk: session abc123 was deleted on the server; telemetry stopped",
      );
      expect(owner.stderr()).not.toContain("ending session");
      expect(server.requests.map((req) => req.url)).toEqual([
        "/api/sessions",
        "/api/sessions/abc123/frames",
        "/api/sessions/abc123/frames",
      ]);
      expect(await exists(join(afkHome, "current"))).toBe(false);
      expect(await exists(join(afkHome, "sessions", "abc123", "done"))).toBe(true);
      expect(await queueFiles(join(afkHome, "sessions", "abc123"))).toEqual([]);
    },
  );
});

describe("afk delete", () => {
  const deletedBody = '{"sessionId":"abc123","frames":42}';

  async function writeCurrent(afkHome: string, serverUrl: string): Promise<void> {
    await writeFile(
      join(afkHome, "current"),
      `sessionId=abc123\ningestToken=tok-abc\nserver=${serverUrl}\ndashboardUrl=http://example.test/s/abc123\n`,
    );
  }

  it("deletes the current session with its token and reports the frame count", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: deletedBody }));
    await writeCurrent(afkHome, server.url);

    const { code, stderr } = await runAfk(["delete"], { AFK_HOME: afkHome });

    expect(code, stderr).toBe(0);
    expect(server.requests).toMatchObject([
      {
        method: "DELETE",
        url: "/api/sessions/abc123",
        headers: { authorization: "Bearer tok-abc" },
      },
    ]);
    expect(stderr).toContain(`afk: deleted session abc123 from ${server.url} (42 frames)`);
  });

  it("deletes the named session with the token its own record holds", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: deletedBody }));
    const sessionDir = join(afkHome, "sessions", "abc123");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session.json"),
      `{"sessionId":"abc123","ingestToken":"tok-abc","server":"${server.url}","dashboardUrl":"http://example.test/s/abc123"}\n`,
    );

    const { code, stderr } = await runAfk(["delete", "abc123"], {
      AFK_HOME: afkHome,
      AFK_SERVER: "http://127.0.0.1:1",
    });

    expect(code, stderr).toBe(0);
    expect(server.requests).toMatchObject([
      {
        method: "DELETE",
        url: "/api/sessions/abc123",
        headers: { authorization: "Bearer tok-abc" },
      },
    ]);
  });

  it("deletes a session this machine has no record of without a bearer, since the id is enough", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: deletedBody }));

    const { code, stderr } = await runAfk(["delete", "abc123"], {
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code, stderr).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("exits 1 naming the session when there is nothing to delete on the server", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 404, body: '{"error":"unknown session"}' }));

    const { code, stderr } = await runAfk(["delete", "abc123"], {
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code).toBe(1);
    expect(stderr).toContain(`session abc123 is not on ${server.url} (unknown session)`);
  });

  it("reports the server's refusal to delete the demo session and exits 1", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({
      status: 403,
      body: '{"error":"the demo session cannot be deleted"}',
    }));

    const { code, stderr } = await runAfk(["delete", "demo"], {
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code).toBe(1);
    expect(stderr).toContain(
      `${server.url} refused to delete session demo (HTTP 403): the demo session cannot be deleted`,
    );
  });

  it("exits 1 with a message when there is no current session and no id", async () => {
    const afkHome = await makeTempDir();

    const { code, stderr } = await runAfk(["delete"], { AFK_HOME: afkHome });

    expect(code).toBe(1);
    expect(stderr).toContain(
      "no session running on this machine; name one: afk delete <session-id>",
    );
  });

  it("exits 1 with curl's reason when the server cannot be reached", async () => {
    const afkHome = await makeTempDir();

    const { code, stderr } = await runAfk(["delete", "abc123"], {
      AFK_HOME: afkHome,
      AFK_SERVER: "http://127.0.0.1:1",
    });

    expect(code).toBe(1);
    expect(stderr).toContain("could not reach http://127.0.0.1:1");
  });
});

describe("cmd_run owning a session that reaches its cap", () => {
  const accepted = '{"accepted":1,"duplicates":0,"latestSequence":{}}';
  /** The cap of the first session: the client chains a quarter of it (2 s) before. */
  const CAP_SECONDS = 4;
  /** The successor's cap, long enough that it is not chained from in turn during the test. */
  const SUCCESSOR_CAP_SECONDS = 3600;
  /** Long enough for the command to outlive the chain, so its last frames land in the successor. */
  const RUN_SECONDS = 4;
  const RUN_TIMEOUT_MS = 15_000;

  /** The run frames a session received, in the order they arrived, with their sequence. */
  function runFrames(server: TestServer, sessionId: string): RunFrame[] {
    return server.requests
      .filter((req) => req.url === `/api/sessions/${sessionId}/frames`)
      .flatMap((req) => req.body.split("\n").filter((line) => line !== ""))
      .map((line) => Frame.parse(JSON.parse(line)))
      .filter((frame): frame is RunFrame => frame.collector === "run");
  }

  /** The sequences a server that de-duplicates per stream would keep, in arrival order. */
  function dedupeBySequence(frames: RunFrame[]): number[] {
    const seen = new Set<number>();
    const kept: number[] = [];
    for (const frame of frames) {
      if (!seen.has(frame.sequence)) {
        seen.add(frame.sequence);
        kept.push(frame.sequence);
      }
    }
    return kept;
  }

  // Regression: the owning run's sampler stopped at the cap and its remaining frames
  // stayed in the old session's queue. Runs the real collectors, so macOS only.
  it.skipIf(process.platform !== "darwin")(
    "chains to a successor before the cap and sends the rest of the run there, final frame included, with its sequences continuing",
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const afkHome = await makeTempDir();
      let creates = 0;
      const server = await startServer((req) => {
        if (req.url === "/api/sessions") {
          creates += 1;
          const id = creates === 1 ? "first" : "second";
          const cap = creates === 1 ? CAP_SECONDS : SUCCESSOR_CAP_SECONDS;
          return {
            status: 201,
            body: `{"sessionId":"${id}","ingestToken":"tok-${id}","dashboardUrl":"http://example.test/s/${id}","maxDurationSeconds":${cap}}`,
          };
        }
        // The server ends the first session the moment its successor exists.
        if (req.url.startsWith("/api/sessions/first/") && creates > 1) {
          return { status: 410, body: '{"error":"session ended"}' };
        }
        return { status: 200, body: accepted };
      });

      const { code, stderr } = await runBash(
        `cmd_run -- sleep ${RUN_SECONDS}`,
        { AFK_HOME: afkHome, AFK_SERVER: server.url },
        RUN_TIMEOUT_MS,
      );

      expect(code, stderr).toBe(0);
      const creations = server.requests.filter((req) => req.url === "/api/sessions");
      expect(creations.map((req) => req.headers.authorization)).toEqual([
        undefined,
        "Bearer tok-first",
      ]);
      expect(JSON.parse(creations[1]!.body)).toMatchObject({ previousSessionId: "first" });
      expect(stderr).toContain(
        `session first reached its ${CAP_SECONDS}s cap; continuing in session second`,
      );
      // The run stream spans both sessions and keeps counting; its exit lands in the successor.
      const inFirst = runFrames(server, "first");
      const inSecond = runFrames(server, "second");
      expect(inFirst.length).toBeGreaterThan(0);
      expect(inSecond.at(-1)?.data).toMatchObject({ state: "exited", exitCode: 0 });
      expect(new Set([...inFirst, ...inSecond].map((frame) => frame.stream)).size).toBe(1);
      // Delivery is at least once: the chain kills the sender's in-flight request, so a
      // batch the stub already recorded can be sent again (the real server drops the
      // repeat by sequence; this stub records everything). Judge what the server keeps.
      const sequences = dedupeBySequence([...inFirst, ...inSecond]);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(inSecond[0]!.sequence).toBeGreaterThan(inFirst.at(-1)!.sequence);
      // The successor is the session the run ends; the first was ended by the chain.
      const ends = server.requests.filter((req) => req.url.endsWith("/end")).map((req) => req.url);
      expect(ends).toEqual(["/api/sessions/second/end"]);
      expect(await exists(join(afkHome, "current"))).toBe(false);
      expect(await exists(join(afkHome, "sessions", "first", "done"))).toBe(true);
      expect(await queueFiles(join(afkHome, "sessions", "first"))).toEqual([]);
      expect(await queueFiles(join(afkHome, "sessions", "second"))).toEqual([]);
    },
  );
});

describe("version_lt", () => {
  it.each([
    ["0.2.0", "0.2.0", "no"],
    ["0.2.0", "0.2.1", "yes"],
    ["0.2.0", "0.3.0", "yes"],
    ["0.2.0", "1.0.0", "yes"],
    ["0.3.0", "0.2.0", "no"],
    ["0.2.1", "0.2.0", "no"],
    ["1.0.0", "0.9.9", "no"],
  ])("%s older than %s: %s", async (a, b, expected) => {
    const { stdout, stderr } = await runBash(
      `if version_lt "${a}" "${b}"; then echo yes; else echo no; fi`,
    );

    expect(stdout.trim(), stderr).toBe(expected);
  });

  it("compares parts numerically, so 0.10.0 is newer than 0.9.0", async () => {
    const { stdout } = await runBash(
      'if version_lt "0.9.0" "0.10.0"; then echo yes; else echo no; fi; ' +
        'if version_lt "0.10.0" "0.9.0"; then echo yes; else echo no; fi',
    );

    expect(stdout).toBe("yes\nno\n");
  });

  it("ignores a pre-release or build suffix", async () => {
    const { stdout } = await runBash(
      'if version_lt "0.2.0" "0.2.0-beta.1"; then echo yes; else echo no; fi; ' +
        'if version_lt "0.2.0-rc.1+abc" "0.2.1"; then echo yes; else echo no; fi',
    );

    expect(stdout).toBe("no\nyes\n");
  });
});

describe("json_get_object", () => {
  const VERSION_BODY =
    '{"server":{"version":"0.1.0","commit":null,"builtAt":null},"web":{"version":"0.1.0","commit":"abc"},"client":{"version":"0.3.0"},"protocolVersion":1}';

  it("returns one top-level object so a key that recurs elsewhere can be read from it", async () => {
    const { stdout } = await runBash(
      `json_get_object '${VERSION_BODY}' client; echo; ` +
        `json_get_string "$(json_get_object '${VERSION_BODY}' client)" version; echo`,
    );

    expect(stdout).toBe('{"version":"0.3.0"}\n0.3.0\n');
  });

  it("returns empty when the key is null or missing", async () => {
    const { stdout } = await runBash(
      `json_get_object '{"server":{"version":"0.1.0"},"client":null}' client; echo "[$?]"`,
    );

    expect(stdout).toBe("[0]\n");
  });
});

/** The version the tests give the running copy, so the cases do not move with each release. */
const THIS_VERSION = "0.2.0";
const NEWER_VERSION = "0.3.0";

/** A create response carrying (or not) the version of the client the server serves. */
function createdWithLatest(latestClientVersion?: string): string {
  const latest =
    latestClientVersion === undefined ? "" : `,"latestClientVersion":"${latestClientVersion}"`;
  return `{"sessionId":"sess123","ingestToken":"tok","dashboardUrl":"http://example.test/s/sess123","maxDurationSeconds":3600${latest}}`;
}

/**
 * What the stub server serves at /install: a POSIX sh installer that installs a copy
 * of the newer client where the real one would (`AFK_INSTALL_DIR`), then exits as told.
 */
function stubInstaller(exitCode = 0): string {
  return [
    "#!/bin/sh",
    'mkdir -p "$AFK_INSTALL_DIR"',
    `printf '#!/bin/bash\\nAFK_VERSION="${NEWER_VERSION}"\\n' > "$AFK_INSTALL_DIR/afk"`,
    'echo "stub installer ran in $AFK_INSTALL_DIR"',
    `exit ${exitCode}`,
    "",
  ].join("\n");
}

/** A server that creates a session saying it serves `latest`, serves `installer` at /install, and accepts the rest. */
function startUpdateServer(latest: string | undefined, installer = stubInstaller()) {
  return startServer((req) => {
    if (req.url === "/api/sessions") {
      return { status: 201, body: createdWithLatest(latest) };
    }
    if (req.url === "/install") {
      return { status: 200, body: installer };
    }
    return { status: 200, body: '{"accepted":1,"duplicates":0,"latestSequence":{}}' };
  });
}

describe("check_client_update", () => {
  const hostEnv = {
    HOST_NAME: "test-host",
    HOST_PLATFORM: "darwin",
    HOST_OS_VERSION: "26.0",
    HOST_CPU_COUNT: "8",
    HOST_MEMORY_BYTES: "17179869184",
  };
  const NOTICE = `afk ${NEWER_VERSION} is available (this is ${THIS_VERSION})`;
  const QUESTION = "update now? [y/N]";
  /** The test process has no tty; a snippet that wants the prompt path says so. */
  const AT_A_TERMINAL = "can_prompt() { return 0; }";

  /** Sources the client as version THIS_VERSION, creates a session, then runs `check` with `stdin` as its input. */
  async function checkAfterCreate(
    afkHome: string,
    serverUrl: string,
    check: string,
    stdin = "",
    env: NodeJS.ProcessEnv = {},
  ): Promise<BashResult> {
    return runBash(
      [
        `AFK_VERSION=${THIS_VERSION}`,
        "create_session",
        `${check} <<< "${stdin}"; printf 'RC=%d\\n' "$?"`,
      ].join("\n"),
      { ...hostEnv, AFK_HOME: afkHome, AFK_SERVER: serverUrl, ...env },
    );
  }

  it("says a newer client is available, with the manual update command, and returns 0", async () => {
    const afkHome = await makeTempDir();
    const server = await startUpdateServer(NEWER_VERSION);

    const { stdout, stderr } = await checkAfterCreate(afkHome, server.url, "check_client_update");

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "0" });
    expect(stderr).toContain(NOTICE);
    expect(stderr).toContain(`Update with: curl -fsSL ${server.url}/install | sh`);
    expect(stderr).not.toContain(QUESTION);
  });

  it.each([
    ["the same version", THIS_VERSION],
    ["an older version", "0.1.9"],
    ["no version at all (an older server)", undefined],
  ])("says nothing when the server serves %s", async (_case, latest) => {
    const afkHome = await makeTempDir();
    const server = await startUpdateServer(latest);

    const { stdout, stderr } = await checkAfterCreate(
      afkHome,
      server.url,
      `${AT_A_TERMINAL}\ncheck_client_update prompt`,
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "0" });
    expect(stderr).not.toContain("is available");
    expect(stderr).not.toContain(QUESTION);
  });

  it("does not ask when stdin and stderr are not terminals", async () => {
    const afkHome = await makeTempDir();
    const server = await startUpdateServer(NEWER_VERSION);

    const { stdout, stderr } = await checkAfterCreate(
      afkHome,
      server.url,
      "check_client_update prompt",
      "y",
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "0" });
    expect(stderr).toContain(NOTICE);
    expect(stderr).not.toContain(QUESTION);
    expect(server.requests.map((req) => req.url)).not.toContain("/install");
  });

  it("does not ask with AFK_NO_UPDATE_PROMPT=1, even on a terminal", async () => {
    const afkHome = await makeTempDir();
    const server = await startUpdateServer(NEWER_VERSION);

    const { stdout, stderr } = await checkAfterCreate(
      afkHome,
      server.url,
      `${AT_A_TERMINAL}\ncheck_client_update prompt`,
      "y",
      { AFK_NO_UPDATE_PROMPT: "1" },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "0" });
    expect(stderr).toContain(NOTICE);
    expect(stderr).not.toContain(QUESTION);
    expect(server.requests.map((req) => req.url)).not.toContain("/install");
  });

  it("runs the server's installer into AFK_INSTALL_DIR on y and says the new copy takes effect next start", async () => {
    const afkHome = await makeTempDir();
    const installDir = join(await makeTempDir(), "bin");
    const server = await startUpdateServer(NEWER_VERSION);

    const { stdout, stderr } = await checkAfterCreate(
      afkHome,
      server.url,
      `${AT_A_TERMINAL}\ncheck_client_update prompt`,
      "y",
      { AFK_INSTALL_DIR: installDir },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "0" });
    expect(stderr).toContain(QUESTION);
    expect(server.requests.map((req) => req.url)).toContain("/install");
    expect(await readFile(join(installDir, "afk"), "utf8")).toContain(
      `AFK_VERSION="${NEWER_VERSION}"`,
    );
    // The installer's own output lands on stderr, never on stdout with the dashboard URL.
    expect(stderr).toContain(`stub installer ran in ${installDir}`);
    expect(stderr).toContain(
      `installed afk ${NEWER_VERSION} at ${installDir}/afk; it takes effect on the next afk start (this session keeps running ${THIS_VERSION})`,
    );
  });

  it("carries on without installing on n", async () => {
    const afkHome = await makeTempDir();
    const server = await startUpdateServer(NEWER_VERSION);

    const { stdout, stderr } = await checkAfterCreate(
      afkHome,
      server.url,
      `${AT_A_TERMINAL}\ncheck_client_update prompt`,
      "n",
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "0" });
    expect(stderr).toContain(QUESTION);
    expect(stderr).toContain("not updating (run 'afk update' any time)");
    expect(server.requests.map((req) => req.url)).not.toContain("/install");
  });

  it("takes no answer within the timeout as no", async () => {
    const afkHome = await makeTempDir();
    const server = await startUpdateServer(NEWER_VERSION);

    // stdin stays open with nothing on it for longer than the (shortened) timeout.
    const { stdout, stderr } = await runBash(
      [
        `AFK_VERSION=${THIS_VERSION}`,
        AT_A_TERMINAL,
        "UPDATE_PROMPT_TIMEOUT_SECONDS=1",
        "create_session",
        "check_client_update prompt < <(sleep 3); printf 'RC=%d\\n' \"$?\"",
      ].join("\n"),
      { ...hostEnv, AFK_HOME: afkHome, AFK_SERVER: server.url },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "0" });
    expect(stderr).toContain(QUESTION);
    expect(stderr).toContain("not updating");
    expect(server.requests.map((req) => req.url)).not.toContain("/install");
  });

  it("logs a failed install and returns 0 so the session carries on", async () => {
    const afkHome = await makeTempDir();
    const installDir = join(await makeTempDir(), "bin");
    const server = await startUpdateServer(NEWER_VERSION, stubInstaller(1));

    const { stdout, stderr } = await checkAfterCreate(
      afkHome,
      server.url,
      `${AT_A_TERMINAL}\ncheck_client_update prompt`,
      "y",
      { AFK_INSTALL_DIR: installDir },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "0" });
    expect(stderr).toContain(`update failed; this session carries on with afk ${THIS_VERSION}`);
  });

  it("logs a failed download and returns 0 without running anything", async () => {
    const afkHome = await makeTempDir();
    const installDir = join(await makeTempDir(), "bin");
    const server = await startServer((req) => {
      if (req.url === "/api/sessions") {
        return { status: 201, body: createdWithLatest(NEWER_VERSION) };
      }
      return { status: 404, body: "not here" };
    });

    const { stdout, stderr } = await checkAfterCreate(
      afkHome,
      server.url,
      `${AT_A_TERMINAL}\ncheck_client_update prompt`,
      "y",
      { AFK_INSTALL_DIR: installDir },
    );

    expect(parseKeyValueLines(stdout), stderr).toEqual({ RC: "0" });
    expect(stderr).toContain(`could not download ${server.url}/install`);
    expect(stderr).toContain("update failed");
    expect(await exists(join(installDir, "afk"))).toBe(false);
  });
});

describe("afk start with a newer client on the server", () => {
  const AT_A_TERMINAL = "can_prompt() { return 0; }";

  /** The update server, plus a marker file once the first frame batch arrives (the session is under way). */
  function startFramesMarkingServer(afkHome: string): Promise<TestServer> {
    return startServer(async (req) => {
      if (req.url === "/api/sessions") {
        return { status: 201, body: createdWithLatest(NEWER_VERSION) };
      }
      if (req.url === "/api/sessions/sess123/frames") {
        await writeFile(join(afkHome, "frames-seen"), "");
      }
      return { status: 200, body: '{"accepted":1,"duplicates":0,"latestSequence":{}}' };
    });
  }

  it.skipIf(process.platform !== "darwin")(
    "says so, asks, and carries on with the session when the answer is n",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startFramesMarkingServer(afkHome);

      const { stdout, stderr } = await runBash(
        [
          `AFK_VERSION=${THIS_VERSION}`,
          AT_A_TERMINAL,
          `main start --no-qr <<< n > "$AFK_HOME/out.txt" 2> "$AFK_HOME/err.txt" & START=$!`,
          'for _ in $(seq 1 100); do [ -e "$AFK_HOME/frames-seen" ] && break; sleep 0.1; done',
          'kill -TERM "$START"; wait "$START"; printf "START_RC=%d\\n" "$?"',
        ].join("\n"),
        { AFK_HOME: afkHome, AFK_SERVER: server.url },
        15_000,
      );

      expect(parseKeyValueLines(stdout), stderr).toEqual({ START_RC: "0" });
      const err = await readFile(join(afkHome, "err.txt"), "utf8");
      expect(err).toContain(`afk ${NEWER_VERSION} is available (this is ${THIS_VERSION})`);
      expect(err).toContain("update now? [y/N]");
      expect(err).toContain("not updating");
      expect(err).toContain("session sess123 started");
      expect(err).toContain("session ended");
      expect(server.requests.map((req) => req.url)).not.toContain("/install");
      expect(server.requests.map((req) => req.url)).toContain("/api/sessions/sess123/end");
    },
  );
});

describe("afk run with a newer client on the server", () => {
  const AT_A_TERMINAL = "can_prompt() { return 0; }";

  it.skipIf(process.platform !== "darwin")(
    "says so but never asks, since the command is about to get stdin",
    async () => {
      const afkHome = await makeTempDir();
      const server = await startUpdateServer(NEWER_VERSION);

      const { stdout, stderr, code } = await runBash(
        [`AFK_VERSION=${THIS_VERSION}`, AT_A_TERMINAL, "cmd_run -- cat <<< y"].join("\n"),
        { AFK_HOME: afkHome, AFK_SERVER: server.url },
        15_000,
      );

      expect(code, stderr).toBe(0);
      // The wrapped command got the whole of stdin, not the update question (the
      // dashboard URL precedes its output on stdout).
      expect(stdout).toMatch(/\ny\n$/);
      expect(stderr).toContain(`afk ${NEWER_VERSION} is available (this is ${THIS_VERSION})`);
      expect(stderr).not.toContain("update now?");
      expect(server.requests.map((req) => req.url)).not.toContain("/install");
    },
  );
});

describe("afk update", () => {
  /** A copy of the client in its own directory, the way an installed one lives, so $0 is not the repo's. */
  async function installedCopy(): Promise<{ dir: string; path: string; version: string }> {
    const dir = await makeTempDir();
    const path = join(dir, "afk");
    await copyFile(AFK_SCRIPT, path);
    const version = /^AFK_VERSION="([^"]+)"$/m.exec(await readFile(path, "utf8"))![1]!;
    return { dir, path, version };
  }

  /** Runs the copy at `path` the way a user would. */
  async function runCopy(
    path: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<BashResult> {
    try {
      const { stdout, stderr } = await execFileAsync("/bin/bash", [path, ...args], {
        env: { ...process.env, AFK_SOURCED: "0", ...env },
        timeout: 5000,
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        code: failure.code ?? 1,
      };
    }
  }

  it("runs the server's installer over this copy and prints the versions before and after", async () => {
    const copy = await installedCopy();
    const server = await startUpdateServer(undefined);

    const { stderr, code } = await runCopy(copy.path, ["update"], { AFK_SERVER: server.url });

    expect(code, stderr).toBe(0);
    expect(stderr).toContain(`this is afk ${copy.version}; updating from ${server.url}`);
    expect(stderr).toContain(`afk ${copy.version} -> ${NEWER_VERSION} at ${copy.path}`);
    expect(server.requests.map((req) => req.url)).toEqual(["/install"]);
    expect(await readFile(copy.path, "utf8")).toContain(`AFK_VERSION="${NEWER_VERSION}"`);
  });

  it("installs into AFK_INSTALL_DIR instead when it is set", async () => {
    const copy = await installedCopy();
    const installDir = join(await makeTempDir(), "elsewhere");
    const server = await startUpdateServer(undefined);

    const { stderr, code } = await runCopy(copy.path, ["update"], {
      AFK_SERVER: server.url,
      AFK_INSTALL_DIR: installDir,
    });

    expect(code, stderr).toBe(0);
    expect(stderr).toContain(`at ${installDir}/afk`);
    expect(await readFile(join(installDir, "afk"), "utf8")).toContain(
      `AFK_VERSION="${NEWER_VERSION}"`,
    );
    expect(await readFile(copy.path, "utf8")).toContain(`AFK_VERSION="${copy.version}"`);
  });

  it("exits 1 and leaves this copy alone when the installer fails", async () => {
    const copy = await installedCopy();
    const server = await startServer(() => ({ status: 200, body: "#!/bin/sh\nexit 1\n" }));

    const { stderr, code } = await runCopy(copy.path, ["update"], { AFK_SERVER: server.url });

    expect(code).toBe(1);
    expect(stderr).toContain("update failed; nothing was changed");
    expect(await readFile(copy.path, "utf8")).toContain(`AFK_VERSION="${copy.version}"`);
  });
});

describe("afk version", () => {
  const versionBody = (client: string) =>
    `{"server":{"version":"0.1.0","commit":null,"builtAt":null},"web":null,"client":${client},"protocolVersion":1}`;

  it("prints this copy's version", async () => {
    const { stdout, stderr, code } = await runAfk(["version"]);

    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(/^afk \d+\.\d+\.\d+\n$/);
  });

  it("--check prints the version the server serves and how to update when this copy is behind", async () => {
    const server = await startServer(() => ({
      status: 200,
      body: versionBody('{"version":"99.0.0"}'),
    }));

    const { stdout, stderr, code } = await runAfk(["version", "--check"], {
      AFK_SERVER: server.url,
    });

    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(
      new RegExp(`^afk \\d+\\.\\d+\\.\\d+\\nlatest 99\\.0\\.0 \\(${server.url}\\)\\n$`),
    );
    expect(stderr).toContain("update with: afk update");
    expect(server.requests).toEqual([
      expect.objectContaining({ method: "GET", url: "/api/version" }),
    ]);
  });

  it("--check gives no update hint when this copy is the version the server serves", async () => {
    const { stdout: local } = await runAfk(["version"]);
    const current = local.trim().replace(/^afk /, "");
    const server = await startServer(() => ({
      status: 200,
      body: versionBody(`{"version":"${current}"}`),
    }));

    const { stdout, stderr, code } = await runAfk(["version", "--check"], {
      AFK_SERVER: server.url,
    });

    expect(code, stderr).toBe(0);
    expect(stdout).toBe(`afk ${current}\nlatest ${current} (${server.url})\n`);
    expect(stderr).not.toContain("afk update");
  });

  it("--check exits 1 when the server does not say which client it serves", async () => {
    const server = await startServer(() => ({ status: 200, body: versionBody("null") }));

    const { stdout, stderr, code } = await runAfk(["version", "--check"], {
      AFK_SERVER: server.url,
    });

    expect(code).toBe(1);
    expect(stdout).toMatch(/^afk \d+\.\d+\.\d+\n$/);
    expect(stderr).toContain(`${server.url} does not say which client it serves`);
  });

  it("--check exits 1 with curl's reason when the server cannot be reached", async () => {
    const server = await startServer(() => ({ status: 200 }));
    const url = server.url;
    await server.close();

    const { stderr, code } = await runAfk(["version", "--check"], { AFK_SERVER: url });

    expect(code).toBe(1);
    expect(stderr).toContain(`could not reach ${url}`);
  });
});
