import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { log } from "../log/logger.ts";
import { SLOW_REQUEST_MS, requestTiming } from "./request-timing.ts";

/** An app whose clock reads `startMs` when a request begins and `endMs` when it ends. */
function buildApp(startMs: number, endMs: number) {
  const readings = [startMs, endMs];
  const app = new Hono()
    .use("*", requestTiming({ now: () => readings.shift() ?? endMs }))
    .get("/ok", (c) => c.text("ok"))
    .get("/created", (c) => c.text("created", 201))
    .get("/throws", () => {
      throw new Error("handler failed");
    });
  const info = vi.spyOn(log, "info").mockImplementation(() => {});
  const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
  return { app, info, debug };
}

describe("requestTiming", () => {
  it("logs a request that took SLOW_REQUEST_MS at info with method, path, status, and ms", async () => {
    const { app, info, debug } = buildApp(100, 100 + SLOW_REQUEST_MS);

    await app.request("/created");

    expect(info).toHaveBeenCalledWith("slow request", {
      method: "GET",
      path: "/created",
      status: 201,
      ms: SLOW_REQUEST_MS,
    });
    expect(debug).not.toHaveBeenCalled();
  });

  it("logs a request just under SLOW_REQUEST_MS at debug", async () => {
    const { app, info, debug } = buildApp(100, 100 + SLOW_REQUEST_MS - 1);

    await app.request("/ok");

    expect(debug).toHaveBeenCalledWith("request", {
      method: "GET",
      path: "/ok",
      status: 200,
      ms: SLOW_REQUEST_MS - 1,
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("leaves the query string out of the path", async () => {
    const { app, debug } = buildApp(0, 5);

    await app.request("/ok?after=42");

    expect(debug).toHaveBeenCalledWith("request", expect.objectContaining({ path: "/ok" }));
  });

  it("records a handler that threw as its 500 response", async () => {
    const { app, debug } = buildApp(0, 5);

    const res = await app.request("/throws");

    expect(res.status).toBe(500);
    expect(debug).toHaveBeenCalledWith("request", expect.objectContaining({ status: 500 }));
  });

  it("records a 404 for a path no route handles", async () => {
    const { app, debug } = buildApp(0, 5);

    await app.request("/nowhere");

    expect(debug).toHaveBeenCalledWith(
      "request",
      expect.objectContaining({ path: "/nowhere", status: 404 }),
    );
  });
});
