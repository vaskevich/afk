// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { FramesResponse, StoredFrame } from "@afk/shared";
import {
  T0_MS,
  makeEvent,
  makeSessionSummary,
  makeStoredFrames,
  makeSystemFrame,
} from "@afk/shared/testing";
import { CONTACT_LOST_AFTER_MS } from "./freshness.ts";
import { useSession } from "./useSession.ts";
import { apiSource } from "./apiSource.ts";
import { fixtureSource } from "./fixtureSource.ts";
import { DEMO_SESSION_ID, type SubscribeHandlers } from "./source.ts";

/**
 * useSession wires a `SessionSource` into a react-query cache. The demo session
 * (fixtureSource) is used as-is since it is a real, deterministic implementation of
 * the interface; an active session is exercised by stubbing `apiSource`'s methods,
 * the same seam the app uses to swap in the real server - the network call and
 * EventSource underneath it are the true edge, not `useSession` itself.
 */

function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useSession", () => {
  it("loads the demo session from the fixture source", async () => {
    const { result } = renderHook(() => useSession(DEMO_SESSION_ID), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(result.current.query.data?.session.sessionId).toBe(DEMO_SESSION_ID);
    expect(result.current.query.data?.frames.length).toBeGreaterThan(0);
  });

  it("never opens a live subscription once the session has ended", async () => {
    const subscribeSpy = vi.spyOn(fixtureSource, "subscribe");

    const { result } = renderHook(() => useSession(DEMO_SESSION_ID), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(result.current.connection).toBe("closed");
  });

  it("appends new frames received live, dropping ones at or below the known index", async () => {
    const initial: FramesResponse = {
      session: makeSessionSummary({ sessionId: "live-frames", status: "active", endedAt: null }),
      frames: makeStoredFrames([makeSystemFrame(0)]),
      events: [],
    };
    let handlers: SubscribeHandlers | undefined;
    vi.spyOn(apiSource, "load").mockResolvedValue(initial);
    vi.spyOn(apiSource, "subscribe").mockImplementation((_sessionId, _afterIndex, h) => {
      handlers = h;
      return () => {};
    });

    const { result } = renderHook(() => useSession("live-frames"), { wrapper: Wrapper });
    await waitFor(() => expect(handlers).toBeDefined());

    const freshFrame: StoredFrame = {
      index: 2,
      receivedAt: T0_MS + 1_250,
      frame: makeSystemFrame(1),
    };
    const staleFrame: StoredFrame = {
      index: 1,
      receivedAt: T0_MS + 250,
      frame: makeSystemFrame(0),
    };
    act(() => {
      handlers!.onFrames([freshFrame]);
      handlers!.onFrames([staleFrame]);
    });

    await waitFor(() => expect(result.current.query.data?.frames).toHaveLength(2));
    expect(result.current.query.data?.frames.map((f) => f.index)).toEqual([1, 2]);
  });

  it("applies the end summary, so a session that chained learns its successor while being watched", async () => {
    const initial: FramesResponse = {
      session: makeSessionSummary({ sessionId: "chained", status: "active", endedAt: null }),
      frames: makeStoredFrames([makeSystemFrame(0)]),
      events: [],
    };
    let handlers: SubscribeHandlers | undefined;
    vi.spyOn(apiSource, "load").mockResolvedValue(initial);
    vi.spyOn(apiSource, "subscribe").mockImplementation((_sessionId, _afterIndex, h) => {
      handlers = h;
      return () => {};
    });

    const { result } = renderHook(() => useSession("chained"), { wrapper: Wrapper });
    await waitFor(() => expect(handlers).toBeDefined());

    act(() => {
      handlers!.onSession(
        makeSessionSummary({
          sessionId: "chained",
          status: "ended",
          endedAt: T0_MS + 60_000,
          nextSessionId: "successor",
        }),
      );
    });

    await waitFor(() => expect(result.current.query.data?.session.status).toBe("ended"));
    expect(result.current.query.data?.session.nextSessionId).toBe("successor");
    // The frames already loaded stay; only the summary changed.
    expect(result.current.query.data?.frames).toHaveLength(1);
  });

  it("reports why the stream ended, so the page can say the session was deleted under it", async () => {
    const initial: FramesResponse = {
      session: makeSessionSummary({ sessionId: "doomed", status: "active", endedAt: null }),
      frames: makeStoredFrames([makeSystemFrame(0)]),
      events: [],
    };
    let handlers: SubscribeHandlers | undefined;
    vi.spyOn(apiSource, "load").mockResolvedValue(initial);
    vi.spyOn(apiSource, "subscribe").mockImplementation((_sessionId, _afterIndex, h) => {
      handlers = h;
      return () => {};
    });

    const { result } = renderHook(() => useSession("doomed"), { wrapper: Wrapper });
    await waitFor(() => expect(handlers).toBeDefined());
    expect(result.current.endReason).toBeNull();

    act(() => {
      handlers!.onSession(
        makeSessionSummary({ sessionId: "doomed", status: "ended", endedAt: T0_MS + 60_000 }),
      );
      handlers!.onEnd("deleted");
    });

    await waitFor(() => expect(result.current.endReason).toBe("deleted"));
    // The frames already loaded stay on the page; they are all that is left of it.
    expect(result.current.query.data?.frames).toHaveLength(1);
  });

  it("upserts a live event by id instead of duplicating it", async () => {
    const opened = makeEvent({ id: "system:cpu.high:1", startedAt: T0_MS + 5_000, endedAt: null });
    const initial: FramesResponse = {
      session: makeSessionSummary({ sessionId: "live-events", status: "active", endedAt: null }),
      frames: makeStoredFrames([makeSystemFrame(0)]),
      events: [opened],
    };
    let handlers: SubscribeHandlers | undefined;
    vi.spyOn(apiSource, "load").mockResolvedValue(initial);
    vi.spyOn(apiSource, "subscribe").mockImplementation((_sessionId, _afterIndex, h) => {
      handlers = h;
      return () => {};
    });

    const { result } = renderHook(() => useSession("live-events"), { wrapper: Wrapper });
    await waitFor(() => expect(handlers).toBeDefined());

    const closed = { ...opened, endedAt: T0_MS + 9_000 };
    act(() => {
      handlers!.onEvent(closed);
    });

    await waitFor(() => expect(result.current.query.data?.events).toHaveLength(1));
    expect(result.current.query.data?.events[0]).toEqual(closed);
  });
});

/**
 * The freshness watchdog: while a session is active, the page is only trusted for as
 * long as the server keeps saying something (a frame, a ping, anything). Time is fake
 * here because the hook owns the silence timer and the once-a-second clock.
 */
describe("useSession freshness watchdog", () => {
  /** A stand-in server: the handlers of every stream opened so far, newest last. */
  let streams: SubscribeHandlers[];
  let unsubscribe: Mock<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0_MS);
    streams = [];
    unsubscribe = vi.fn();
    vi.spyOn(apiSource, "load").mockResolvedValue({
      session: makeSessionSummary({ sessionId: "watched", status: "active", endedAt: null }),
      frames: makeStoredFrames([makeSystemFrame(0)]),
      events: [],
    });
    vi.spyOn(apiSource, "subscribe").mockImplementation((_sessionId, _afterIndex, handlers) => {
      streams.push(handlers);
      handlers.onConnection("connecting");
      return unsubscribe;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets `ms` of fake time pass, flushing whatever React and react-query schedule in it. */
  async function elapse(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** Loads the session and opens its stream, which the server answers at once. */
  async function follow() {
    const rendered = renderHook(() => useSession("watched"), { wrapper: Wrapper });
    await elapse(0);
    act(() => {
      streams.at(-1)!.onConnection("live");
    });
    return rendered;
  }

  it("vouches for the page while frames, pings, or anything else keep arriving", async () => {
    const { result } = await follow();

    await elapse(CONTACT_LOST_AFTER_MS - 1_000);
    act(() => {
      streams.at(-1)!.onPing();
    });
    await elapse(CONTACT_LOST_AFTER_MS - 1_000);
    act(() => {
      streams
        .at(-1)!
        .onFrames([{ index: 2, receivedAt: T0_MS + 58_000, frame: makeSystemFrame(58) }]);
    });
    await elapse(CONTACT_LOST_AFTER_MS - 1_000);

    expect(result.current.contactLostSince).toBeNull();
    expect(result.current.query.data?.frames).toHaveLength(2);
  });

  it("reports lost contact once nothing has arrived for twice the keepalive interval, naming when it last heard", async () => {
    const { result } = await follow();

    await elapse(CONTACT_LOST_AFTER_MS - 1_000);
    expect(result.current.contactLostSince).toBeNull();
    await elapse(1_000);

    expect(result.current.contactLostSince).toBe(T0_MS);
  });

  it("recovers as soon as the server is heard again", async () => {
    const { result } = await follow();
    await elapse(CONTACT_LOST_AFTER_MS);
    expect(result.current.contactLostSince).toBe(T0_MS);

    act(() => {
      streams.at(-1)!.onPing();
    });

    expect(result.current.contactLostSince).toBeNull();
  });

  it("reopens a silent stream from the last frame on the page, since a half-open socket never errors", async () => {
    await follow();
    act(() => {
      streams
        .at(-1)!
        .onFrames([{ index: 2, receivedAt: T0_MS + 1_000, frame: makeSystemFrame(1) }]);
    });

    await elapse(CONTACT_LOST_AFTER_MS);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(apiSource.subscribe).toHaveBeenCalledTimes(2);
    expect(apiSource.subscribe).toHaveBeenLastCalledWith("watched", 2, expect.anything());
  });

  it("reports lost contact the moment the transport says it is reconnecting", async () => {
    const { result } = await follow();
    await elapse(5_000);

    act(() => {
      streams.at(-1)!.onConnection("reconnecting");
    });

    expect(result.current.contactLostSince).toBe(T0_MS);
    expect(result.current.connection).toBe("reconnecting");
  });

  it("never reports lost contact for a session that has ended, however long ago it was heard", async () => {
    const { result } = await follow();
    act(() => {
      streams
        .at(-1)!
        .onSession(
          makeSessionSummary({ sessionId: "watched", status: "ended", endedAt: T0_MS + 1_000 }),
        );
      streams.at(-1)!.onConnection("closed");
      streams.at(-1)!.onEnd("ended");
    });

    await elapse(10 * CONTACT_LOST_AFTER_MS);

    expect(result.current.contactLostSince).toBeNull();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("never reports lost contact once the session was deleted under the viewer, whatever the summary says", async () => {
    const { result } = await follow();
    act(() => {
      streams.at(-1)!.onConnection("closed");
      streams.at(-1)!.onEnd("deleted");
    });

    await elapse(10 * CONTACT_LOST_AFTER_MS);

    expect(result.current.contactLostSince).toBeNull();
    expect(apiSource.subscribe).toHaveBeenCalledTimes(1);
  });
});
