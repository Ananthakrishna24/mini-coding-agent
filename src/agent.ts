// The agent loop: call the model with tools, run any tool calls, feed results back, repeat
// until the model finishes (final_answer or plain reply), stalls out, or hits the turn ceiling.
import { readFileSync } from "node:fs";
import type OpenAI from "openai";
import { chat, getContextWindow } from "./llm";
import { schemasFor, dispatch, parseFinalAnswer, canSpawn, MAX_DEPTH, SUBAGENT_TOOLS, parseSpawnArgs, formatSubResult, type RunResult } from "./tools";
import { countMessages, overBudget, compact, inputBudget } from "./context";
import { loadMemory } from "./memory";
import { thinkingVerb, toolVerb } from "./format";
import type { UI } from "./ui";

// Loop guards, outermost to innermost:
//  - MAX_TURNS: absolute ceiling so a run is always bounded (override with AGENT_MAX_TURNS). High on
//    purpose — it's a safety net, not the thing that should normally stop a run.
//  - STALL_LIMIT: consecutive turns with no real progress = the model is spinning, stop. This is the
//    real guard, so a long *productive* run keeps going and only a genuinely stuck one is cut.
//  - REPEAT_LIMIT: the same call (name + args) seen this many times = a tight loop, stop immediately.
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS) || 50;
const STALL_LIMIT = 5;
const REPEAT_LIMIT = 3;

// "Progress" = a new, non-erroring call to a tool that reads or changes the world. Re-running a call
// or only re-planning doesn't count, so a model that just spins its wheels still trips STALL_LIMIT.
const PROGRESS_TOOLS = new Set(["read_file", "write_file", "edit_file", "run_bash"]);

// Standing orders live in prompts/system.md — editable without touching code, read once at startup.
// Fixed block first, environment last: an identical prefix is what lets the provider cache it across
// turns, and the cache match stops at the first byte that differs.
// The published build inlines the prompt as a minified JS string (tsup `--loader .md=text`) so the
// dist ships no plaintext system.md; dev (tsx) can't load .md, so it falls back to reading the file.
// Cosmetic deterrent only — the prompt is sent to the LLM, so a proxy recovers it regardless.
let SYSTEM_RULES: string;
try {
  SYSTEM_RULES = ((await import("./prompts/system.md")) as { default: string }).default.trim();
} catch {
  SYSTEM_RULES = readFileSync(new URL("./prompts/system.md", import.meta.url), "utf8").trim();
}

function buildSystemPrompt(): string {
  const env = [
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`, // date, not time — a clock would bust the cache
  ].join("\n");

  // Changing-last block: environment (changes daily) then memory (changes whenever the agent edits its
  // notes) sit after the fixed rules, so the big cacheable prefix stays byte-identical across runs.
  // Empty when there's no AGENT.md, so a fresh project carries no dangling section.
  const memory = loadMemory();
  return `${SYSTEM_RULES}\n\n## Environment\n${env}${memory ? `\n\n${memory}` : ""}`;
}

// `depth` is the delegation level: 0 = the top agent, ≥1 = a subagent spawned by spawn_agent. It scopes
// the toolset (a subagent gets read-only tools and can't delegate again) and is incremented on each
// spawn so recursion is bounded. Callers run normally by omitting it.
// `history` is the live message array for an ongoing session: pass the same one across turns and the
// model sees the whole conversation, not just this turn. Omit it (subagents, one-shots) for a clean
// context. The system prompt is built once, on the first turn, so the cacheable head stays byte-identical.
export async function run(goal: string | OpenAI.ChatCompletionContentPart[], ui: UI, depth = 0, history?: OpenAI.ChatCompletionMessageParam[]): Promise<RunResult> {
  const messages: OpenAI.ChatCompletionMessageParam[] = history ?? [];
  if (messages.length === 0) messages.push({ role: "system", content: buildSystemPrompt() });
  messages.push({ role: "user", content: goal });

  const schemas = schemasFor(depth); // depth scopes what this run may call (a subagent is read-only)
  const allow = depth > 0 ? SUBAGENT_TOOLS : undefined; // enforced again at dispatch, not just by omission
  const seen = new Map<string, number>(); // tool-call signature -> times seen this run; catches no-progress loops
  let stall = 0; // consecutive turns with no real progress; trips STALL_LIMIT before MAX_TURNS

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    ui.thinking(true, thinkingVerb());
    const t0 = Date.now();
    const res = await chat(messages, schemas);
    ui.thinking(false);
    const choice = res.choices?.[0];
    if (!choice) throw new Error("model returned no choices");
    const msg = choice.message;
    messages.push(msg);

    // Reasoning models return their chain-of-thought in `reasoning` (an OpenRouter extension, not in the
    // SDK types). Surface it as a one-line "thought for Ns" — only when the model actually reasoned, so
    // non-reasoning models stay quiet. Times the whole call, not the reasoning span alone (no
    // streaming to separate them); switch to streamed deltas if that split ever matters.
    const reasoning = (msg as any).reasoning;
    if (typeof reasoning === "string" && reasoning.trim()) ui.thought(Math.round((Date.now() - t0) / 1000));

    // Output hit the token cap mid-reply — don't treat a cut-off answer as a finished one.
    if (choice.finish_reason === "length") {
      ui.warn("model output truncated (hit max output tokens)");
    }

    // Model stopped without calling final_answer — best-effort wrap of its prose so the caller still
    // gets a uniform result. The structured path below is the intended exit.
    if (!msg.tool_calls?.length) return { success: true, summary: msg.content ?? "(no output)" };

    let progressed = false; // did this turn do real, new work? a productive turn resets the stall counter
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

      // Delegation. Like final_answer this is intercepted, not dispatched: running it recurses into
      // run() with the live UI and depth — which only exist here. The subagent works in its own message
      // array (clean context) and only its summary crosses back, so the parent's history stays small.
      if (call.function.name === "spawn_agent") {
        if (!canSpawn(depth)) {
          // Defence-in-depth: a subagent isn't even shown this schema, so this only fires on a
          // hallucinated call. Refuse as a result the model can recover from — never recurse past the floor.
          const blocked = `error: blocked: subagent depth limit (${MAX_DEPTH}) reached — do this part yourself`;
          messages.push({ role: "tool", tool_call_id: call.id, content: blocked });
          ui.tool(call.function.name, call.function.arguments, blocked);
          continue;
        }
        let subGoal: string;
        try {
          subGoal = parseSpawnArgs(call.function.arguments).goal;
        } catch (e: any) {
          messages.push({ role: "tool", tool_call_id: call.id, content: `error: ${e.message}` });
          continue;
        }
        ui.enterSubagent(subGoal); // open the nested block; the child reports through the same ui, railed in
        // Its own context; only the summary returns. A subagent that throws (e.g. the model call fails
        // after retries) comes back as a failure result, never as an exception that kills the parent run.
        let sub: RunResult;
        try {
          sub = await run(subGoal, ui, depth + 1);
        } catch (e: any) {
          sub = { success: false, summary: `subagent crashed: ${e.message ?? e}` };
        }
        const out = formatSubResult(sub);
        ui.exitSubagent(out); // close the block with the ✓/✗ summary
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
        progressed = true; // a completed delegation is real work — don't count it toward the stall guard
        continue;
      }

      ui.thinking(true, toolVerb(call.function.name));
      const result = await dispatch(call.function.name, call.function.arguments, allow);
      ui.thinking(false);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
      ui.tool(call.function.name, call.function.arguments, result);

      // A first-time, non-erroring read/write/edit/bash call is real progress (re-runs and plan-only
      // turns don't count) — enough to clear the stall counter for this turn.
      if (count === 1 && !result.startsWith("error:") && PROGRESS_TOOLS.has(call.function.name)) {
        progressed = true;
      }
    }

    // Stall guard: too many barren turns in a row means the model is looping or stuck on something it
    // can't crack. Stop with a useful message instead of grinding all the way to MAX_TURNS.
    if (progressed) stall = 0;
    else if (++stall >= STALL_LIMIT) {
      return { success: false, summary: `stopped: no progress in ${STALL_LIMIT} turns — the model looks stuck` };
    }

    // Watch context size. Budget tracks the active model's window (switchable at runtime). Real usage
    // is ground truth; our estimate decides when to act later. Feed the % to the footer either way.
    const budget = inputBudget(getContextWindow());
    const used = countMessages(messages);
    const actual = res.usage?.prompt_tokens;
    ui.context(actual ?? used, budget);
    if (res.usage) ui.usage(res.usage.prompt_tokens ?? 0, res.usage.completion_tokens ?? 0); // feeds /usage
    ui.debug(`context: ~${used} est${actual ? ` / ${actual} actual` : ""} of ${budget} budget`);
    if (overBudget(messages, budget)) {
      const dropped = compact(messages);
      ui.warn(`over budget — trimmed ${dropped} old messages from the middle`);
    }
  }

  return { success: false, summary: `stopped: hit ${MAX_TURNS}-turn limit` };
}
