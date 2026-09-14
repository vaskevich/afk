import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnomalyEvent, FramesResponse } from "@afk/shared";
import { useEffect, useState } from "react";
import { apiSource } from "./apiSource.ts";
import { fixtureSource } from "./fixtureSource.ts";
import { DEMO_SESSION_ID, type ConnectionState, type SessionSource } from "./source.ts";

export function sourceFor(sessionId: string): SessionSource {
  return sessionId === DEMO_SESSION_ID ? fixtureSource : apiSource;
}

const queryKey = (sessionId: string) => ["session", sessionId] as const;

/** Replaces the event with the same id (or appends it), keeping the list sorted by start. */
export function upsertEvent(events: AnomalyEvent[], event: AnomalyEvent): AnomalyEvent[] {
  const next = events.filter((existing) => existing.id !== event.id);
  next.push(event);
  next.sort((a, b) => a.startedAt - b.startedAt);
  return next;
}

/**
 * Loads a session, then keeps it up to date over the source's live subscription while
 * it is active. The query cache is the single copy of the data: new frames are
 * appended to it, so everything downstream just re-renders from `query.data`.
 */
export function useSession(sessionId: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKey(sessionId),
    queryFn: () => sourceFor(sessionId).load(sessionId),
    // Live updates come from the subscription, not from refetching.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [connection, setConnection] = useState<ConnectionState>("closed");

  const status = query.data?.session.status;
  // Resume cursor at the moment the subscription starts; later frames arrive through it.
  const loadedLastIndex = query.data ? (query.data.frames.at(-1)?.index ?? 0) : null;

  useEffect(() => {
    if (status !== "active" || loadedLastIndex === null) {
      return;
    }
    const key = queryKey(sessionId);
    const update = (fn: (old: FramesResponse) => FramesResponse) =>
      queryClient.setQueryData<FramesResponse>(key, (old) => (old ? fn(old) : old));

    return sourceFor(sessionId).subscribe(sessionId, loadedLastIndex, {
      onFrames: (frames) =>
        update((old) => {
          const last = old.frames.at(-1)?.index ?? 0;
          const fresh = frames.filter((f) => f.index > last);
          return fresh.length === 0 ? old : { ...old, frames: [...old.frames, ...fresh] };
        }),
      onSession: (session) => update((old) => ({ ...old, session })),
      onEvent: (event) => update((old) => ({ ...old, events: upsertEvent(old.events, event) })),
      onConnection: setConnection,
    });
    // loadedLastIndex changes as frames stream in; only the value at subscribe time matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, status, queryClient]);

  return { query, connection };
}
