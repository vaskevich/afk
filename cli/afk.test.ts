import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Frame, PROCESSES_TOP_MAX, ProcessesCollectorData, SystemCollectorData } from "@afk/shared";

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

  it("drops the oldest frames until the queue is back under the cap", async () => {
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
  });

  it("leaves a queue under the cap alone", async () => {
    const sessionDir = await makeOverfullQueue();

    const { code, stderr } = await runBash("enforce_spool_cap", {
      SESSION_DIR: sessionDir,
      AFK_SPOOL_MAX_BYTES: "200",
    });

    expect(code, stderr).toBe(0);
    expect(await queueFiles(sessionDir)).toHaveLength(5);
    expect(stderr).toBe("");
  });

  it("reports what it dropped at most once a minute", async () => {
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
  });
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
