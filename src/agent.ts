// The agent loop: call the model with tools, run any tool calls, feed results back, repeat
// until the model finishes (final_answer or plain reply), stalls out, or hits the turn ceiling.
import { readFileSync } from "node:fs";
import type OpenAI from "openai";
import { chat, getContextWindow } from "./llm";
import { schemasFor, dispatch, parseFinalAnswer, canSpawn, MAX_DEPTH, MAX_FANOUT, parseSpawnArgs, formatSubResult, type SpawnArgs, type RunResult } from "./tools";
import { countMessages, overBudget, compact, inputBudget } from "./context";
import { getModelPolicy, setModelPolicy } from "./model_policy";
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

// A UI that swallows a subagent's live chatter — used when several subagents run in parallel, where
// interleaved per-tool output from all of them would be unreadable. The parent still shows each child's
// start and its ✓/✗ result; warnings pass through so failures aren't silent.
const quietUI = (ui: UI): UI => ({
  thinking: () => {},
  thought: () => {},
  enterSubagent: () => {},
  exitSubagent: () => {},
  tool: () => {},
  warn: ui.warn,
  debug: () => {},
  startRun: () => {},
  endRun: () => {},
  setModelLabel: () => {},
  context: () => {},
  usage: () => {},
  requestModelPolicy: async () => "parent",
});

// `depth` is the delegation level: 0 = the top agent, ≥1 = a subagent. It scopes whether the run may
// delegate again (bounded by MAX_DEPTH) and is incremented on each spawn. Callers run normally by
// omitting it. `history` is the live message array for an ongoing session: pass the same one across
// turns and the model sees the whole conversation. Omit it (one-shots) for a clean context. `opts`
// overrides the model/effort for this run — a subagent assigned a different model passes it. The system
// prompt is built once, on the first turn, so the cacheable head stays byte-identical.
export async function run(
  goal: string | OpenAI.ChatCompletionContentPart[],
  ui: UI,
  depth = 0,
  history?: OpenAI.ChatCompletionMessageParam[],
  opts?: { model?: string; effort?: string | null },
): Promise<RunResult> {
  const messages: OpenAI.ChatCompletionMessageParam[] = history ?? [];
  if (messages.length === 0) messages.push({ role: "system", content: buildSystemPrompt() });
  messages.push({ role: "user", content: goal });

  const schemas = schemasFor(depth); // depth gates whether this run is offered spawn_agent
  const seen = new Map<string, number>(); // tool-call signature -> times seen this run; catches no-progress loops
  const subSessions = new Map<string, OpenAI.ChatCompletionMessageParam[]>(); // child histories kept for resume
  let subCounter = 0; // names this run's subagents (sub-1, sub-2, …)
  let stall = 0; // consecutive turns with no real progress; trips STALL_LIMIT before MAX_TURNS

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    ui.thinking(true, thinkingVerb());
    const t0 = Date.now();
    const res = await chat(messages, schemas, opts);
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
    const calls = msg.tool_calls;
    // Several spawn_agent calls in one turn run concurrently; when there's more than one, each child
    // reports through a quiet UI so their tool output doesn't interleave into noise. A lone spawn keeps
    // the live nested view. Independent subagents finish in the slowest one's time, not the sum.
    const spawnCount = calls.filter((c) => c.type === "function" && c.function.name === "spawn_agent").length;
    const parallel = spawnCount > 1;
    const childUI = parallel ? quietUI(ui) : ui;

    // First delegation of a session: ask the user once, here, before any subagent runs, how subagents
    // should pick a model. The run pauses on the overlay until answered. Only the top agent asks (a
    // subagent has no user); the choice is then read at every depth when launching a child.
    if (depth === 0 && spawnCount > 0 && getModelPolicy() === null) {
      setModelPolicy(await ui.requestModelPolicy());
    }
    const allowCustomModel = getModelPolicy() === "auto"; // "parent" ignores the agent's per-task model picks

    // One result slot per call, filled in call order even though spawns finish out of order — every
    // tool_call needs its matching result, and the result order must line up or the next request fails.
    const results: (string | null)[] = new Array(calls.length).fill(null);
    const pending: Promise<void>[] = []; // in-flight subagent runs
    let terminal: RunResult | null = null; // set by final_answer or a repeat-stop; ends the run after this turn
    let fanout = 0;

    for (let idx = 0; idx < calls.length; idx++) {
      const call = calls[idx];
      if (call.type !== "function") {
        results[idx] = `error: unsupported tool call type '${call.type}'`;
        continue;
      }

      // No-progress guard: identical call (name + args) repeated = the model is stuck. Stop cheaply
      // instead of feeding the loop turns until MAX_TURNS.
      const sig = `${call.function.name}(${call.function.arguments})`;
      const count = (seen.get(sig) ?? 0) + 1;
      seen.set(sig, count);
      if (count >= REPEAT_LIMIT) {
        const stop = `stopped: repeated ${call.function.name} with the same arguments ${count}×`;
        results[idx] = stop;
        terminal = { success: false, summary: stop };
        break;
      }

      // Terminal signal. A valid payload ends the run with structured data; a malformed one comes back
      // as an error so the model can correct the shape. Truncated args fail JSON.parse and take that path.
      if (call.function.name === "final_answer") {
        try {
          terminal = parseFinalAnswer(call.function.arguments);
          results[idx] = "ok";
          break;
        } catch (e: any) {
          results[idx] = `error: ${e.message}`;
          continue;
        }
      }

      // Delegation. Intercepted, not dispatched: running it recurses into run() with depth + 1. The
      // subagent works in its own message array, kept in subSessions so the parent can resume it later;
      // only its summary crosses back. A throwing child becomes a failure result, never a crash.
      if (call.function.name === "spawn_agent") {
        if (!canSpawn(depth)) {
          const blocked = `error: blocked: subagent depth limit (${MAX_DEPTH}) reached — do this part yourself`;
          results[idx] = blocked;
          ui.tool(call.function.name, call.function.arguments, blocked);
          continue;
        }
        let sa: SpawnArgs;
        try {
          sa = parseSpawnArgs(call.function.arguments);
        } catch (e: any) {
          results[idx] = `error: ${e.message}`;
          continue;
        }
        if (++fanout > MAX_FANOUT) {
          results[idx] = `error: too many subagents at once (limit ${MAX_FANOUT}) — spawn fewer or do some yourself`;
          continue;
        }
        const subHistory = sa.resume_id ? subSessions.get(sa.resume_id) : [];
        if (sa.resume_id && !subHistory) {
          results[idx] = `error: no subagent session "${sa.resume_id}" to resume in this run`;
          continue;
        }
        const id = sa.resume_id ?? `sub-${++subCounter}`;
        const subModel = allowCustomModel ? sa.model : undefined; // "parent" policy → ignore the requested model
        const subEffort = allowCustomModel ? sa.effort ?? null : null;
        if (!parallel) ui.enterSubagent(subModel ? `${sa.goal}  ·  ${subModel}` : sa.goal);
        progressed = true; // a delegation is real work, even if it ultimately fails
        const i = idx;
        const args = call.function.arguments;
        pending.push(
          (async () => {
            let sub: RunResult;
            try {
              sub = await run(sa.goal, childUI, depth + 1, subHistory!, { model: subModel, effort: subEffort });
            } catch (e: any) {
              sub = { success: false, summary: `subagent crashed: ${e.message ?? e}` };
            }
            subSessions.set(id, subHistory!);
            const out = formatSubResult(sub, id);
            if (parallel) ui.tool("spawn_agent", args, out); // render as a completed entry; no live nesting
            else ui.exitSubagent(out);
            results[i] = out;
          })(),
        );
        continue;
      }

      ui.thinking(true, toolVerb(call.function.name));
      const result = await dispatch(call.function.name, call.function.arguments);
      ui.thinking(false);
      results[idx] = result;
      ui.tool(call.function.name, call.function.arguments, result);
      if (count === 1 && !result.startsWith("error:") && PROGRESS_TOOLS.has(call.function.name)) {
        progressed = true;
      }
    }

    if (parallel) ui.thinking(true, `running ${spawnCount} subagents`);
    await Promise.allSettled(pending); // wait for all subagents; allSettled means one failing can't abandon the rest
    if (parallel) ui.thinking(false);

    // Every tool_call gets its matching result, in call order.
    for (let idx = 0; idx < calls.length; idx++) {
      messages.push({ role: "tool", tool_call_id: calls[idx].id, content: results[idx] ?? "error: tool call not processed" });
    }
    if (terminal) return terminal;

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
