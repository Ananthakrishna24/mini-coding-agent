// Context management and multi-tier compression.
import type OpenAI from "openai";

// ── Budget constants ────────────────────────────────────────────────────────────
// Reserve for model reply and safety margin.
const MAX_OUTPUT = 16_000;
const SAFETY = 8_000;

// Thresholds triggering each compaction tier.
const MICRO_COMPACT_THRESHOLD = 0.75; // truncate old tool results
const SUMMARIZE_THRESHOLD = 0.90;     // LLM-summarize history
const HARD_DROP_THRESHOLD = 0.98;     // emergency middle-drop

// ── Budget math ─────────────────────────────────────────────────────────────────
// Calculate usable input budget.
export function inputBudget(contextWindow: number): number {
  return Math.max(contextWindow - MAX_OUTPUT - SAFETY, 8_000);
}

// ── Token estimation ────────────────────────────────────────────────────────────

/** Estimate tokens from character count. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for a single message. */
export function estimateMessageTokens(msg: OpenAI.ChatCompletionMessageParam): number {
  // Base overhead
  let tokens = 4;

  if (typeof msg.content === "string") {
    tokens += estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    // Multi-part content (vision, etc.)
    for (const part of msg.content as any[]) {
      if (part.type === "text") tokens += estimateTokens(part.text);
      else if (part.type === "image_url") tokens += 1000; // images ≈ 1k tokens
      else tokens += estimateTokens(JSON.stringify(part));
    }
  }

  // Tool calls overhead.
  if ("tool_calls" in msg && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls as any[]) {
      tokens += estimateTokens(tc.function?.name ?? "");
      tokens += estimateTokens(tc.function?.arguments ?? "");
      tokens += 8;
    }
  }

  return tokens;
}

/** Estimate tokens for the entire message history. */
export function countMessages(messages: OpenAI.ChatCompletionMessageParam[]): number {
  return messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
}

export function overBudget(messages: OpenAI.ChatCompletionMessageParam[], budget: number): boolean {
  return countMessages(messages) > budget;
}

// ── Tier 1: Micro-compact (truncate stale tool results) ─────────────────────────
// Truncate older tool results to preserve context headroom.

const TOOL_RESULT_KEEP_RECENT = 6;
const TOOL_RESULT_MAX_CHARS = 800;
const TOOL_RESULT_SUMMARY_SUFFIX =
  "\n…[output truncated to save context — re-read the file if you need the full content]";

/** Tools whose outputs are compactable. */
const COMPACTABLE_TOOLS = new Set([
  "read_file", "run_bash", "grep", "glob", "write_file", "edit_file",
]);

/** Truncate older tool outputs in-place. */
export function microCompact(messages: OpenAI.ChatCompletionMessageParam[]): number {
  // Collect tool_call IDs for compactable tools, in order
  const compactableIds: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
      for (const tc of (m as any).tool_calls) {
        if (tc.type === "function" && COMPACTABLE_TOOLS.has(tc.function?.name ?? "")) {
          compactableIds.push(tc.id);
        }
      }
    }
  }

  // Keep the last N intact
  const keepSet = new Set(compactableIds.slice(-TOOL_RESULT_KEEP_RECENT));
  const truncateSet = new Set(compactableIds.filter(id => !keepSet.has(id)));

  if (truncateSet.size === 0) return 0;

  let tokensFreed = 0;

  for (const m of messages) {
    if (m.role !== "tool") continue;
    const toolMsg = m as OpenAI.ChatCompletionToolMessageParam;
    if (!truncateSet.has(toolMsg.tool_call_id)) continue;

    const content = typeof toolMsg.content === "string" ? toolMsg.content : "";
    if (content.length <= TOOL_RESULT_MAX_CHARS) continue;

    const before = estimateTokens(content);
    toolMsg.content = content.slice(0, TOOL_RESULT_MAX_CHARS) + TOOL_RESULT_SUMMARY_SUFFIX;
    const after = estimateTokens(toolMsg.content);
    tokensFreed += before - after;
  }

  return tokensFreed;
}

// ── Tier 2: LLM-based summarization ────────────────────────────────────────────

/** Compaction prompt. */
export const COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far. This summary must be thorough enough that someone reading only it could continue the work.

Before your summary, wrap your analysis in <analysis> tags:
1. Chronologically analyze each exchange — user requests, your approach, key decisions, code patterns.
2. Note specific file names, code snippets, function signatures, and edits.
3. Record errors and how they were fixed, especially user corrections.
4. Double-check for completeness.

Then provide your summary in <summary> tags with these sections:

1. **Primary Request and Intent**: The user's goals in detail.
2. **Key Technical Concepts**: Technologies, frameworks, patterns discussed.
3. **Files and Code**: Files read/modified/created, with snippets and why each matters.
4. **Errors and Fixes**: Every error, how it was resolved, and any user feedback.
5. **Problem Solving**: Problems solved and ongoing troubleshooting.
6. **User Messages**: All non-tool user messages (critical for understanding intent changes).
7. **Pending Tasks**: Explicitly requested work still outstanding.
8. **Current Work**: What was being done right before this summary, with file names and snippets.
9. **Next Step**: The immediate next action, with direct quotes showing where you left off.

Respond with ONLY the <analysis> and <summary> blocks. Do NOT call any tools.`;

/** Format the raw compact summary content. */
export function formatCompactSummary(raw: string): string {
  let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();

  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (match) text = match[1]!.trim();

  text = text.replace(/\n{3,}/g, "\n\n");

  return `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\n${text}\n\nIf you need specific details from before compaction (exact code, errors, content), re-read the relevant files.`;
}

// ── Tier 3: Hard-drop (emergency fallback) ──────────────────────────────────────
const KEEP_TAIL = 8;

/** Emergency hard-drop of conversation history. */
export function hardDrop(messages: OpenAI.ChatCompletionMessageParam[]): number {
  if (messages.length <= KEEP_TAIL + 2) return 0;

  let cut = messages.length - KEEP_TAIL;
  while (cut < messages.length && messages[cut].role === "tool") cut++;
  if (cut <= 2) return 0;

  const removed = cut - 2;
  messages.splice(2, removed, {
    role: "user",
    content: "[older turns were trimmed to stay within the context budget — the conversation continues from here]",
  });
  return removed;
}

// ── Orchestrator: tiered compaction ─────────────────────────────────────────────

export type CompactionResult = {
  tier: "none" | "micro" | "summary" | "drop";
  tokensFreed: number;
  description: string;
};

/** Relieve context pressure using the cheapest effective tier. */
export function compact(messages: OpenAI.ChatCompletionMessageParam[], budget?: number): CompactionResult {
  const used = countMessages(messages);
  const b = budget ?? Infinity;

  if (used <= b * MICRO_COMPACT_THRESHOLD) {
    return { tier: "none", tokensFreed: 0, description: "" };
  }

  if (used <= b * SUMMARIZE_THRESHOLD) {
    const freed = microCompact(messages);
    if (freed > 0) {
      return {
        tier: "micro",
        tokensFreed: freed,
        description: `truncated old tool outputs (~${freed} tokens freed)`,
      };
    }
    return { tier: "none", tokensFreed: 0, description: "" };
  }

  const microFreed = microCompact(messages);
  const afterMicro = countMessages(messages);

  if (afterMicro <= b * SUMMARIZE_THRESHOLD) {
    return {
      tier: "micro",
      tokensFreed: microFreed,
      description: `truncated old tool outputs (~${microFreed} tokens freed)`,
    };
  }

  if (afterMicro <= b * HARD_DROP_THRESHOLD) {
    return {
      tier: "summary",
      tokensFreed: microFreed,
      description: "context pressure high — LLM summarization recommended",
    };
  }

  const dropped = hardDrop(messages);
  return {
    tier: "drop",
    tokensFreed: microFreed + dropped * 200,
    description: `emergency: dropped ${dropped} old messages from the middle`,
  };
}

// ── Backward-compatible alias ───────────────────────────────────────────────────

/** @deprecated Use the new tiered `compact()` and inspect `.tier`. */
export function compactLegacy(messages: OpenAI.ChatCompletionMessageParam[]): number {
  return hardDrop(messages);
}
