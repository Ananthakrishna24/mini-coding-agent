// Loads project notes from AGENT.md at the workspace root and folds them into the prompt.
import { readFileSync } from "node:fs";
import path from "node:path";

export const MEMORY_FILE = "AGENT.md";

// Default memory budget scaling.
const MIN_CHARS = 4_000;   // ~1k tokens — floor even for tiny-window models
const MAX_CHARS = 16_000;  // ~4k tokens — ceiling to prevent runaway memory files
const WINDOW_FRACTION = 0.04; // 4% of context window budget, if known

/**
 * Computes memory budget based on the model's context window.
 */
export function memoryBudget(contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0) return MAX_CHARS; // default when window unknown
  // 4% of window in chars (~1% in tokens), clamped to [MIN_CHARS, MAX_CHARS]
  const adaptive = Math.floor(contextWindow * WINDOW_FRACTION);
  return Math.max(MIN_CHARS, Math.min(adaptive, MAX_CHARS));
}

/**
 * Truncates text, keeping the first section and the most recent sections.
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

// Reads memory file and returns prompt block, defaulting to empty on errors.
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
