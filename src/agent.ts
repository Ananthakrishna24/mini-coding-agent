// The agent loop: call the model with tools, run any tool calls, feed results back, repeat
// until the model stops calling tools or we hit the turn limit.
import type OpenAI from "openai";
import { chat } from "./llm";
import { toolSchemas, dispatch } from "./tools";
import { countMessages, overBudget, compact, INPUT_BUDGET } from "./context";

const MAX_TURNS = 12; // outer backstop for messy loops the signature guard can't catch
const REPEAT_LIMIT = 3; // 3rd identical tool call (same name + args) = stuck; retrying won't help

// Standing orders. Fixed block first, environment last: an identical prefix is what lets the
// provider cache it across turns, and the cache match stops at the first byte that differs.
function buildSystemPrompt(): string {
  const rules = [
    "You are a coding agent working inside a project directory.",
    "Read a file before you edit it; prefer small, targeted edits over full rewrites.",
    "After changing code, run the relevant check or test.",
    "Stay inside the workspace. Don't delete or overwrite a file without a clear reason.",
    "When the task is done, reply with a short summary and stop calling tools.",
  ].join("\n");

  const env = [
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`, // date, not time — a clock would bust the cache
  ].join("\n");

  return `${rules}\n\n## Environment\n${env}`;
}

export async function run(goal: string): Promise<string> {
  // Built once, never touched during the run, so the head stays byte-identical = cacheable.
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: goal },
  ];

  const seen = new Map<string, number>(); // tool-call signature -> times seen this run; catches no-progress loops

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await chat(messages, toolSchemas);
    const choice = res.choices?.[0];
    if (!choice) throw new Error("model returned no choices");
    const msg = choice.message;
    messages.push(msg);

    // Output hit the token cap mid-reply — don't treat a cut-off answer as a finished one.
    if (choice.finish_reason === "length") {
      console.warn("  ! model output truncated (hit max output tokens)");
    }

    if (!msg.tool_calls?.length) return msg.content ?? "(no output)";

    for (const call of msg.tool_calls) {
      // Every tool_call must get a matching tool result or the next request is rejected —
      // even ones we can't run. A skipped call still needs its tombstone.
      if (call.type !== "function") {
        messages.push({ role: "tool", tool_call_id: call.id, content: `error: unsupported tool call type '${call.type}'` });
        continue;
      }

      // No-progress guard: identical call (name + args) repeated = the model is stuck. Stop cheaply
      // instead of feeding the loop turns until MAX_TURNS. Still push a result so the history stays valid.
      const sig = `${call.function.name}(${call.function.arguments})`;
      const count = (seen.get(sig) ?? 0) + 1;
      seen.set(sig, count);
      if (count >= REPEAT_LIMIT) {
        const stop = `stopped: repeated ${call.function.name} with the same arguments ${count}×`;
        messages.push({ role: "tool", tool_call_id: call.id, content: stop });
        return stop;
      }

      const result = await dispatch(call.function.name, call.function.arguments);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
      const preview = result.slice(0, 100).replace(/\s+/g, " ");
      console.log(`  · ${call.function.name}(${call.function.arguments}) -> ${preview}`);
    }

    // Watch context size. Real usage is ground truth; our estimate decides when to act later.
    const used = countMessages(messages);
    const actual = res.usage?.prompt_tokens;
    console.log(`  ~ context: ~${used} est${actual ? ` / ${actual} actual` : ""} of ${INPUT_BUDGET} budget`);
    if (overBudget(messages)) {
      const dropped = compact(messages);
      console.warn(`  ! over budget — trimmed ${dropped} old messages from the middle`);
    }
  }

  return `stopped: hit ${MAX_TURNS}-turn limit`;
}
