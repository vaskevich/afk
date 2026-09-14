import type { AnomalyEvent } from "@afk/shared";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { DetailsPanel } from "../components/DetailsPanel.tsx";
import { NearbyEvents } from "../components/NearbyEvents.tsx";
import { SessionHeader } from "../components/SessionHeader.tsx";
import { StatusBanner } from "../components/StatusBanner.tsx";
import { useSession } from "../data/useSession.ts";
import { useNow } from "../useNow.ts";
import { buildModel } from "../timeline/model.ts";
import { Timeline } from "../timeline/Timeline.tsx";
import { resolveWindow, type TimeWindow } from "../timeline/viewport.ts";

const route = getRouteApi("/s/$sessionId");

/** "Near the cursor" means within this many pixels at the current zoom... */
const NEARBY_RADIUS_PX = 24;
/** ...but never less than this much time, so a fully zoomed-out view still finds things. */
const NEARBY_RADIUS_MIN_MS = 5_000;

export function SessionPage() {
  const { sessionId } = route.useParams();
  const { query, connection, endReason } = useSession(sessionId);
  const navigate = useNavigate();
  // null means "follow the latest frame", which is the default while a session is live;
  // a number is an explicit position the user picked by scrubbing.
  const [cursor, setCursor] = useState<number | null>(null);
  // null means "the whole session"; otherwise the slice the viewer zoomed to.
  const [zoom, setZoom] = useState<TimeWindow | null>(null);
  const [plotWidth, setPlotWidth] = useState(0);

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

  const following = cursor === null;
  const effectiveCursor = cursor ?? model.latest;
  const view = resolveWindow(model, zoom, following);
  const msPerPx = plotWidth > 0 ? (view.v1 - view.v0) / plotWidth : 0;
  const nearbyRadiusMs = Math.max(NEARBY_RADIUS_MIN_MS, NEARBY_RADIUS_PX * msPerPx);
  const selectEvent = (event: AnomalyEvent) => setCursor(event.startedAt);
  const deleted = endReason === "deleted";
  // The viewer deleted it from here: the landing page says so, since this page has
  // nothing left to show that the server would stand behind.
  const onDeleted = () => void navigate({ to: "/", search: { deleted: sessionId } });

  return (
    <main className="page">
      <SessionHeader
        session={query.data.session}
        connection={active ? connection : null}
        deleted={deleted}
        onDeleted={onDeleted}
      />
      <StatusBanner
        status={query.data.session.status}
        events={query.data.events}
        nextSessionId={query.data.session.nextSessionId}
        deleted={deleted}
        onSelectEvent={selectEvent}
      />
      <Timeline
        model={model}
        cursor={effectiveCursor}
        following={following}
        onCursorChange={setCursor}
        view={view}
        onZoomChange={setZoom}
        onPlotWidthChange={setPlotWidth}
      />
      <NearbyEvents
        events={model.events}
        latest={model.latest}
        cursor={effectiveCursor}
        radiusMs={nearbyRadiusMs}
        onSelectEvent={selectEvent}
      />
      <DetailsPanel model={model} cursor={effectiveCursor} />
      <p className="hint">
        Click or drag the timeline to scrub; arrow keys nudge by a second. Pinch or ctrl + wheel to
        zoom, scroll sideways to pan, and use +, −, and 0 on the keyboard.
      </p>
    </main>
  );
}
