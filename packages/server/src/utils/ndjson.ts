import { Frame } from "@afk/shared";

export type ParseFramesResult =
  { ok: true; frames: Frame[] } | { ok: false; line: number; message: string; details?: unknown };

/** Parses a newline-delimited JSON body into validated frames. Stops at the first bad line. */
export function parseFrames(text: string): ParseFramesResult {
  const frames: Frame[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return { ok: false, line: i + 1, message: `line ${i + 1} is not valid JSON` };
    }
    const parsed = Frame.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        line: i + 1,
        message: `line ${i + 1} failed validation`,
        details: parsed.error.flatten(),
      };
    }
    frames.push(parsed.data);
  }
  return { ok: true, frames };
}
