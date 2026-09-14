import { FramesResponse } from "@afk/shared";
import type { SessionSource } from "./source.ts";

/** Reads a session from the afk server. In dev, Vite proxies `/api` to the server. */
export const apiSource: SessionSource = {
  async load(sessionId) {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/frames`);
    if (!res.ok) {
      throw new Error(
        res.status === 404 ? `Session "${sessionId}" not found` : `Server returned ${res.status}`,
      );
    }
    return FramesResponse.parse(await res.json());
  },
};
