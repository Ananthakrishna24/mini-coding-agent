// Offline self-check for context accounting — no model/network. Run: npm run check:context
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { estimateTokens, countMessages, overBudget, compact, inputBudget } from "./context";

const BUDGET = inputBudget(1_048_576); // a concrete window to exercise the budget math against

// estimate: ~4 chars per token, rounded up
assert.equal(estimateTokens(""), 0);
assert.equal(estimateTokens("abcd"), 1);
assert.equal(estimateTokens("abcde"), 2);

// empty history costs nothing
assert.equal(countMessages([]), 0);

// a small history is well under budget
const small: OpenAI.ChatCompletionMessageParam[] = [
  { role: "system", content: "you are a coding agent" },
  { role: "user", content: "list the files" },
];
assert.ok(countMessages(small) > 0);
assert.equal(overBudget(small, BUDGET), false);

// a giant message trips the budget
const huge: OpenAI.ChatCompletionMessageParam[] = [
  { role: "user", content: "x".repeat(BUDGET * 4 + 4) },
];
assert.equal(overBudget(huge, BUDGET), true);

// the budget never goes negative on a tiny window — it floors instead
assert.ok(inputBudget(1000) >= 8_000, "tiny window floors the budget");

// compact: keep system + goal + recent turns, drop the middle, never split a tool pair.
// Odd length puts a tool message on the naive cut line — compact must step past it.
const long: OpenAI.ChatCompletionMessageParam[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "the original goal" },
];
for (let i = 0; i < 10; i++) {
  long.push({
    role: "assistant",
    content: null,
    tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
  });
  long.push({ role: "tool", tool_call_id: `c${i}`, content: `result ${i}` });
}
long.push({ role: "assistant", content: "done" }); // odd length, non-tool tail end

const before = long.length;
const removed = compact(long);
assert.ok(removed > 0, "dropped some middle messages");
assert.ok(long.length < before, "history shrank");
assert.equal(long[0].role, "system", "system prompt survived");
assert.equal(long[1].content, "the original goal", "goal survived");
assert.notEqual(long[2].role, "tool", "kept tail never starts on an orphan tool result");

// every surviving tool result still has its assistant call before it
const calls = new Set<string>();
for (const m of long) {
  if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) calls.add(c.id);
  if (m.role === "tool") assert.ok(calls.has(m.tool_call_id), `tool ${m.tool_call_id} has its call`);
}

// a short history is left untouched
const shortHist: OpenAI.ChatCompletionMessageParam[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "goal" },
  { role: "assistant", content: "ok" },
];
assert.equal(compact(shortHist), 0);
assert.equal(shortHist.length, 3);

console.log("ok — context self-check passed");
