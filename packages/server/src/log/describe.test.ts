import { describe, expect, it } from "vitest";
import { MemoryPressureLevel } from "@afk/shared";
import {
  makeAgentsFrame,
  makeProcessesFrame,
  makeRunFrame,
  makeRunTail,
  makeSystemFrame,
} from "@afk/shared/testing";
import { describeFrame } from "./describe.ts";

describe("describeFrame", () => {
  describe("system frame", () => {
    it("includes the stream, sequence, and cpu percent to one decimal", () => {
      const frame = makeSystemFrame(0, { cpuPercent: 42.567 });

      const description = describeFrame(frame);

      expect(description).toContain(`${frame.stream} #${frame.sequence}`);
      expect(description).toContain("cpu=42.6%");
    });

    it("labels pressure level 1 as normal", () => {
      const frame = makeSystemFrame(0, { pressureLevel: MemoryPressureLevel.Normal });

      expect(describeFrame(frame)).toContain("mem=normal");
    });

    it("labels pressure level 2 as warn", () => {
      const frame = makeSystemFrame(0, { pressureLevel: MemoryPressureLevel.Warn });

      expect(describeFrame(frame)).toContain("mem=warn");
    });

    it("labels pressure level 4 as critical", () => {
      const frame = makeSystemFrame(0, { pressureLevel: MemoryPressureLevel.Critical });

      expect(describeFrame(frame)).toContain("mem=critical");
    });

    it("falls back to level N for an unknown pressure level", () => {
      const frame = makeSystemFrame(0, { pressureLevel: 7 });

      expect(describeFrame(frame)).toContain("mem=level 7");
    });
  });

  describe("run frame", () => {
    it("describes a running command with its byte counts but never the command line", () => {
      const frame = makeRunFrame(0, {
        output: { flavor: "volume", stdoutBytes: 2048, stderrBytes: 512 },
      });

      const description = describeFrame(frame);

      expect(description).toContain("running");
      expect(description).not.toContain(frame.data.command);
      expect(description).toContain("out=2.0K");
      expect(description).toContain("err=0.5K");
    });

    it("describes an exited command with its exit code", () => {
      const frame = makeRunFrame(1, { state: "exited", exitCode: 3, elapsedSeconds: 1 });

      expect(describeFrame(frame)).toContain("exited=3");
    });

    it("counts the tail lines of a failed command on one line without printing them", () => {
      const tail = makeRunTail({ stdout: ["a", "b"], stderr: ["fatal: boom"] });
      const frame = makeRunFrame(1, { state: "exited", exitCode: 3, tail });

      const description = describeFrame(frame);

      expect(description).toContain("tail: 3 lines");
      expect(description).not.toContain("fatal: boom");
      expect(description).not.toContain("\n");
    });
  });

  describe("processes frame", () => {
    it("names the busiest process by basename with its cpu and the total count", () => {
      const frame = makeProcessesFrame(0);

      const description = describeFrame(frame);

      expect(description).toContain(`${frame.stream} #${frame.sequence}`);
      expect(description).toContain("processes=412");
      expect(description).toContain("top=node cpu=180.0%");
      expect(description).toContain("pid=5821");
    });

    it("says top=none when the frame lists no processes", () => {
      const frame = makeProcessesFrame(0, { top: [], sampledCount: 0 });

      expect(describeFrame(frame)).toContain("top=none");
    });
  });

  describe("agents frame", () => {
    it("lists each tool's session count by state and its working subagents", () => {
      const frame = makeAgentsFrame(0, {
        claude: { sessions: 3, working: 1, idle: 1, waitingOnInput: 1, subagentsWorking: 2 },
        codex: { sessions: 1, working: 1, idle: 0, waitingOnInput: 0, subagentsWorking: 0 },
      });

      const description = describeFrame(frame);

      expect(description).toBe(
        `${frame.stream} #${frame.sequence} claude=3 working=1 waiting=1 idle=1 subagents=2 ` +
          "codex=1 working=1 waiting=0 idle=0 subagents=0",
      );
    });

    it("leaves out a tool that is not on the machine", () => {
      const frame = makeAgentsFrame(0, { claude: null, codex: { sessions: 1 } });

      const description = describeFrame(frame);

      expect(description).toBe(
        `${frame.stream} #${frame.sequence} codex=1 working=1 waiting=0 idle=1 subagents=0`,
      );
    });

    it("says agents=unavailable, with no counts, when neither tool is on the machine", () => {
      const frame = makeAgentsFrame(0, { claude: null });

      const description = describeFrame(frame);

      expect(description).toBe(`${frame.stream} #${frame.sequence} agents=unavailable`);
    });
  });
});
