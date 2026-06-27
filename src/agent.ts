// The agent loop: calls the model, executes tools, and manages context compaction.
import { readFileSync } from "node:fs";
import type OpenAI from "openai";
import { chat, getContextWindow, getProvider } from "./llm";
import { schemasFor, dispatch, parseFinalAnswer, canSpawn, MAX_DEPTH, MAX_FANOUT, parseSpawnArgs, formatSubResult, type SpawnArgs, type RunResult } from "./tools";
import { countMessages, overBudget, compact, inputBudget, formatCompactSummary, COMPACT_PROMPT, microCompact, type CompactionResult } from "./context";
import { getModelPolicy, setModelPolicy } from "./model_policy";
import { loadMemory } from "./memory";
import { skillsPromptBlock } from "./skills";
import { thinkingVerb, toolVerb } from "./format";
import type { UI } from "./ui";

// Loop guards to prevent infinite runs, stalls, or tight loops.
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS) || 50;
const STALL_LIMIT = 5;
const REPEAT_LIMIT = 3;
const BARE_RESPONSE_LIMIT = 2;

// Tool calls that count as progress (reading or writing state).
const PROGRESS_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "run_bash",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
  "read_skill",
  "list_models",
]);

// Load system rules from prompts/system.md, with fallback for development.
let SYSTEM_RULES: string;
try {
  SYSTEM_RULES = ((await import("./prompts/system.md")) as { default: string }).default.trim();
} catch {
  SYSTEM_RULES = readFileSync(new URL("./prompts/system.md", import.meta.url), "utf8").trim();
}

// Load OpenAI-specific rules addendum.
let OPENAI_RULES: string;
try {
  OPENAI_RULES = ((await import("./prompts/system.openai.md")) as { default: string }).default.trim();
} catch {
  OPENAI_RULES = readFileSync(new URL("./prompts/system.openai.md", import.meta.url), "utf8").trim();
}

function buildSystemPrompt(): string {
  const env = [
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`, // date only to preserve prompt cache
  ].join("\n");

  // Load project memory/notes.
  const memory = loadMemory(process.cwd(), getContextWindow());
  // Apply provider-specific rules.
  const rules = getProvider() === "openai" ? `${SYSTEM_RULES}\n\n${OPENAI_RULES}` : SYSTEM_RULES;
  // Include skills index if present.
  const skills = skillsPromptBlock();
  // Return the combined system prompt, wrapping dynamic values in XML tags.
  return `${rules}${skills ? `\n\n${skills}` : ""}\n\n<environment>\n${env}\n</environment>${memory ? `\n\n${memory}` : ""}`;
}

function contentText(content: OpenAI.ChatCompletionMessageParam["content"] | null | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join(" ")
    .trim();
}

function clipText(s: string, max = 240): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

// Quiet UI wrapper that suppresses subagent output when running in parallel.
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

// Main agent run loop.
export async function run(
  goal: string | OpenAI.ChatCompletionContentPart[],
  ui: UI,
  depth = 0,
  history?: OpenAI.ChatCompletionMessageParam[],
  opts?: { model?: string; effort?: string | null; signal?: AbortSignal },
): Promise<RunResult> {
  const messages: OpenAI.ChatCompletionMessageParam[] = history ?? [];
  if (messages.length === 0) messages.push({ role: "system", content: buildSystemPrompt() });
  messages.push({ role: "user", content: goal });

  const schemas = schemasFor(depth); // depth gates spawning capability
  const seen = new Map<string, number>(); // signature -> count to detect loops
  const subSessions = new Map<string, OpenAI.ChatCompletionMessageParam[]>();
  let subCounter = 0;
  let stall = 0; // turns without progress
  let bareResponses = 0; // assistant messages that violated the final_answer/tool protocol

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (opts?.signal?.aborted) {
      return { success: false, summary: "Interrupted by user" };
    }
    ui.thinking(true, thinkingVerb());
    const t0 = Date.now();
    let res;
    try {
      res = await chat(messages, schemas, opts);
    } catch (e: any) {
      if (opts?.signal?.aborted || e.name === "AbortError" || e.message === "The user aborted a request.") {
        return { success: false, summary: "Interrupted by user" };
      }
      throw e;
    }
    ui.thinking(false);
    const choice = res.choices?.[0];
    if (!choice) throw new Error("model returned no choices");
    const msg = choice.message;
    messages.push(msg);

    // Render reasoning duration if available (e.g. from OpenRouter).
    const reasoning = (msg as any).reasoning;
    if (typeof reasoning === "string" && reasoning.trim()) ui.thought(Math.round((Date.now() - t0) / 1000));

    // Warn if the completion was truncated.
    if (choice.finish_reason === "length") {
      ui.warn("model output truncated (hit max output tokens)");
    }

    // A bare assistant message is not a clean terminal state; ask once for the required final_answer
    // call so simple Q&A can still recover, then fail clearly instead of returning a false success.
    if (!msg.tool_calls?.length) {
      const text = contentText(msg.content);
      if (++bareResponses >= BARE_RESPONSE_LIMIT) {
        return {
          success: false,
          summary: `stopped: model replied without calling final_answer${text ? ` — last reply: ${clipText(text)}` : ""}`,
        };
      }
      messages.push({
        role: "user",
        content:
          "You replied without calling any tool. If the task is complete, call final_answer now with success and a short summary. " +
          "If work remains, call the appropriate tool instead of replying in prose.",
      });
      continue;
    }
    bareResponses = 0;

    let progressed = false; // tracks if any progress-marked tool was run successfully
    const calls = msg.tool_calls;
    // Concurrent subagents use a quiet UI to prevent interleaved console noise.
    const spawnCount = calls.filter((c) => c.type === "function" && c.function.name === "spawn_agent").length;
    const parallel = spawnCount > 1;
    const childUI = parallel ? quietUI(ui) : ui;

    // Prompt the user for model selection policy on first spawn.
    if (depth === 0 && spawnCount > 0 && getModelPolicy() === null) {
      setModelPolicy(await ui.requestModelPolicy());
    }
    const allowCustomModel = getModelPolicy() === "auto";

    // Map of results aligned with tool calls order.
    const results: (string | null)[] = new Array(calls.length).fill(null);
    const pending: Promise<void>[] = []; // in-flight subagent runs
    let terminal: RunResult | null = null; // set by final_answer or a repeat-stop; ends the run after this turn
    let fanout = 0;

    for (let idx = 0; idx < calls.length; idx++) {
      if (opts?.signal?.aborted) {
        return { success: false, summary: "Interrupted by user" };
      }
      const call = calls[idx];
      if (call.type !== "function") {
        results[idx] = `error: unsupported tool call type '${call.type}'`;
        continue;
      }

      // Stop if identical tool call is repeated.
      const sig = `${call.function.name}(${call.function.arguments})`;
      const count = (seen.get(sig) ?? 0) + 1;
      seen.set(sig, count);
      if (count >= REPEAT_LIMIT) {
        const stop = `stopped: repeated ${call.function.name} with the same arguments ${count}×`;
        results[idx] = stop;
        terminal = { success: false, summary: stop };
        break;
      }

      // Terminate run on final_answer.
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

      // Recursively spawn subagent.
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
        const subModel = allowCustomModel ? sa.model : undefined;
        const subEffort = allowCustomModel ? sa.effort ?? null : null;
        if (!parallel) ui.enterSubagent(subModel ? `${sa.goal}  ·  ${subModel}` : sa.goal);
        progressed = true;
        const i = idx;
        const args = call.function.arguments;
        pending.push(
          (async () => {
            let sub: RunResult;
            try {
              sub = await run(sa.goal, childUI, depth + 1, subHistory!, { model: subModel, effort: subEffort, signal: opts?.signal });
            } catch (e: any) {
              sub = { success: false, summary: `subagent crashed: ${e.message ?? e}` };
            }
            subSessions.set(id, subHistory!);
            const out = formatSubResult(sub, id);
            if (parallel) ui.tool("spawn_agent", args, out);
            else ui.exitSubagent(out);
            results[i] = out;
          })(),
        );
        continue;
      }

      if (opts?.signal?.aborted) {
        return { success: false, summary: "Interrupted by user" };
      }
      ui.thinking(true, toolVerb(call.function.name));
      let result;
      try {
        result = await dispatch(call.function.name, call.function.arguments, opts?.signal);
      } catch (e: any) {
        if (opts?.signal?.aborted || e.name === "AbortError") {
          return { success: false, summary: "Interrupted by user" };
        }
        throw e;
      }
      ui.thinking(false);
      results[idx] = result;
      ui.tool(call.function.name, call.function.arguments, result);
      if (opts?.signal?.aborted) {
        return { success: false, summary: "Interrupted by user" };
      }
      if (count === 1 && !result.startsWith("error:") && PROGRESS_TOOLS.has(call.function.name)) {
        progressed = true;
      }
    }

    if (parallel) ui.thinking(true, `running ${spawnCount} subagents`);
    await Promise.allSettled(pending); // Wait for all subagents to finish.
    if (parallel) ui.thinking(false);

    if (opts?.signal?.aborted) {
      return { success: false, summary: "Interrupted by user" };
    }

    // Append tool results to history.
    for (let idx = 0; idx < calls.length; idx++) {
      messages.push({ role: "tool", tool_call_id: calls[idx].id, content: results[idx] ?? "error: tool call not processed" });
    }
    if (terminal) return terminal;

    // Stall guard: stop if no progress is made for several turns.
    if (progressed) stall = 0;
    else if (++stall >= STALL_LIMIT) {
      return { success: false, summary: `stopped: no progress in ${STALL_LIMIT} turns — the model looks stuck` };
    }

    // Track and report context usage.
    const budget = inputBudget(getContextWindow());
    const used = countMessages(messages);
    const actual = res.usage?.prompt_tokens;
    ui.context(actual ?? used, budget);
    if (res.usage) ui.usage(res.usage.prompt_tokens ?? 0, res.usage.completion_tokens ?? 0);
    ui.debug(`context: ~${used} est${actual ? ` / ${actual} actual` : ""} of ${budget} budget`);

    // ── Tiered compaction ────────────────────────────────────────────────────
    // Compaction runs before exceeding budget:
    // - micro (75%): truncate old tool output
    // - summary (90%): LLM summarizes history
    // - drop (98%): emergency message drop
    const compaction = compact(messages, budget);
    if (compaction.tier === "micro") {
      ui.debug(`micro-compact: ${compaction.description}`);
    } else if (compaction.tier === "summary") {
      ui.debug(`context pressure high — running LLM summarization`);
      try {
        ui.thinking(true, "compacting context");
        const summaryRes = await chat(
          [
            messages[0], // system prompt
            ...messages.slice(1),
            { role: "user", content: COMPACT_PROMPT },
          ],
          undefined,
          opts,
        );
        ui.thinking(false);
        const rawSummary = summaryRes.choices?.[0]?.message?.content ?? "";
        if (rawSummary.trim()) {
          const formattedSummary = formatCompactSummary(rawSummary);
          // Replace intermediate history with the summary.
          const keepTail = Math.min(8, messages.length - 2);
          const tail = messages.slice(-keepTail);
          messages.length = 1;
          messages.push({ role: "user", content: formattedSummary });
          messages.push(...tail);
          ui.warn(`context summarized — compressed ${compaction.description}`);
        }
      } catch (e: any) {
        ui.thinking(false);
        if (opts?.signal?.aborted || e.name === "AbortError" || e.message === "The user aborted a request.") {
          return { success: false, summary: "Interrupted by user" };
        }
        ui.debug(`summarization failed: ${e.message ?? e}`);
        if (overBudget(messages, budget)) {
          const result = compact(messages, budget);
          if (result.tier === "drop") {
            ui.warn(`emergency: ${result.description}`);
          }
        }
      }
    } else if (compaction.tier === "drop") {
      ui.warn(`${compaction.description}`);
    }
  }

  return { success: false, summary: `stopped: hit ${MAX_TURNS}-turn limit` };
}
