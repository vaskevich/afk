import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorResponse } from "@afk/shared";

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  message: string,
  details?: unknown,
) {
  const body: ErrorResponse = { error: message, details };
  return c.json(body, status);
}
