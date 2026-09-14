import { useEffect, useState } from "react";

/**
 * Current time (unix ms) that re-renders every `intervalMs` while `enabled`. When not
 * enabled it is frozen at the value from the first render, which is what an ended
 * session wants.
 */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}
