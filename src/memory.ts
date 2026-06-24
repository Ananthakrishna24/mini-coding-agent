// Cross-run memory (Task 5.2): durable project notes the agent leaves for its future self in AGENT.md
// at the workspace root. Read once at the top of each run and folded into the system prompt, so a fresh
// process starts already knowing what past runs worked out — build commands, conventions, gotchas, the
// user's standing preferences. No new storage: the agent maintains the file with its own edit_file
// tool, and this just loads that file on the way in.
import { readFileSync } from "node:fs";
import path from "node:path";

export const MEMORY_FILE = "AGENT.md";
const MAX_CHARS = 8_000; // ~2k tokens; this rides in *every* prompt of a run, so a runaway file can't eat the budget

// Read the memory file into a ready-to-append prompt section, or "" when there's nothing usable. Never
// throws — a missing, unreadable, or empty file just means "no memory this run", which must not break a
// run. Takes the directory (defaults to the workspace) so the offline self-check can point it at a
// fixture. Over-long memory is trimmed, not refused: memory should always load, but a bloated file gets
// capped with a nudge to trim it.
export function loadMemory(dir: string = process.cwd()): string {
  let text: string;
  try {
    text = readFileSync(path.join(dir, MEMORY_FILE), "utf8");
  } catch {
    return ""; // missing or unreadable — run without memory
  }

  text = text.trim();
  if (!text) return ""; // empty / whitespace-only — no dangling heading in the prompt

  // A binary or corrupt AGENT.md (a merge artifact, a bad paste) would inject NUL/garbage into every
  // prompt; read_file refuses such files for the same reason. Skip it rather than pollute the context.
  if (text.includes("\0")) return "";

  if (text.length > MAX_CHARS) {
    text =
      text.slice(0, MAX_CHARS) +
      `\n\n… [memory truncated — ${MEMORY_FILE} is over ${MAX_CHARS} chars; trim it to the facts that still matter]`;
  }

  // Provenance + the verify caveat sit right next to the data: the model knows which file to edit, and
  // that a note is a hint to check against the code, not gospel.
  // XML-fenced so the model reads this user-controlled file as data, not as fresh instructions to obey.
  return (
    `<memory>\n` +
    `Project notes from earlier runs, loaded from ${MEMORY_FILE}. Treat them as hints and ` +
    `verify against the current code before relying on one.\n\n${text}\n` +
    `</memory>`
  );
}
