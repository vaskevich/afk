import { mkdir, readdir, readFile, rename, rm, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { StoredFrame } from "@afk/shared";
import { SessionRecord, type SessionStorage } from "./storage.ts";

const SESSION_FILE = "session.json";
const FRAMES_FILE = "frames.ndjson";

/** Session ids are server-generated base62, but never trust a path segment blindly. */
const SAFE_ID = /^[A-Za-z0-9]+$/;

/**
 * Layout under `dataDir`:
 *   sessions/<sessionId>/session.json    SessionRecord
 *   sessions/<sessionId>/frames.ndjson   one StoredFrame per line, in index order
 */
export class DiskSessionStorage implements SessionStorage {
  private readonly sessionsDir: string;

  constructor(dataDir: string) {
    this.sessionsDir = path.join(dataDir, "sessions");
  }

  private dir(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) {
      throw new Error(`invalid session id: ${sessionId}`);
    }
    return path.join(this.sessionsDir, sessionId);
  }

  async putSession(record: SessionRecord) {
    const dir = this.dir(record.sessionId);
    await mkdir(dir, { recursive: true });
    // Write then rename so a crash never leaves a half-written record behind.
    const tmp = path.join(dir, `${SESSION_FILE}.tmp`);
    await writeFile(tmp, JSON.stringify(record));
    await rename(tmp, path.join(dir, SESSION_FILE));
  }

  async getSession(sessionId: string) {
    if (!SAFE_ID.test(sessionId)) {
      return null;
    }
    try {
      const text = await readFile(path.join(this.dir(sessionId), SESSION_FILE), "utf8");
      return SessionRecord.parse(JSON.parse(text));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async appendFrames(sessionId: string, frames: StoredFrame[]) {
    if (frames.length === 0) {
      return;
    }
    const lines = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
    await appendFile(path.join(this.dir(sessionId), FRAMES_FILE), lines);
  }

  async readFrames(sessionId: string) {
    let text: string;
    try {
      text = await readFile(path.join(this.dir(sessionId), FRAMES_FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const frames: StoredFrame[] = [];
    for (const line of text.split("\n")) {
      if (line === "") {
        continue;
      }
      const parsed = StoredFrame.safeParse(JSON.parse(line));
      if (parsed.success) {
        frames.push(parsed.data);
      } else {
        console.warn(`[storage] skipping unreadable frame in session ${sessionId}`);
      }
    }
    return frames;
  }

  async listSessionIds() {
    try {
      const entries = await readdir(this.sessionsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && SAFE_ID.test(e.name)).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async deleteSession(sessionId: string) {
    await rm(this.dir(sessionId), { recursive: true, force: true });
  }
}
