import type { RunOutputTail } from "@afk/shared";
import { outputTailSummary } from "../events.ts";

/**
 * The last lines a failed command printed, collapsed by default so the verdict stays
 * a two-second read. stderr comes first because that is where the reason usually is.
 * Rendered next to, never inside, the buttons that carry an event's message: a
 * <details> is interactive content of its own.
 */
export function OutputTail({ tail }: { tail: RunOutputTail }) {
  const streams = [
    { name: "stderr", lines: tail.stderr },
    { name: "stdout", lines: tail.stdout },
  ].filter((stream) => stream.lines.length > 0);
  if (streams.length === 0) {
    return null;
  }
  return (
    <details className="output-tail">
      <summary>{outputTailSummary(tail)}</summary>
      {streams.map((stream) => (
        <div className="output-tail-stream" key={stream.name}>
          <div className="output-tail-label">{stream.name}</div>
          <pre>{stream.lines.join("\n")}</pre>
        </div>
      ))}
    </details>
  );
}
