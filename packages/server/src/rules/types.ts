import type { CollectorName, EventSeverity, Frame } from "@afk/shared";

export type FrameOf<C extends CollectorName> = Extract<Frame, { collector: C }>;

/**
 * What a rule thinks about its stream right now. `active` opens or keeps an event
 * open; a later inactive verdict closes it. `since` backdates the start when a rule
 * only becomes sure after a sustain period (e.g. "high for 30 s" starts when the
 * value first crossed the line, not when the 30 s were up).
 */
export interface Verdict {
  active: boolean;
  severity: EventSeverity;
  message: string;
  since?: number;
  /** A point in time rather than a condition: the event is created already closed. */
  instant?: boolean;
}

export const INACTIVE: Verdict = { active: false, severity: "info", message: "" };

/**
 * Per-stream rule state. Instances are created lazily, one per (stream, rule kind),
 * and fed every frame of that stream in index order. `onTick` lets time-based rules
 * (nothing arrived for a while) speak without a frame; during replay the engine ticks
 * with each frame's own timestamp so history and live produce the same events.
 */
export interface RuleInstance<C extends CollectorName = CollectorName> {
  onFrame(frame: FrameOf<C>, atMs: number): Verdict;
  onTick?(nowMs: number): Verdict;
}

export interface Rule<C extends CollectorName = CollectorName> {
  /** Dotted identifier that becomes `AnomalyEvent.kind`, e.g. "cpu.high". */
  kind: string;
  collector: C;
  create(): RuleInstance<C>;
}

/**
 * A rule with its collector type erased so rules for different collectors can share
 * one registry. Safe because the engine only ever feeds a rule frames whose
 * `collector` matches `rule.collector`.
 */
export interface RegisteredRule {
  kind: string;
  collector: CollectorName;
  create(): RuleInstance;
}

export function register<C extends CollectorName>(rule: Rule<C>): RegisteredRule {
  return rule as unknown as RegisteredRule;
}

/** Helper for rules that only need a condition sustained for a while. */
export class Sustain {
  private since: number | null = null;

  constructor(private readonly durationMs: number) {}

  /** Feed the current condition; returns the moment it first held if sustained, else null. */
  update(condition: boolean, atMs: number): number | null {
    if (!condition) {
      this.since = null;
      return null;
    }
    if (this.since === null) {
      this.since = atMs;
    }
    return atMs - this.since >= this.durationMs ? this.since : null;
  }
}
