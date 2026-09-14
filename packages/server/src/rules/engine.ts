import type { AnomalyEvent, CollectorName, StoredFrame } from "@afk/shared";
import { clientStale } from "./stale.ts";
import { cpuHigh, memoryPressure } from "./system.ts";
import type { Rule, RuleInstance, Verdict } from "./types.ts";

/** Every rule the server knows. Add new ones here; they apply to old sessions on next load. */
export const RULES: readonly Rule[] = [cpuHigh, memoryPressure, clientStale];

const frameTimeMs = (frame: StoredFrame) => frame.frame.timestamp * 1000;

/**
 * Turns a session's frames into anomaly events by running every applicable rule per
 * stream. Holds all state for one session. Events are derived, never persisted:
 * a loaded session is replayed through a fresh engine.
 */
export class RuleEngine {
  /** Every event so far, in start order. */
  readonly events: AnomalyEvent[] = [];
  private readonly instances = new Map<string, Map<string, RuleInstance>>();
  private readonly open = new Map<string, AnomalyEvent>();

  constructor(private readonly rules: readonly Rule[] = RULES) {}

  /** Feeds frames in index order. Returns the events that opened, changed, or closed. */
  onFrames(frames: readonly StoredFrame[]): AnomalyEvent[] {
    const changed: AnomalyEvent[] = [];
    for (const stored of frames) {
      const { stream, collector } = stored.frame;
      const atMs = frameTimeMs(stored);
      for (const [kind, instance] of this.instancesFor(stream, collector)) {
        // Tick first so time-based rules see the gap before this frame closes it.
        if (instance.onTick) {
          this.apply(stream, kind, instance.onTick(atMs), atMs, changed);
        }
        this.apply(stream, kind, instance.onFrame(stored.frame, atMs), atMs, changed);
      }
    }
    return changed;
  }

  /** Lets time-based rules run without a frame (live sessions only). */
  onTick(nowMs: number): AnomalyEvent[] {
    const changed: AnomalyEvent[] = [];
    for (const [stream, byKind] of this.instances) {
      for (const [kind, instance] of byKind) {
        if (instance.onTick) {
          this.apply(stream, kind, instance.onTick(nowMs), nowMs, changed);
        }
      }
    }
    return changed;
  }

  /** Closes everything still open, e.g. when the session ends. */
  closeAll(atMs: number): AnomalyEvent[] {
    const changed: AnomalyEvent[] = [];
    for (const [key, event] of this.open) {
      event.endedAt = Math.max(atMs, event.startedAt);
      this.open.delete(key);
      changed.push(event);
    }
    return changed;
  }

  private instancesFor(stream: string, collector: CollectorName): Map<string, RuleInstance> {
    let byKind = this.instances.get(stream);
    if (!byKind) {
      byKind = new Map();
      for (const rule of this.rules) {
        if (rule.collector === collector) {
          byKind.set(rule.kind, rule.create());
        }
      }
      this.instances.set(stream, byKind);
    }
    return byKind;
  }

  private apply(
    stream: string,
    kind: string,
    verdict: Verdict,
    atMs: number,
    changed: AnomalyEvent[],
  ): void {
    const key = `${stream} ${kind}`;
    const current = this.open.get(key);
    if (verdict.active) {
      if (!current) {
        const startedAt = verdict.since ?? atMs;
        const event: AnomalyEvent = {
          id: `${stream}:${kind}:${startedAt}`,
          stream,
          kind,
          severity: verdict.severity,
          message: verdict.message,
          startedAt,
          endedAt: null,
        };
        this.open.set(key, event);
        this.events.push(event);
        changed.push(event);
      } else if (current.severity !== verdict.severity || current.message !== verdict.message) {
        current.severity = verdict.severity;
        current.message = verdict.message;
        changed.push(current);
      }
    } else if (current) {
      current.endedAt = Math.max(atMs, current.startedAt);
      this.open.delete(key);
      changed.push(current);
    }
  }
}
