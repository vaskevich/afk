import { useQuery } from "@tanstack/react-query";
import { apiSource } from "./apiSource.ts";
import { fixtureSource } from "./fixtureSource.ts";
import { DEMO_SESSION_ID, type SessionSource } from "./source.ts";

export function sourceFor(sessionId: string): SessionSource {
  return sessionId === DEMO_SESSION_ID ? fixtureSource : apiSource;
}

/** Loads a whole session (summary + all frames so far). */
export function useSession(sessionId: string) {
  return useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => sourceFor(sessionId).load(sessionId),
  });
}
