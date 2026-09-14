import { MemoryPressureLevel } from "@afk/shared";

const GIB = 1024 ** 3;

export function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

export function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

export function formatLoad(n: number): string {
  return n.toFixed(2);
}

/** "12:34:56" style, from an offset in seconds. Hours shown only when needed. */
export function formatOffset(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Duration for humans: "14m 59s", "1h 02m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export type PressureLabel = "normal" | "warn" | "critical" | "unknown";

export function pressureLabel(level: number): PressureLabel {
  switch (level) {
    case MemoryPressureLevel.Normal:
      return "normal";
    case MemoryPressureLevel.Warn:
      return "warn";
    case MemoryPressureLevel.Critical:
      return "critical";
    default:
      return "unknown";
  }
}
