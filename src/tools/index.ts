// Public surface of the tools layer. Model output is untrusted — dispatch validates and never throws.
//
// Add a tool: create ./<name>.ts exporting a `Tool`, import it here, and add it to `registry`.
// The registry key is the tool's name. That's the whole extension story.
import type OpenAI from "openai";
import type { Tool } from "./types";
import { check } from "../permissions";
import { read_file } from "./read_file";
import { write_file } from "./write_file";
import { edit_file } from "./edit_file";
import { run_bash } from "./run_bash";
import { update_plan } from "./update_plan";
import { finalAnswerSchema } from "./final_answer";
import { spawnAgentSchema, SUBAGENT_TOOLS, canSpawn } from "./spawn_agent";

const registry: Record<string, Tool> = { read_file, write_file, edit_file, run_bash, update_plan };

// Schemas to hand the model, scoped by run depth. The top agent (depth 0) sees the full toolset plus
// the spawn_agent delegation signal; a subagent (depth > 0) sees only the read-only tools and no
// spawn_agent, so delegation can't recurse and a child can't edit. final_answer rides in both — every
// run must be able to finish. final_answer and spawn_agent are terminal/loop signals the loop
// intercepts by name, so they're appended here for the model to see rather than living in the registry.
// The model-facing name of a tool schema. ChatCompletionTool is a union (function | custom); ours are
// all functions, so narrow before reading the name.
export const toolName = (s: OpenAI.ChatCompletionTool): string => (s.type === "function" ? s.function.name : "");

export function schemasFor(depth: number): OpenAI.ChatCompletionTool[] {
  // Write tools only for the top agent — a subagent is a read-only investigator. spawn_agent is offered
  // only while below the depth cap, so the schema (not just the loop's guard) stops recursion at the floor.
  const base = Object.values(registry)
    .filter((t) => depth === 0 || SUBAGENT_TOOLS.has(toolName(t.schema)))
    .map((t) => t.schema);
  return [...base, ...(canSpawn(depth) ? [spawnAgentSchema] : []), finalAnswerSchema];
}

// Back-compat alias for the top-level toolset (the only schemas a non-delegating run ever needs).
export const toolSchemas = schemasFor(0);

// Structured terminal result — the agent loop owns these; re-exported so importers use one barrel.
export { parseFinalAnswer, type RunResult } from "./final_answer";
// Delegation helpers — owned by the loop (recursion needs run()), re-exported through the one barrel.
export { MAX_DEPTH, canSpawn, SUBAGENT_TOOLS, parseSpawnArgs, formatSubResult } from "./spawn_agent";

// Cap one tool result before it enters the history. A single big read/run can blow the budget
// in one turn; keep the top and bottom (signatures, errors, exit code) and drop the middle.
// To see the gap, narrow the request: read_file with offset/limit, or a more specific command.
const MAX_TOOL_RESULT = 12_000; // chars ≈ ~3k tokens
export function capResult(s: string): string {
  if (s.length <= MAX_TOOL_RESULT) return s;
  const head = s.slice(0, Math.floor(MAX_TOOL_RESULT * 0.7));
  const tail = s.slice(-Math.floor(MAX_TOOL_RESULT * 0.2));
  const cut = s.length - head.length - tail.length;
  return `${head}\n… [${cut} chars omitted — narrow the request to see this part] …\n${tail}`;
}

// Run one tool call. Never throws — errors come back as the result so the model can recover. `allow`,
// when given, is the subagent's read-only allow-set: a call outside it is blocked as a recoverable
// result (defence-in-depth — a subagent isn't even shown the other schemas, but a hallucinated call
// must still be refused, not run).
export async function dispatch(name: string, argsJson: string, allow?: Set<string>): Promise<string> {
  const tool = registry[name];
  if (!tool) return `error: unknown tool '${name}'`;
  if (allow && !allow.has(name)) return `error: blocked: '${name}' is not available to a subagent (read-only)`;

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return `error: arguments for '${name}' were not valid JSON`;
  }

  // Safety gate, before anything runs. A blocked call is a result the model can recover from,
  // not a crash — same shape as every other tool error.
  const decision = check(name, args);
  if (!decision.allow) return `error: blocked: ${decision.reason}`;

  try {
    return capResult(await tool.run(args));
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}
