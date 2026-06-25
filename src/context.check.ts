// Offline self-check for context accounting — no model/network. Run: npm run check:context
import assert from "node:assert/strict";
import type OpenAI from "openai";
import {
  estimateTokens,
  estimateMessageTokens,
  countMessages,
  overBudget,
  compact,
  inputBudget,
  microCompact,
  hardDrop,
  formatCompactSummary,
} from "./context";

const BUDGET = inputBudget(1_048_576); // a concrete window to exercise the budget math against

// ── estimateTokens ──────────────────────────────────────────────────────────────
assert.equal(estimateTokens(""), 0);
assert.equal(estimateTokens("abcd"), 1);
assert.equal(estimateTokens("abcde"), 2);

// ── estimateMessageTokens (per-content-type estimation) ─────────────────────────
const textMsg: OpenAI.ChatCompletionMessageParam = { role: "user", content: "hello world" };
assert.ok(estimateMessageTokens(textMsg) > 0, "text message has tokens");

const toolCallMsg: OpenAI.ChatCompletionMessageParam = {
  role: "assistant",
  content: null,
  tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"src/index.ts"}' } }],
};
const tcTokens = estimateMessageTokens(toolCallMsg);
assert.ok(tcTokens > 8, "tool call message includes name + args overhead");

// ── countMessages ───────────────────────────────────────────────────────────────
assert.equal(countMessages([]), 0);

const small: OpenAI.ChatCompletionMessageParam[] = [
  { role: "system", content: "you are a coding agent" },
  { role: "user", content: "list the files" },
];
assert.ok(countMessages(small) > 0);
assert.equal(overBudget(small, BUDGET), false);

const huge: OpenAI.ChatCompletionMessageParam[] = [
  { role: "user", content: "x".repeat(BUDGET * 4 + 4) },
];
assert.equal(overBudget(huge, BUDGET), true);

// the budget never goes negative on a tiny window — it floors instead
assert.ok(inputBudget(1000) >= 8_000, "tiny window floors the budget");

// ── microCompact (Tier 1) ───────────────────────────────────────────────────────
// Build a history with 10 tool exchanges, each with a large result
const mcMessages: OpenAI.ChatCompletionMessageParam[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "the goal" },
];
for (let i = 0; i < 10; i++) {
  mcMessages.push({
    role: "assistant",
    content: null,
    tool_calls: [{ id: `mc${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
  });
  mcMessages.push({
    role: "tool",
    tool_call_id: `mc${i}`,
    content: "x".repeat(5000), // large tool results
  });
}

const beforeMicro = countMessages(mcMessages);
const mcFreed = microCompact(mcMessages);
const afterMicro = countMessages(mcMessages);
assert.ok(mcFreed > 0, "micro-compact freed tokens");
assert.ok(afterMicro < beforeMicro, "history is smaller after micro-compact");
assert.equal(mcMessages.length, 22, "micro-compact doesn't remove messages, only truncates");

// Recent tool results should be untouched
const lastToolResult = mcMessages[mcMessages.length - 1];
assert.equal(lastToolResult.role, "tool");
assert.equal(typeof lastToolResult.content, "string");
assert.ok((lastToolResult.content as string).length >= 5000, "recent tool result is preserved");

// Older tool results should be truncated
const oldToolResult = mcMessages[3]; // first tool result
assert.ok((oldToolResult.content as string).length < 5000, "old tool result was truncated");

// ── hardDrop (Tier 3 / legacy compact) ──────────────────────────────────────────
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
long.push({ role: "assistant", content: "done" });

const before = long.length;
const removed = hardDrop(long);
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
assert.equal(hardDrop(shortHist), 0);
assert.equal(shortHist.length, 3);

// ── compact (tiered orchestrator) ───────────────────────────────────────────────
// Under-budget messages should not be compacted
const lowPressure: OpenAI.ChatCompletionMessageParam[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
];
const lowResult = compact(lowPressure, 100_000);
assert.equal(lowResult.tier, "none", "low-pressure → no compaction");

// ── formatCompactSummary ────────────────────────────────────────────────────────
const rawSummary = `<analysis>
thinking about the conversation...
</analysis>

<summary>
1. Primary Request: Build a web app
2. Key Concepts: React, TypeScript
</summary>`;

const formatted = formatCompactSummary(rawSummary);
assert.ok(!formatted.includes("<analysis>"), "analysis block stripped");
assert.ok(!formatted.includes("</analysis>"), "analysis closing tag stripped");
assert.ok(!formatted.includes("<summary>"), "summary tags stripped");
assert.ok(formatted.includes("Primary Request"), "summary content preserved");
assert.ok(formatted.includes("continued from a previous conversation"), "continuation header added");

console.log("ok — context self-check passed (with tiered compaction + micro-compact)");
