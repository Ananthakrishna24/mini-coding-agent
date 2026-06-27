// Tool schema and validator for signaling task completion.
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

// Parses and validates the final_answer payload.
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

