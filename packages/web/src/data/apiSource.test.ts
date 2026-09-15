// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiSource } from "./apiSource.ts";
import { SessionGoneError, type SubscribeHandlers } from "./source.ts";

const SESSION_ID = "D3FzMqK8qOLVva9LoHF9uc";

/** Stands in for the server: the network call is the true edge of this module. */
function answer(status: number, body: unknown): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("apiSource.deleteSession", () => {
  it("sends DELETE for the session with no token and resolves on success", async () => {
    answer(200, { sessionId: SESSION_ID, frames: 3 });

    await apiSource.deleteSession(SESSION_ID);

    expect(fetch).toHaveBeenCalledWith(`/api/sessions/${SESSION_ID}`, { method: "DELETE" });
  });

  it("rejects with the server's own reason when it refuses", async () => {
    answer(403, { error: "the demo session cannot be deleted" });

    await expect(apiSource.deleteSession("demo")).rejects.toThrow(
      "the demo session cannot be deleted",
    );
  });

  it("rejects naming the status when the refusal has no readable body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("gateway", { status: 502 }));

    await expect(apiSource.deleteSession(SESSION_ID)).rejects.toThrow("Server returned 502");
  });
});

describe("apiSource.load on a session that is gone", () => {
  it("says the session was deleted when the 404 carries that reason", async () => {
    answer(404, { error: "session deleted", details: { reason: "deleted" } });

    const rejection = apiSource.load(SESSION_ID);

    await expect(rejection).rejects.toThrow(`Session "${SESSION_ID}" was deleted`);
    await expect(rejection).rejects.toBeInstanceOf(SessionGoneError);
    await expect(rejection).rejects.toMatchObject({ sessionId: SESSION_ID, reason: "deleted" });
  });

  it("says the session was not found for a plain 404", async () => {
    answer(404, { error: "unknown session" });

    const rejection = apiSource.load(SESSION_ID);

    await expect(rejection).rejects.toThrow(`Session "${SESSION_ID}" not found`);
    await expect(rejection).rejects.toBeInstanceOf(SessionGoneError);
    await expect(rejection).rejects.toMatchObject({ sessionId: SESSION_ID, reason: "not-found" });
  });

  it("rejects with a plain error naming the status for any other failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("gateway", { status: 502 }));

    const rejection = apiSource.load(SESSION_ID);

    await expect(rejection).rejects.toThrow("Server returned 502");
    await expect(rejection).rejects.not.toBeInstanceOf(SessionGoneError);
  });
});

/** Stands in for the browser's EventSource: the stream is the true edge of `subscribe`. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    super();
    FakeEventSource.opened.push(this);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function handlerSpies(): SubscribeHandlers {
  return {
    onFrames: vi.fn(),
    onSession: vi.fn(),
    onEnd: vi.fn(),
    onEvent: vi.fn(),
    onPing: vi.fn(),
    onConnection: vi.fn(),
  };
}

describe("apiSource.subscribe", () => {
  afterEach(() => {
    FakeEventSource.opened = [];
    vi.unstubAllGlobals();
  });

  it("reports a ping from the server as a sign of life and nothing else", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const handlers = handlerSpies();
    apiSource.subscribe(SESSION_ID, 0, handlers);
    const stream = FakeEventSource.opened[0]!;

    stream.dispatchEvent(new MessageEvent("ping", { data: "" }));

    expect(handlers.onPing).toHaveBeenCalledTimes(1);
    expect(handlers.onFrames).not.toHaveBeenCalled();
    expect(handlers.onSession).not.toHaveBeenCalled();
    expect(handlers.onEvent).not.toHaveBeenCalled();
    expect(handlers.onEnd).not.toHaveBeenCalled();
  });
});
