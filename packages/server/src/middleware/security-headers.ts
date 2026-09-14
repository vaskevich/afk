import { createMiddleware } from "hono/factory";
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
 * fixing the dependency over adding 'unsafe-inline'. The same goes for scripts: the
 * theme initializer in index.html is an external file for exactly this reason (an
 * inline version was silently blocked in production until a review caught it).
 *
 * Every response also carries `X-Robots-Tag: noindex, nofollow`: a session URL is a
 * share link, and if one is pasted somewhere public the trace must not end up in a
 * search index.
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
  const secure = secureHeaders({
    contentSecurityPolicy: CONTENT_SECURITY_POLICY,
    xFrameOptions: "DENY",
  });
  return createMiddleware(async (c, next) => {
    await secure(c, next);
    c.header("X-Robots-Tag", "noindex, nofollow");
  });
}
