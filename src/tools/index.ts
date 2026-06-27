// Public API for the tools layer. Handles tool registration and dispatch.
import type OpenAI from "openai";
import type { Tool } from "./types";
import { check } from "../permissions";
import { read_file } from "./read_file";
import { write_file } from "./write_file";
import { edit_file } from "./edit_file";
import { multi_edit } from "./multi_edit";
import { run_bash } from "./run_bash";
import { glob } from "./glob";
import { grep } from "./grep";
import { update_plan } from "./update_plan";
import { list_models } from "./list_models";
import { read_skill } from "./read_skill";
import { web_fetch } from "./web_fetch";
import { web_search } from "./web_search";
import { finalAnswerSchema } from "./final_answer";
import { spawnAgentSchema, canSpawn } from "./spawn_agent";

const registry: Record<string, Tool> = { read_file, write_file, edit_file, multi_edit, run_bash, glob, grep, update_plan, list_models, read_skill, web_fetch, web_search };

// Extracts the function name from a tool schema.
export const toolName = (s: OpenAI.ChatCompletionTool): string => (s.type === "function" ? s.function.name : "");

// Get tool schemas for the model, checking depth to optionally include spawn_agent.
export function schemasFor(depth: number): OpenAI.ChatCompletionTool[] {
  const base = Object.values(registry).map((t) => t.schema);
  return [...base, ...(canSpawn(depth) ? [spawnAgentSchema] : []), finalAnswerSchema];
}

// Top-level tool schemas.
export const toolSchemas = schemasFor(0);

// Export final answer parsing.
export { parseFinalAnswer, type RunResult } from "./final_answer";
// Export agent spawning/delegation helpers.
export { MAX_DEPTH, canSpawn, MAX_FANOUT, canFanOut, parseSpawnArgs, formatSubResult, type SpawnArgs } from "./spawn_agent";

// Truncates large tool outputs to fit within context window limits.
const MAX_TOOL_RESULT = 12_000;
export function capResult(s: string): string {
  if (s.length <= MAX_TOOL_RESULT) return s;
  const head = s.slice(0, Math.floor(MAX_TOOL_RESULT * 0.7));
  const tail = s.slice(-Math.floor(MAX_TOOL_RESULT * 0.2));
  const cut = s.length - head.length - tail.length;
  return `${head}\n… [${cut} chars omitted — narrow the request to see this part] …\n${tail}`;
}

// Dispatches and executes a tool call. Returns error messages directly to the model.
export async function dispatch(name: string, argsJson: string, signal?: AbortSignal): Promise<string> {
  const tool = registry[name];
  if (!tool) return `error: unknown tool '${name}'`;

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return `error: arguments for '${name}' were not valid JSON`;
  }

  // Run safety check before execution.
  const decision = check(name, args);
  if (!decision.allow) return `error: blocked: ${decision.reason}`;

  try {
    return capResult(await tool.run(args, signal));
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}

