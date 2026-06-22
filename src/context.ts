// Context accounting: estimate how big the message history is and whether it still fits.
// The window is shared between the input we send and the reply the model writes, so the
// usable input budget is the window minus a reserve for the output minus a safety margin.
import type OpenAI from "openai";

// Reserve carved out of any model's window: room for the reply + a safety margin. The window itself
// is per-model now (passed in), since the model is switchable at runtime. Kept modest on purpose — an
// agent turn's reply is short (a tool call or a final answer), so a 64K output reserve would needlessly
// starve a small-window model; 16K + 8K leaves ~104K usable on a 128K model.
const MAX_OUTPUT = 16_000;
const SAFETY = 8_000;

// Usable input budget for a given context window — never below a small floor so a tiny-window model
// still leaves a few thousand tokens to work with rather than a negative budget.
export function inputBudget(contextWindow: number): number {
  return Math.max(contextWindow - MAX_OUTPUT - SAFETY, 8_000);
}

// Rough token guess. We route to DeepSeek, whose tokenizer we don't ship, so ~4 chars/token
// is the pragmatic estimate — calibrate against res.usage.prompt_tokens if you want it tighter.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Size of the whole history. JSON.stringify catches role + content + tool_calls/args too.
export function countMessages(messages: OpenAI.ChatCompletionMessageParam[]): number {
  return messages.reduce((n, m) => n + estimateTokens(JSON.stringify(m)), 0);
}

export function overBudget(messages: OpenAI.ChatCompletionMessageParam[], budget: number): boolean {
  return countMessages(messages) > budget;
}

// How many of the most recent messages to always keep — the agent's short-term working memory.
const KEEP_TAIL = 8;

// Shrink an over-budget history in place: keep the system prompt (index 0), the goal (index 1),
// and the last few turns; drop the stale middle. A tool result must stay with the assistant call
// that produced it, so the kept tail never starts on a `tool` message (that would orphan it).
// v1 drops the middle and leaves a one-line marker; summarizing it instead is the next step up.
export function compact(messages: OpenAI.ChatCompletionMessageParam[]): number {
  if (messages.length <= KEEP_TAIL + 2) return 0; // nothing safe to drop

  let cut = messages.length - KEEP_TAIL;
  while (cut < messages.length && messages[cut].role === "tool") cut++;
  if (cut <= 2) return 0; // tail reaches the head; nothing in the middle to drop

  const removed = cut - 2;
  messages.splice(2, removed, {
    role: "user",
    content: "[older turns were trimmed to stay within the context budget]",
  });
  return removed;
}
