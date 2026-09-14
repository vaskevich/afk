/**
 * Overall verdict for the session.
 *
 * TODO(events): server-side anomaly events (cpu sustained high, memory pressure
 * warn/critical, client stale, run exited non-zero) will drive this. The browser does
 * not interpret raw measurements on purpose: thresholds live on the server so they can
 * change without shipping a new client or dashboard. Until then this is a placeholder.
 */
export function StatusBanner() {
  return (
    <div className="banner banner-ok" role="status">
      <span className="dot" />
      All normal
      <small>no anomalies reported</small>
    </div>
  );
}
