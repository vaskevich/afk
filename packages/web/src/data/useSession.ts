import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnomalyEvent, FramesResponse, StreamEndReason } from "@afk/shared";
import { useEffect, useState } from "react";
import { useNow } from "../useNow.ts";
import { apiSource } from "./apiSource.ts";
import { fixtureSource } from "./fixtureSource.ts";
import { CONTACT_LOST_AFTER_MS, contactLostSince } from "./freshness.ts";
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
 *
 * While following, it also watches for the server going quiet. `contactLostSince` is
 * when the server was last heard from once that is too long ago (or the transport has
 * reported itself down), and null while the page can be trusted; see `freshness.ts`.
 * A stream that has been silent for `CONTACT_LOST_AFTER_MS` is reopened from the last
 * frame on the page, since EventSource only reconnects on its own when the socket
 * fails outright, not when it is half-open or was refused for good.
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
  // Why the live stream closed, once it has: `deleted` means the session was removed
  // while this page was watching, and the frames on screen are all that is left of it.
  const [endReason, setEndReason] = useState<StreamEndReason | null>(null);
  // When the server was last heard from over the live stream; null until it opens.
  const [lastHeardAt, setLastHeardAt] = useState<number | null>(null);

  const status = query.data?.session.status;
  // Resume cursor at the moment the subscription starts; later frames arrive through it.
  const loadedLastIndex = query.data ? (query.data.frames.at(-1)?.index ?? 0) : null;

  useEffect(() => {
    if (status !== "active" || loadedLastIndex === null) {
      return;
    }
    const key = queryKey(sessionId);
    const source = sourceFor(sessionId);
    const update = (fn: (old: FramesResponse) => FramesResponse) =>
      queryClient.setQueryData<FramesResponse>(key, (old) => (old ? fn(old) : old));
    const lastIndexOnPage = () =>
      queryClient.getQueryData<FramesResponse>(key)?.frames.at(-1)?.index ?? loadedLastIndex;

    let unsubscribe = () => {};
    let silence: number | null = null;
    function disarm() {
      if (silence !== null) {
        window.clearTimeout(silence);
        silence = null;
      }
    }
    // Anything from the server, the stream opening included, restarts the silence timer.
    function heard() {
      setLastHeardAt(Date.now());
      disarm();
      silence = window.setTimeout(reopen, CONTACT_LOST_AFTER_MS);
    }
    // Nothing for too long: close what may be a dead socket and resume from the last frame.
    function reopen() {
      unsubscribe();
      silence = window.setTimeout(reopen, CONTACT_LOST_AFTER_MS);
      open(lastIndexOnPage());
    }
    function open(afterIndex: number) {
      unsubscribe = source.subscribe(sessionId, afterIndex, {
        onFrames: (frames) => {
          heard();
          update((old) => {
            const last = old.frames.at(-1)?.index ?? 0;
            const fresh = frames.filter((f) => f.index > last);
            return fresh.length === 0 ? old : { ...old, frames: [...old.frames, ...fresh] };
          });
        },
        onSession: (session) => {
          heard();
          update((old) => ({ ...old, session }));
        },
        onEvent: (event) => {
          heard();
          update((old) => ({ ...old, events: upsertEvent(old.events, event) }));
        },
        onPing: heard,
        onConnection: (state) => {
          setConnection(state);
          if (state === "live") {
            heard();
          } else if (state === "connecting") {
            // The first open follows straight after a successful load, which counts as
            // contact; a reopen after silence does not reset when the server was last heard.
            setLastHeardAt((known) => known ?? Date.now());
          }
        },
        onEnd: (reason) => {
          disarm();
          setEndReason(reason);
        },
      });
    }

    // Armed before opening: a source that reports itself live at once re-arms it through `heard`.
    silence = window.setTimeout(reopen, CONTACT_LOST_AFTER_MS);
    open(loadedLastIndex);
    return () => {
      disarm();
      unsubscribe();
      setLastHeardAt(null);
    };
    // loadedLastIndex changes as frames stream in; only the value at subscribe time matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, status, queryClient]);

  const following = status === "active" && endReason === null && lastHeardAt !== null;
  const now = useNow(following);
  const lostSince = following ? contactLostSince({ connection, lastHeardAt, nowMs: now }) : null;

  return { query, connection, endReason, contactLostSince: lostSince };
}
