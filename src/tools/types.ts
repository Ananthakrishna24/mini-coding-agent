import type OpenAI from "openai";

// Type definition for a tool.
export type Tool = {
  schema: OpenAI.ChatCompletionTool;
  run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
};

