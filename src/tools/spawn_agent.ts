// spawn_agent: delegation. The model calls this to hand a self-contained subtask to a *fresh* run of
// the same loop — a subagent that works in its own message array and hands back only a short summary.
// The parent's context never sees the subagent's file reads, just the conclusion; that isolation is the
// whole point. Several spawn_agent calls in one turn run in parallel (see agent.ts), so independent work
// finishes in the time of the slowest piece instead of the sum.
//
// Like final_answer, this is *not* a dispatch-registry tool: running it needs the loop itself (to
// recurse), the live UI, and the current depth — all of which live in agent.ts. So the loop intercepts
// it by name and this file stays a pure leaf (schema + policy + validators), which keeps the import
// graph acyclic (no agent.ts import here).
import type OpenAI from "openai";
import type { RunResult } from "./final_answer";

// Recursion floor. depth 0 = the top agent; a subagent may delegate one more level (depth 1) and then
// the depth-2 grandchild may not, so a job can't fan out into an unbounded tree. Overridable for the
// rare deep job. The child also isn't *offered* the spawn_agent schema past the cap (see schemasFor),
// so the loop's check only ever fires on a hallucinated call.
export const MAX_DEPTH = Number(process.env.AGENT_MAX_DEPTH) || 2;
export const canSpawn = (depth: number): boolean => depth < MAX_DEPTH;

// Width cap: how many subagents one turn may launch at once. Parallelism makes over-spawning cheap to
// trigger and expensive to pay for — a confused model emitting twenty spawns would fire twenty
// concurrent runs. Calls past the cap come back as a result the model can recover from.
export const MAX_FANOUT = Number(process.env.AGENT_MAX_FANOUT) || 6;
export const canFanOut = (count: number): boolean => count <= MAX_FANOUT;

const EFFORTS = new Set(["low", "medium", "high"]);

export const spawnAgentSchema: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "spawn_agent",
    description:
      "Delegate a self-contained subtask to a fresh subagent that works in its own clean context and " +
      "reports back a short summary — keeping the detail out of your own context. Emit several " +
      "spawn_agent calls in one turn to run them in parallel, but only for INDEPENDENT subtasks " +
      "(parallel agents editing the same file will conflict). The subagent has the full toolset and can " +
      "delegate one level deeper itself. Give it a complete, standalone goal — it can't ask you " +
      "questions. Optionally pick a `model` (see list_models) and reasoning `effort` for it. If a " +
      "subagent reports it didn't finish, call spawn_agent again with its `resume_id` and a short " +
      "'continue…' goal to pick up where it left off.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "A complete, standalone instruction for the subagent — what to do and what to report back.",
        },
        model: {
          type: "string",
          description: "Optional model id to run this subagent on (from list_models). Omit to use the current model.",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Optional reasoning effort for the subagent's model.",
        },
        resume_id: {
          type: "string",
          description: "Resume an unfinished subagent from this run by its id; `goal` becomes the follow-up instruction.",
        },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
};

export type SpawnArgs = { goal: string; model?: string; effort?: string; resume_id?: string };

// Validate the delegation payload at the boundary: the model's args are untrusted and can arrive
// truncated or wrong-typed. Throws a fix-it message the model can correct.
export function parseSpawnArgs(argsJson: string): SpawnArgs {
  let args: any;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    throw new Error("spawn_agent arguments were not valid JSON");
  }
  if (typeof args.goal !== "string" || args.goal.trim() === "") {
    throw new Error("spawn_agent: 'goal' must be a non-empty string");
  }
  const out: SpawnArgs = { goal: args.goal.trim() };
  if (args.model != null) {
    if (typeof args.model !== "string" || !args.model.trim()) throw new Error("spawn_agent: 'model' must be a non-empty string when given");
    out.model = args.model.trim();
  }
  if (args.effort != null) {
    if (typeof args.effort !== "string" || !EFFORTS.has(args.effort)) throw new Error("spawn_agent: 'effort' must be low, medium, or high");
    out.effort = args.effort;
  }
  if (args.resume_id != null) {
    if (typeof args.resume_id !== "string" || !args.resume_id.trim()) throw new Error("spawn_agent: 'resume_id' must be a non-empty string when given");
    out.resume_id = args.resume_id.trim();
  }
  return out;
}

// Fold the subagent's structured result into the one-line string the parent reads as the tool result.
// Success/failure is explicit so the parent can react — and a failed subagent's id is surfaced so the
// parent can resume it (spawn_agent with resume_id). A failure is data, never a thrown error.
export function formatSubResult(r: RunResult, id: string): string {
  return r.success
    ? `✓ ${r.summary}`
    : `✗ subagent ${id} did not finish: ${r.summary} — call spawn_agent with resume_id "${id}" and a "continue" goal to resume it.`;
}
