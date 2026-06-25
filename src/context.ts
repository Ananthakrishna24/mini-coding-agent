// Context accounting + multi-tier compression. Inspired by the INTERNAL harness's
// autoCompact / microCompact / prompt.ts architecture: instead of blindly dropping
// the middle of the conversation, we (1) truncate stale tool results first, then
// (2) ask the model to summarize the whole thread, and only (3) hard-drop as a
// last resort. The window is shared between the input we send and the reply the
// model writes, so the usable input budget is the window minus a reserve.
import type OpenAI from "openai";

// ── Budget constants ────────────────────────────────────────────────────────────
// Reserve carved out of any model's window: room for the reply + a safety margin.
const MAX_OUTPUT = 16_000;
const SAFETY = 8_000;

// Thresholds (fraction of inputBudget) that trigger each compaction tier.
// Tier 1 (micro-compact) fires early to reclaim cheap headroom; tier 2 (summarize)
// fires when real pressure builds; tier 3 (hard-drop) is the emergency fallback.
const MICRO_COMPACT_THRESHOLD = 0.75; // 75% of budget → truncate old tool results
const SUMMARIZE_THRESHOLD = 0.90;     // 90% of budget → LLM-summarize the history
const HARD_DROP_THRESHOLD = 0.98;     // 98% of budget → emergency middle-drop

// ── Budget math ─────────────────────────────────────────────────────────────────
// Usable input budget for a given context window — never below a small floor so a
// tiny-window model still leaves a few thousand tokens to work with.
export function inputBudget(contextWindow: number): number {
  return Math.max(contextWindow - MAX_OUTPUT - SAFETY, 8_000);
}

// ── Token estimation ────────────────────────────────────────────────────────────
// Per-content-type estimation, more accurate than a flat chars/4 guess. Tool calls
// include their JSON structure overhead; tool results are often large blobs that
// compress well.

/** Rough token guess from character count (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for a single message, accounting for role overhead + content type. */
export function estimateMessageTokens(msg: OpenAI.ChatCompletionMessageParam): number {
  // Base overhead: role marker + structural JSON wrapping
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

  // Tool calls carry name + args as JSON
  if ("tool_calls" in msg && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls as any[]) {
      tokens += estimateTokens(tc.function?.name ?? "");
      tokens += estimateTokens(tc.function?.arguments ?? "");
      tokens += 8; // structural overhead per call
    }
  }

  return tokens;
}

/** Size of the whole history. Per-message estimation instead of flat JSON.stringify. */
export function countMessages(messages: OpenAI.ChatCompletionMessageParam[]): number {
  return messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
}

export function overBudget(messages: OpenAI.ChatCompletionMessageParam[], budget: number): boolean {
  return countMessages(messages) > budget;
}

// ── Tier 1: Micro-compact (truncate stale tool results) ─────────────────────────
// Before touching the conversation structure, shrink the biggest offenders: large
// tool results from old turns. Keep the most recent N tool exchanges intact (the
// model's working memory), truncate the rest to a fingerprint. This mirrors the
// INTERNAL harness's microCompact approach.

const TOOL_RESULT_KEEP_RECENT = 6;   // keep the last 6 tool results verbatim
const TOOL_RESULT_MAX_CHARS = 800;   // truncated results keep this many chars
const TOOL_RESULT_SUMMARY_SUFFIX =
  "\n…[output truncated to save context — re-read the file if you need the full content]";

/**
 * Identifies which tools are "compactable" — read/search/exec tools whose output
 * is often large and expendable after the model has already reasoned over it.
 */
const COMPACTABLE_TOOLS = new Set([
  "read_file", "run_bash", "grep", "glob", "write_file", "edit_file",
]);

/**
 * Micro-compact: truncate large tool results from older turns, keeping the most
 * recent ones intact. Returns the number of tokens freed (estimated).
 *
 * Works in-place on the message array. Preserves conversation structure —
 * no messages are removed, just their content is shortened.
 */
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

  // The last N are kept intact
  const keepSet = new Set(compactableIds.slice(-TOOL_RESULT_KEEP_RECENT));
  const truncateSet = new Set(compactableIds.filter(id => !keepSet.has(id)));

  if (truncateSet.size === 0) return 0;

  let tokensFreed = 0;

  for (const m of messages) {
    if (m.role !== "tool") continue;
    const toolMsg = m as OpenAI.ChatCompletionToolMessageParam;
    if (!truncateSet.has(toolMsg.tool_call_id)) continue;

    const content = typeof toolMsg.content === "string" ? toolMsg.content : "";
    if (content.length <= TOOL_RESULT_MAX_CHARS) continue; // already small

    const before = estimateTokens(content);
    toolMsg.content = content.slice(0, TOOL_RESULT_MAX_CHARS) + TOOL_RESULT_SUMMARY_SUFFIX;
    const after = estimateTokens(toolMsg.content);
    tokensFreed += before - after;
  }

  return tokensFreed;
}

// ── Tier 2: LLM-based summarization ────────────────────────────────────────────
// Instead of blindly dropping the middle, ask the model to produce a structured
// summary. The prompt mirrors the INTERNAL harness's compact/prompt.ts — nine
// sections covering intent, files, errors, pending tasks, and current work.

/** The compaction prompt the model receives to summarize the conversation. */
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

/**
 * Format the raw compact summary — strip <analysis> (it's a drafting aid),
 * extract the <summary> body, and prepend the session-continuation header.
 */
export function formatCompactSummary(raw: string): string {
  // Strip the analysis scratchpad
  let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();

  // Extract the summary body
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (match) text = match[1]!.trim();

  // Clean up excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  return `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\n${text}\n\nIf you need specific details from before compaction (exact code, errors, content), re-read the relevant files.`;
}

// ── Tier 3: Hard-drop (emergency fallback) ──────────────────────────────────────
// How many of the most recent messages to always keep — the agent's short-term
// working memory. This is the fallback when LLM summarization isn't available.
const KEEP_TAIL = 8;

/**
 * Emergency hard-drop: keep the system prompt (index 0), the goal (index 1),
 * and the last few turns; drop the stale middle. A tool result must stay with
 * the assistant call that produced it, so the kept tail never starts on a `tool`
 * message. This is the fallback when LLM summarization isn't used.
 */
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
// Called by the agent loop when context pressure builds. Returns a description of
// what was done so the UI can inform the user.

export type CompactionResult = {
  tier: "none" | "micro" | "summary" | "drop";
  tokensFreed: number;
  description: string;
};

/**
 * Try to relieve context pressure using the cheapest effective tier:
 *  1. Micro-compact: truncate old tool results (free, no LLM call)
 *  2. Summary (handled by agent.ts by calling the LLM with COMPACT_PROMPT)
 *  3. Hard-drop: last resort middle-removal
 *
 * This function handles tiers 1 and 3 synchronously. Tier 2 (LLM summarization)
 * is orchestrated by agent.ts since it requires a model call.
 */
export function compact(messages: OpenAI.ChatCompletionMessageParam[], budget?: number): CompactionResult {
  const used = countMessages(messages);
  const b = budget ?? Infinity;

  // Under budget — no compaction needed
  if (used <= b * MICRO_COMPACT_THRESHOLD) {
    return { tier: "none", tokensFreed: 0, description: "" };
  }

  // Tier 1: micro-compact stale tool results
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

  // Tier 1 first even at higher pressure — it's free
  const microFreed = microCompact(messages);
  const afterMicro = countMessages(messages);

  // If micro-compact brought us back under the summarize threshold, stop
  if (afterMicro <= b * SUMMARIZE_THRESHOLD) {
    return {
      tier: "micro",
      tokensFreed: microFreed,
      description: `truncated old tool outputs (~${microFreed} tokens freed)`,
    };
  }

  // Tier 2 is signaled to the caller — they should try LLM summarization.
  // If we're not yet at the hard-drop threshold, return a signal.
  if (afterMicro <= b * HARD_DROP_THRESHOLD) {
    return {
      tier: "summary",
      tokensFreed: microFreed,
      description: "context pressure high — LLM summarization recommended",
    };
  }

  // Tier 3: emergency hard-drop
  const dropped = hardDrop(messages);
  return {
    tier: "drop",
    tokensFreed: microFreed + dropped * 200, // rough estimate per dropped message
    description: `emergency: dropped ${dropped} old messages from the middle`,
  };
}

// ── Backward-compatible alias ───────────────────────────────────────────────────
// The old compact() returned just a number. Keep agent.ts's existing call site
// working during transition by also exporting the old shape.

/** @deprecated Use the new tiered `compact()` and inspect `.tier`. */
export function compactLegacy(messages: OpenAI.ChatCompletionMessageParam[]): number {
  return hardDrop(messages);
}
