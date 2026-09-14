import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
async function runBash(snippet: string, env: NodeJS.ProcessEnv = {}): Promise<BashResult> {
  const script = `source "${AFK_SCRIPT}"\n${snippet}`;
  try {
    const { stdout, stderr } = await execFileAsync("/bin/bash", ["-c", script], {
      env: { ...process.env, AFK_SOURCED: "1", ...env },
      timeout: 5000,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
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

/** A local HTTP server that records every request and answers each with `respond`'s result. */
async function startServer(
  respond: (req: RecordedRequest) => { status: number; body?: string },
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
      const { status, body } = respond(recorded);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body ?? "{}");
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

      const { code, stderr } = await runBash(
        "gather_host_info\nPROCESSES_INTERVAL_SECONDS=3\nsample_once; sample_once; sample_once; sample_once",
        { SESSION_DIR: sessionDir },
      );

      expect(code, stderr).toBe(0);
      const content = await readFile(join(sessionDir, "current.ndjson"), "utf8");
      const frames = content
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => Frame.parse(JSON.parse(line)));
      expect(frames.map((frame) => `${frame.stream}#${frame.sequence}`)).toEqual([
        "system#1",
        "processes#1",
        "system#2",
        "system#3",
        "system#4",
        "processes#2",
      ]);
    },
  );
});

describe("emit_frame", () => {
  it("writes one compact JSON line that validates as a Frame", async () => {
    const sessionDir = await makeTempDir();
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
    const content = await readFile(join(sessionDir, "current.ndjson"), "utf8");
    const lines = content.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0]!);
    const result = Frame.safeParse(parsed);
    expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
    expect(parsed).toMatchObject({ stream: "system", collector: "system", sequence: 3, data });
  });
});

describe("rotate_current", () => {
  it("moves a non-empty current.ndjson into queue/ with a zero-padded name", async () => {
    const sessionDir = await makeTempDir();
    await mkdir(join(sessionDir, "queue"));
    await writeFile(join(sessionDir, "current.ndjson"), "line1\n");

    const { stdout, stderr } = await runBash('rotate_current; printf "RC=%d" "$?"', {
      SESSION_DIR: sessionDir,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "0" });
    await expect(readFile(join(sessionDir, "current.ndjson"), "utf8")).rejects.toThrow();
    const rotated = await readFile(join(sessionDir, "queue", "0000000001.ndjson"), "utf8");
    expect(rotated).toBe("line1\n");
  });

  it("does nothing when current.ndjson is empty", async () => {
    const sessionDir = await makeTempDir();
    await mkdir(join(sessionDir, "queue"));
    await writeFile(join(sessionDir, "current.ndjson"), "");

    const { stdout, stderr } = await runBash('rotate_current; printf "RC=%d" "$?"', {
      SESSION_DIR: sessionDir,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "0" });
    const remaining = await readFile(join(sessionDir, "current.ndjson"), "utf8");
    expect(remaining).toBe("");
    expect(await exists(join(sessionDir, "queue", "0000000001.ndjson"))).toBe(false);
  });

  it("does nothing when current.ndjson is missing", async () => {
    const sessionDir = await makeTempDir();
    await mkdir(join(sessionDir, "queue"));

    const { stdout, stderr } = await runBash('rotate_current; printf "RC=%d" "$?"', {
      SESSION_DIR: sessionDir,
    });

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "0" });
    expect(await exists(join(sessionDir, "queue", "0000000001.ndjson"))).toBe(false);
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

  it("returns 2, keeps the queued files, and prints the upgrade hint on a 426 response", async () => {
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

    expect(parseKeyValueLines(stdout), stderr).toMatchObject({ RC: "2" });
    expect(stderr).toContain("below the minimum 0.3.0");
    expect(stderr).toContain("client 0.3.0 and protocol 2 or newer");
    expect(stderr).toContain("curl -fsSL");
    const kept = await readFile(join(sessionDir, "queue", "0000000001.ndjson"), "utf8");
    expect(kept).toBe("AAA\n");
    expect(await exists(join(sessionDir, "rejected"))).toBe(false);
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
    });

    const current = await readFile(join(afkHome, "current"), "utf8");
    expect(current).toBe(
      "sessionId=D3FzMqK8qOLVva9LoHF9uc\n" +
        "ingestToken=tok-abc\n" +
        `server=${server.url}\n` +
        "dashboardUrl=http://example.test/s/D3FzMqK8qOLVva9LoHF9uc\n",
    );
    const queueStat = await stat(join(afkHome, "sessions", "D3FzMqK8qOLVva9LoHF9uc", "queue"));
    expect(queueStat.isDirectory()).toBe(true);
  });

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
    expect(stderr).toContain("curl -fsSL");
    expect(await exists(join(afkHome, "current"))).toBe(false);
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
});

/** A run directory as `afk run` leaves it: the captured stdout and stderr of the command. */
async function makeRunDir(stdout: string, stderr: string): Promise<string> {
  const runDir = await makeTempDir();
  await writeFile(join(runDir, "stdout"), stdout);
  await writeFile(join(runDir, "stderr"), stderr);
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
