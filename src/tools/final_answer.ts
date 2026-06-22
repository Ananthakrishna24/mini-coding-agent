// final_answer: the terminal signal. The model calls this to end a run with a *structured*
// result a program can consume, instead of trailing off into prose. Not a side-effecting tool —
// it doesn't touch the world, it ends the loop — so it lives outside the dispatch registry and the
// agent loop intercepts it by name.
//
// Structured output is just function calling where the function is "return the answer": the schema
// below rides to the model in `tools`, so it's already constrained toward the right shape. But the
// provider's guarantee is not ours — the args can still arrive truncated, downgraded, or wrong-typed
// — so `parseFinalAnswer` re-validates at the boundary before we trust it (same rule as every tool
// and the safety layer). A bad payload comes back as an error the model can correct (Task 4.1).
import type OpenAI from "openai";

export type RunResult = { success: boolean; summary: string };

export const finalAnswerSchema: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "final_answer",
    description:
      "Finish the task. Call this exactly once when you are done, instead of replying in prose. " +
      "Report whether the task succeeded and a short summary of what was done.",
    parameters: {
      type: "object",
      properties: {
        success: { type: "boolean", description: "true if the task was completed, false if it could not be." },
        summary: { type: "string", description: "A short, human-readable summary of the outcome." },
      },
      required: ["success", "summary"],
      additionalProperties: false,
    },
  },
};

// Parse + validate the terminal payload. Throws (with a fix-it message) on anything the model can
// correct: not JSON (often a truncated reply), missing field, wrong type, or a blank summary —
// "string" from the schema isn't the same as "the non-empty string we actually need".
export function parseFinalAnswer(argsJson: string): RunResult {
  let args: any;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    throw new Error("final_answer arguments were not valid JSON");
  }
  if (typeof args.success !== "boolean") throw new Error("final_answer: 'success' must be a boolean (true or false)");
  if (typeof args.summary !== "string" || args.summary.trim() === "") {
    throw new Error("final_answer: 'summary' must be a non-empty string");
  }
  return { success: args.success, summary: args.summary.trim() };
}
