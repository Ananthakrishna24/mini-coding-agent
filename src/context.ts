// Context accounting: estimate how big the message history is and whether it still fits.
// The window is shared between the input we send and the reply the model writes, so the
// usable input budget is the window minus a reserve for the output minus a safety margin.
import type OpenAI from "openai";

// deepseek/deepseek-v4-flash limits.
const CONTEXT_WINDOW = 1_048_576;
const MAX_OUTPUT = 65_536;
const SAFETY = 50_000;

export const INPUT_BUDGET = CONTEXT_WINDOW - MAX_OUTPUT - SAFETY;

// Rough token guess. We route to DeepSeek, whose tokenizer we don't ship, so ~4 chars/token
// is the pragmatic estimate — calibrate against res.usage.prompt_tokens if you want it tighter.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Size of the whole history. JSON.stringify catches role + content + tool_calls/args too.
export function countMessages(messages: OpenAI.ChatCompletionMessageParam[]): number {
  return messages.reduce((n, m) => n + estimateTokens(JSON.stringify(m)), 0);
}

export function overBudget(messages: OpenAI.ChatCompletionMessageParam[]): boolean {
  return countMessages(messages) > INPUT_BUDGET;
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
