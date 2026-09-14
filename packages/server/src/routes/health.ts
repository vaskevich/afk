import { Hono } from "hono";
import { PROTOCOL_VERSION } from "@afk/shared";

export const healthRoutes = new Hono().get("/", (c) =>
  c.json({ ok: true, protocolVersion: PROTOCOL_VERSION }),
);
