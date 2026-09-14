import type { AnomalyEvent, EventSeverity, RunOutputTail } from "@afk/shared";

/** Higher is worse. */
const SEVERITY_RANK: Record<EventSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function isOpenEvent(event: AnomalyEvent): boolean {
  return event.endedAt === null;
}

/** When the event stopped, or `latest` while it is still ongoing. */
export function eventEndMs(event: AnomalyEvent, latest: number): number {
  return event.endedAt ?? latest;
}

/** The most severe of `events`, or null when there are none. */
export function worstSeverity(events: readonly AnomalyEvent[]): EventSeverity | null {
  let worst: EventSeverity | null = null;
  for (const event of events) {
    if (worst === null || SEVERITY_RANK[event.severity] > SEVERITY_RANK[worst]) {
      worst = event.severity;
    }
  }
  return worst;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Label of a collapsed output tail: "last output (5 lines)", noting when lines were cut. */
export function outputTailSummary(tail: RunOutputTail): string {
  const lines = pluralize(tail.stdout.length + tail.stderr.length, "line");
  return `last output (${lines}${tail.truncated ? ", truncated" : ""})`;
}
