// Manages persistent chat sessions on disk to allow listing and resuming past chats.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";

const DIR = join(homedir(), ".mini-agent", "sessions");

export type SessionMeta = { id: string; title: string; cwd: string; updated: number; turns: number };
export type Session = SessionMeta & { messages: OpenAI.ChatCompletionMessageParam[] };

// Sortable, filename-safe id from the timestamp (newest sorts last lexically, so we sort by `updated`).
export const newSessionId = (): string => new Date().toISOString().replace(/[:.]/g, "-");

export function saveSession(s: Session): void {
  if (!s.messages.length) return; // nothing said yet — don't litter the dir with empty sessions
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${s.id}.json`), JSON.stringify(s));
  } catch {
    // a failed save just means this session won't be resumable — not worth interrupting the run
  }
}

export function listSessions(): SessionMeta[] {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Session)
      .map(({ id, title, cwd, updated, turns }) => ({ id, title, cwd, updated, turns }))
      .sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export function loadSession(id: string): Session | null {
  try {
    return JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8")) as Session;
  } catch {
    return null;
  }
}
