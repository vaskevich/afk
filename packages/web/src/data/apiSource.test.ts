// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { apiSource } from "./apiSource.ts";

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

    await expect(apiSource.load(SESSION_ID)).rejects.toThrow(`Session "${SESSION_ID}" was deleted`);
  });

  it("says the session was not found for a plain 404", async () => {
    answer(404, { error: "unknown session" });

    await expect(apiSource.load(SESSION_ID)).rejects.toThrow(`Session "${SESSION_ID}" not found`);
  });
});
