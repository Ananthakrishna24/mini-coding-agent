// Helper functions and schema for spawning subagents to delegate subtasks.
import type OpenAI from "openai";
import type { RunResult } from "./final_answer";

// Recursion floor limit.
export const MAX_DEPTH = Number(process.env.AGENT_MAX_DEPTH) || 2;
export const canSpawn = (depth: number): boolean => depth < MAX_DEPTH;

// Max concurrent subagents in a single turn.
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

// Validate the delegation payload arguments.
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

// Formats the subagent run result for the parent agent.
export function formatSubResult(r: RunResult, id: string): string {
  return r.success
    ? `✓ ${r.summary}`
    : `✗ subagent ${id} did not finish: ${r.summary} — call spawn_agent with resume_id "${id}" and a "continue" goal to resume it.`;
}

