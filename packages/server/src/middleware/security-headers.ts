import { secureHeaders } from "hono/secure-headers";

/**
 * Content Security Policy for everything the server serves. The dashboard is a Vite
 * build with one hashed script and one hashed stylesheet under /assets, so scripts and
 * styles come from 'self' alone: no 'unsafe-inline' for styles, because React applies
 * `style={{...}}` props through the CSSOM (`element.style.x = y`), which CSP does not
 * govern, and Vite extracts every stylesheet to a file. `data:` images cover the
 * favicon and any canvas export; `connect-src 'self'` covers fetch and the EventSource
 * stream; the page is never meant to be framed. API responses carry the same header:
 * harmless for JSON, and one policy to reason about.
 *
 * Verified against the built dashboard in the browser: no violations on /, /s/demo, or
 * a live session (timeline canvas, styled cursor and rows, SSE frames arriving). If a
 * future dependency injects a <style> tag at runtime, the console will say so; prefer
 * fixing the dependency over adding 'unsafe-inline'.
 */
export const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'self'"],
  imgSrc: ["'self'", "data:"],
  styleSrc: ["'self'"],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
};

/** Hono's secureHeaders with the policy above; `frame-ancestors 'none'` is mirrored as X-Frame-Options DENY. */
export function securityHeaders() {
  return secureHeaders({
    contentSecurityPolicy: CONTENT_SECURITY_POLICY,
    xFrameOptions: "DENY",
  });
}
