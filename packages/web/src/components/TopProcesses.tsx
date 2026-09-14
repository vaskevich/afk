import type { AnomalyEventDetails } from "@afk/shared";
import { commandBasename, formatPercent } from "../format.ts";

type TopProcessList = NonNullable<AnomalyEventDetails["topProcesses"]>;

/**
 * The processes an event named when it opened, as a compact inline list under its
 * message. Phrasing content only (spans), since it is rendered inside buttons.
 */
export function TopProcesses({ processes }: { processes: TopProcessList }) {
  if (processes.length === 0) {
    return null;
  }
  return (
    <span className="event-top" aria-label="Top processes when this started">
      {processes.map((process) => (
        <span key={process.pid} title={`pid ${process.pid}: ${process.command}`}>
          <span className="mono">{commandBasename(process.command)}</span>{" "}
          {formatPercent(process.cpuPercent)}
        </span>
      ))}
    </span>
  );
}
