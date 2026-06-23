// spawn_agent: delegation. The model calls this to hand a self-contained, context-heavy subtask to a
// *fresh* run of the same loop — a subagent that works in its own message array and hands back only a
// one-line summary. The parent's context never sees the subagent's file reads, just the conclusion;
// that isolation is the whole point (a wide search reads twenty files in the child's context, the
// parent's history grows by one line).
//
// Like final_answer, this is *not* a dispatch-registry tool: running it needs the loop itself (to
// recurse), the live UI, and the current depth — all of which live in agent.ts. So the loop intercepts
// it by name and this file stays a pure leaf (schema + policy + validators), which also keeps the
// import graph acyclic (no agent.ts import here).
import type OpenAI from "openai";
import type { RunResult } from "./final_answer";

// Recursion floor. depth 0 = the top agent (may delegate); a subagent runs at depth 1 and may not
// delegate again, so a job can't fan out into an unbounded tree. Same shape as the loop's MAX_TURNS —
// a hard ceiling, overridable for the rare deep job. The child also simply isn't *offered* the
// spawn_agent schema (see schemasFor), so this check only ever fires on a hallucinated call.
export const MAX_DEPTH = Number(process.env.AGENT_MAX_DEPTH) || 1;
export const canSpawn = (depth: number): boolean => depth < MAX_DEPTH;

// What a subagent may touch: read-only tools only. An unsupervised loop with write/edit is a surprise
// editor no human approved — least privilege, the same instinct as the permissions layer. Both the
// schema list (the child isn't shown the rest) and dispatch's allow-set (a hallucinated write is
// blocked) enforce this.
// Read-only is the only role for now; thread an allow-set param through spawn_agent if a
// delegated task ever genuinely needs to write.
export const SUBAGENT_TOOLS = new Set(["read_file", "run_bash"]);

export const spawnAgentSchema: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "spawn_agent",
    description:
      "Delegate a self-contained, context-heavy subtask to a fresh read-only subagent and get back a " +
      "short summary of what it found — without filling your own context with how it found it. Good for " +
      "a wide search or an investigate-and-report task. The subagent cannot edit files and runs once to " +
      "completion; it can't ask you questions, so give it a complete, standalone goal. Don't delegate " +
      "trivial work (a single read) or anything that needs your current context.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "A complete, standalone instruction for the subagent — what to find or do, and what to report back.",
        },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
};

// Validate the delegation payload at the boundary (same rule as parseFinalAnswer): the model's args are
// untrusted and can arrive truncated or wrong-typed. Throws a fix-it message the model can correct.
export function parseSpawnArgs(argsJson: string): { goal: string } {
  let args: any;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    throw new Error("spawn_agent arguments were not valid JSON");
  }
  if (typeof args.goal !== "string" || args.goal.trim() === "") {
    throw new Error("spawn_agent: 'goal' must be a non-empty string");
  }
  return { goal: args.goal.trim() };
}

// Fold the subagent's structured result into the one-line string the parent reads as the tool result.
// Success/failure is explicit so the parent can react (retry, narrow, or do it itself) — a failed
// subagent is data, never a thrown error that crashes the parent run.
export function formatSubResult(r: RunResult): string {
  return r.success ? `✓ ${r.summary}` : `✗ subagent did not finish: ${r.summary}`;
}
