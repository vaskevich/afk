import { getRouteApi } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { DetailsPanel } from "../components/DetailsPanel.tsx";
import { SessionHeader } from "../components/SessionHeader.tsx";
import { StatusBanner } from "../components/StatusBanner.tsx";
import { useSession } from "../data/useSession.ts";
import { useNow } from "../useNow.ts";
import { buildModel } from "../timeline/model.ts";
import { Timeline } from "../timeline/Timeline.tsx";

const route = getRouteApi("/s/$sessionId");

export function SessionPage() {
  const { sessionId } = route.useParams();
  const { query, connection } = useSession(sessionId);
  // null means "follow the latest frame", which is the default while a session is live;
  // a number is an explicit position the user picked by scrubbing.
  const [cursor, setCursor] = useState<number | null>(null);

  const active = query.data?.session.status === "active";
  const now = useNow(active);
  const model = useMemo(() => (query.data ? buildModel(query.data, now) : null), [query.data, now]);

  if (query.isPending) {
    return <div className="centered">Loading session…</div>;
  }
  if (query.isError || !model || !query.data) {
    return (
      <div className="centered">
        Could not load session: {query.error instanceof Error ? query.error.message : "unknown"}
      </div>
    );
  }

  const effectiveCursor = cursor ?? model.latest;

  return (
    <main className="page">
      <SessionHeader session={query.data.session} connection={active ? connection : null} />
      <StatusBanner
        status={query.data.session.status}
        events={query.data.events}
        onSelectEvent={(event) => setCursor(event.startedAt)}
      />
      <Timeline model={model} cursor={effectiveCursor} onCursorChange={setCursor} />
      <DetailsPanel model={model} cursor={effectiveCursor} />
      <p className="hint">Click or drag the timeline to scrub. Arrow keys nudge by a second.</p>
    </main>
  );
}
