import { bodyLimit } from "hono/body-limit";
import { errorResponse } from "../http/errors.ts";

/** The status an oversized body gets; the client parks such a batch in `rejected/`. */
export const PAYLOAD_TOO_LARGE_STATUS = 413;

/**
 * Hono's bodyLimit, answering 413 with an `ErrorResponse` instead of a bare text body so
 * every rejection the client sees has the same `{ error, details }` shape. Checks
 * `Content-Length` when present (what curl sends), otherwise counts the stream.
 */
export function limitBody(maxBytes: number) {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) =>
      errorResponse(c, PAYLOAD_TOO_LARGE_STATUS, `request body exceeds ${maxBytes} bytes`, {
        limit: maxBytes,
      }),
  });
}
