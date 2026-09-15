// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { makeEvent, makeRunFrame, makeRunTail } from "@afk/shared/testing";
import { OutputTail } from "./OutputTail.tsx";
import { StatusBanner } from "./StatusBanner.tsx";
import { NearbyEvents } from "./NearbyEvents.tsx";
import { runCollector } from "../timeline/collectors/run.tsx";

afterEach(cleanup);

/** The text of every <pre> in the document, in order. */
function preBlocks(): string[] {
  return Array.from(document.querySelectorAll("pre")).map((pre) => pre.textContent ?? "");
}

describe("OutputTail", () => {
  it("renders stderr before stdout, labelled, one line per row, under a collapsed summary", () => {
    const tail = makeRunTail({
      stdout: ["processing 299/10000 items", "processing 300/10000 items"],
      stderr: ["fatal: lost connection to database"],
      truncated: true,
    });

    render(<OutputTail tail={tail} />);

    const details = document.querySelector("details");
    expect(details?.open).toBe(false);
    expect(screen.getByText("last output (3 lines, truncated)").tagName).toBe("SUMMARY");
    expect(
      Array.from(document.querySelectorAll(".output-tail-label")).map((el) => el.textContent),
    ).toEqual(["stderr", "stdout"]);
    expect(preBlocks()).toEqual([
      "fatal: lost connection to database",
      "processing 299/10000 items\nprocessing 300/10000 items",
    ]);
  });

  it("leaves out a stream that printed nothing", () => {
    render(<OutputTail tail={makeRunTail({ stdout: ["done?"], stderr: [] })} />);

    expect(
      Array.from(document.querySelectorAll(".output-tail-label")).map((el) => el.textContent),
    ).toEqual(["stdout"]);
    expect(preBlocks()).toEqual(["done?"]);
  });

  it("renders nothing when both streams are empty", () => {
    const { container } = render(<OutputTail tail={makeRunTail({ stdout: [], stderr: [] })} />);

    expect(container.innerHTML).toBe("");
  });
});

describe("event lists", () => {
  const failed = makeEvent({
    stream: "run:abcd1234",
    kind: "run.exited",
    severity: "critical",
    message: "command failed with exit code 3 after 12s: fatal: boom",
    endedAt: makeEvent().startedAt,
    details: { outputTail: makeRunTail({ stderr: ["fatal: boom"], stdout: [] }) },
  });

  it("StatusBanner shows the tail beside the event button, not inside it", () => {
    render(
      <StatusBanner
        status="ended"
        events={[failed]}
        nextSessionId={null}
        deleted={false}
        contactLostSince={null}
        onSelectEvent={() => {}}
      />,
    );

    expect(preBlocks()).toEqual(["fatal: boom"]);
    expect(document.querySelector("button details")).toBeNull();
    expect(document.querySelector("li > details.output-tail")).not.toBeNull();
  });

  it("NearbyEvents shows the tail beside the event row", () => {
    render(
      <NearbyEvents
        events={[failed]}
        latest={failed.startedAt}
        cursor={failed.startedAt}
        radiusMs={1000}
        onSelectEvent={() => {}}
      />,
    );

    expect(preBlocks()).toEqual(["fatal: boom"]);
    expect(document.querySelector("button details")).toBeNull();
  });
});

describe("RunDetails", () => {
  it("shows the tail at the exited frame of a failed run", () => {
    const tail = makeRunTail({ stderr: ["fatal: boom"], stdout: ["almost there"] });
    const frame = makeRunFrame(12, { state: "exited", exitCode: 3, tail });

    render(<runCollector.Details frame={frame} />);

    expect(screen.getByText("exited 3")).toBeDefined();
    expect(preBlocks()).toEqual(["fatal: boom", "almost there"]);
  });

  it("shows no tail block while the run is still going", () => {
    render(<runCollector.Details frame={makeRunFrame(5)} />);

    expect(document.querySelector(".output-tail")).toBeNull();
  });
});
