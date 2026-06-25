// Cross-run memory (Task 5.2): durable project notes the agent leaves for its future self in AGENT.md
// at the workspace root. Read once at the top of each run and folded into the system prompt, so a fresh
// process starts already knowing what past runs worked out — build commands, conventions, gotchas, the
// user's standing preferences. No new storage: the agent maintains the file with its own edit_file
// tool, and this just loads that file on the way in.
//
// Improved: adaptive budget based on context window, structured loading with priority sections.
import { readFileSync } from "node:fs";
import path from "node:path";

export const MEMORY_FILE = "AGENT.md";

// Default budget for memory in the prompt. Adaptive: scales with the model's context window, but
// never below a floor (small models) or above a ceiling (a bloated file shouldn't eat the budget).
const MIN_CHARS = 4_000;   // ~1k tokens — floor even for tiny-window models
const MAX_CHARS = 16_000;  // ~4k tokens — ceiling to prevent runaway memory files
const WINDOW_FRACTION = 0.04; // 4% of context window budget, if known

/**
 * Compute the memory budget for a given context window size.
 * Adaptive: larger models get more memory budget, but always within bounds.
 */
export function memoryBudget(contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0) return MAX_CHARS; // default when window unknown
  // 4% of window in chars (~1% in tokens), clamped to [MIN_CHARS, MAX_CHARS]
  const adaptive = Math.floor(contextWindow * WINDOW_FRACTION);
  return Math.max(MIN_CHARS, Math.min(adaptive, MAX_CHARS));
}

/**
 * Prioritize memory sections: headings starting with "## " are treated as sections.
 * If truncation is needed, keep the first section (usually most important conventions)
 * and the last section (usually the most recent notes), dropping the middle.
 */
function smartTruncate(text: string, limit: number): string {
  if (text.length <= limit) return text;

  // Try to find section boundaries (## headings)
  const sections = text.split(/(?=^## )/m);

  if (sections.length <= 2) {
    // No meaningful sections — just truncate with a message
    return (
      text.slice(0, limit) +
      `\n\n… [memory truncated — ${MEMORY_FILE} is over ${limit} chars; trim it to the facts that still matter]`
    );
  }

  // Keep first section + as many recent sections as fit
  const first = sections[0]!;
  let kept = first;
  const rest = sections.slice(1);

  // Add sections from the end until we'd exceed the limit
  const keptFromEnd: string[] = [];
  let endBudget = limit - first.length - 100; // 100 chars for the truncation notice
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i]!.length <= endBudget) {
      keptFromEnd.unshift(rest[i]!);
      endBudget -= rest[i]!.length;
    } else {
      break;
    }
  }

  const droppedCount = rest.length - keptFromEnd.length;
  if (droppedCount > 0) {
    kept += `\n\n… [${droppedCount} older section(s) trimmed to save context]\n\n`;
  }
  kept += keptFromEnd.join("");

  return kept;
}

// Read the memory file into a ready-to-append prompt section, or "" when there's nothing usable. Never
// throws — a missing, unreadable, or empty file just means "no memory this run", which must not break a
// run. Takes the directory (defaults to the workspace) so the offline self-check can point it at a
// fixture. Over-long memory is trimmed, not refused: memory should always load, but a bloated file gets
// capped with a nudge to trim it.
export function loadMemory(dir: string = process.cwd(), contextWindow?: number): string {
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

  const limit = memoryBudget(contextWindow);
  text = smartTruncate(text, limit);

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
