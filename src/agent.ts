// The agent loop: call the model with tools, run any tool calls, feed results back, repeat
// until the model stops calling tools or we hit the turn limit.
import { readFileSync } from "node:fs";
import type OpenAI from "openai";
import { chat } from "./llm";
import { toolSchemas, dispatch, parseFinalAnswer, type RunResult } from "./tools";
import { countMessages, overBudget, compact, INPUT_BUDGET } from "./context";
import type { UI } from "./ui";

const MAX_TURNS = 12; // outer backstop for messy loops the signature guard can't catch
const REPEAT_LIMIT = 3; // 3rd identical tool call (same name + args) = stuck; retrying won't help

// Standing orders live in prompts/system.md — editable without touching code, read once at startup.
// Fixed block first, environment last: an identical prefix is what lets the provider cache it across
// turns, and the cache match stops at the first byte that differs.
const SYSTEM_RULES = readFileSync(new URL("./prompts/system.md", import.meta.url), "utf8").trim();

function buildSystemPrompt(): string {
  const env = [
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`, // date, not time — a clock would bust the cache
  ].join("\n");

  return `${SYSTEM_RULES}\n\n## Environment\n${env}`;
}

export async function run(goal: string, ui: UI): Promise<RunResult> {
  // Built once, never touched during the run, so the head stays byte-identical = cacheable.
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: goal },
  ];

  const seen = new Map<string, number>(); // tool-call signature -> times seen this run; catches no-progress loops

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    ui.thinking(true);
    const res = await chat(messages, toolSchemas);
    ui.thinking(false);
    const choice = res.choices?.[0];
    if (!choice) throw new Error("model returned no choices");
    const msg = choice.message;
    messages.push(msg);

    // Output hit the token cap mid-reply — don't treat a cut-off answer as a finished one.
    if (choice.finish_reason === "length") {
      ui.warn("model output truncated (hit max output tokens)");
    }

    // Model stopped without calling final_answer — best-effort wrap of its prose so the caller still
    // gets a uniform result. The structured path below is the intended exit.
    if (!msg.tool_calls?.length) return { success: true, summary: msg.content ?? "(no output)" };

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
        return { success: false, summary: stop };
      }

      // Terminal signal. A valid payload ends the run with structured data; a malformed one comes
      // back as an error so the model can correct the shape (Task 4.1), backed by the repeat guard
      // above and MAX_TURNS below. Truncated args fail JSON.parse here and take the same correction path.
      if (call.function.name === "final_answer") {
        try {
          const answer = parseFinalAnswer(call.function.arguments);
          messages.push({ role: "tool", tool_call_id: call.id, content: "ok" });
          return answer;
        } catch (e: any) {
          messages.push({ role: "tool", tool_call_id: call.id, content: `error: ${e.message}` });
          continue;
        }
      }

      ui.thinking(true, call.function.name);
      const result = await dispatch(call.function.name, call.function.arguments);
      ui.thinking(false);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
      ui.tool(call.function.name, call.function.arguments, result);
    }

    // Watch context size. Real usage is ground truth; our estimate decides when to act later.
    const used = countMessages(messages);
    const actual = res.usage?.prompt_tokens;
    ui.debug(`context: ~${used} est${actual ? ` / ${actual} actual` : ""} of ${INPUT_BUDGET} budget`);
    if (overBudget(messages)) {
      const dropped = compact(messages);
      ui.warn(`over budget — trimmed ${dropped} old messages from the middle`);
    }
  }

  return { success: false, summary: `stopped: hit ${MAX_TURNS}-turn limit` };
}
