// Public surface of the tools layer. Model output is untrusted — dispatch validates and never throws.
//
// Add a tool: create ./<name>.ts exporting a `Tool`, import it here, and add it to `registry`.
// The registry key is the tool's name. That's the whole extension story.
import type { Tool } from "./types";
import { check } from "../permissions";
import { read_file } from "./read_file";
import { write_file } from "./write_file";
import { edit_file } from "./edit_file";
import { run_bash } from "./run_bash";
import { update_plan } from "./update_plan";
import { finalAnswerSchema } from "./final_answer";

const registry: Record<string, Tool> = { read_file, write_file, edit_file, run_bash, update_plan };

// Schemas to hand the model. final_answer is a terminal signal, not a dispatch tool (the agent loop
// intercepts it), so it's appended here for the model to see rather than living in the registry.
export const toolSchemas = [...Object.values(registry).map((t) => t.schema), finalAnswerSchema];

// Structured terminal result — the agent loop owns these; re-exported so importers use one barrel.
export { parseFinalAnswer, type RunResult } from "./final_answer";

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

// Run one tool call. Never throws — errors come back as the result so the model can recover.
export async function dispatch(name: string, argsJson: string): Promise<string> {
  const tool = registry[name];
  if (!tool) return `error: unknown tool '${name}'`;

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
