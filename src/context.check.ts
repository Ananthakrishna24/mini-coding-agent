// Offline self-check for context accounting — no model/network. Run: npm run check:context
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { estimateTokens, countMessages, overBudget, INPUT_BUDGET } from "./context";

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
assert.equal(overBudget(small), false);

// a giant message trips the budget
const huge: OpenAI.ChatCompletionMessageParam[] = [
  { role: "user", content: "x".repeat(INPUT_BUDGET * 4 + 4) },
];
assert.equal(overBudget(huge), true);

console.log("ok — context self-check passed");
