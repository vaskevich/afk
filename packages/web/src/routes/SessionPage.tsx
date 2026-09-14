import { getRouteApi } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { DetailsPanel } from "../components/DetailsPanel.tsx";
import { SessionHeader } from "../components/SessionHeader.tsx";
import { StatusBanner } from "../components/StatusBanner.tsx";
import { useSession } from "../data/useSession.ts";
import { buildModel } from "../timeline/model.ts";
import { Timeline } from "../timeline/Timeline.tsx";

const route = getRouteApi("/s/$sessionId");

export function SessionPage() {
  const { sessionId } = route.useParams();
  const query = useSession(sessionId);
  // null means "follow the latest frame", which is what a live session should do by
  // default once streaming lands; a number is an explicit position the user picked.
  const [cursor, setCursor] = useState<number | null>(null);

  const model = useMemo(() => (query.data ? buildModel(query.data) : null), [query.data]);

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

  const effectiveCursor = cursor ?? model.t1;

  return (
    <main className="page">
      <SessionHeader session={query.data.session} />
      <StatusBanner />
      <Timeline model={model} cursor={effectiveCursor} onCursorChange={setCursor} />
      <DetailsPanel model={model} cursor={effectiveCursor} />
      <p className="hint">Click or drag the timeline to scrub. Arrow keys nudge by a second.</p>
    </main>
  );
}
