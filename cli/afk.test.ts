import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    });
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

  it("dies naming curl's reason when the server is unreachable", async () => {
    const afkHome = await makeTempDir();

    const { code, stderr } = await runBash("create_session", {
      ...hostEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: "http://127.0.0.1:1",
    });

    expect(code).toBe(1);
    expect(stderr).toMatch(/could not reach http:\/\/127\.0\.0\.1:1: .*connect/i);
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

describe("print_qr", () => {
  const sessionEnv = { SESSION_ID: "sess123", INGEST_TOKEN: "tok-abc", AFK_VERSION: "0.2.0" };
  /** What the server's text render looks like: half-block lines, then the URL. */
  const QR_TEXT = "█████████\n█▀▀▀▀▀▀▀█\n█ ▄▀▄ ▄ █\n█████████\nhttp://example.test/s/sess123\n";
  /** The test process has no tty, so a snippet that wants the terminal path says so. */
  const ON_A_TERMINAL = "stdout_is_terminal() { return 0; }";

  it("prints the QR the server returns, fetched with the bearer token and the client header", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: QR_TEXT }));

    const { stdout, stderr, code } = await runBash(`${ON_A_TERMINAL}\nprint_qr`, {
      ...sessionEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code, stderr).toBe(0);
    expect(stdout).toBe(QR_TEXT);
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

  it("prints nothing and asks the server for nothing with AFK_NO_QR=1", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: QR_TEXT }));

    const { stdout, code } = await runBash(`${ON_A_TERMINAL}\nprint_qr`, {
      ...sessionEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
      AFK_NO_QR: "1",
    });

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(server.requests).toHaveLength(0);
  });

  it("prints nothing when stdout is not a terminal", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 200, body: QR_TEXT }));

    const { stdout, code } = await runBash("print_qr", {
      ...sessionEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(server.requests).toHaveLength(0);
  });

  it("prints nothing and still succeeds when the server answers with an error", async () => {
    const afkHome = await makeTempDir();
    const server = await startServer(() => ({ status: 500, body: '{"error":"boom"}' }));

    const { stdout, code } = await runBash(`${ON_A_TERMINAL}\nprint_qr`, {
      ...sessionEnv,
      AFK_HOME: afkHome,
      AFK_SERVER: server.url,
    });

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stdout).not.toMatch(/[█▀▄]/);
  });

  it("prints nothing and still succeeds when the server cannot be reached", async () => {
    const afkHome = await makeTempDir();

    const { stdout, code } = await runBash(`${ON_A_TERMINAL}\nprint_qr`, {
      ...sessionEnv,
      AFK_HOME: afkHome,
      // Port 1 needs root to bind and nothing listens there: the connection is refused.
      AFK_SERVER: "http://127.0.0.1:1",
    });

    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
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
