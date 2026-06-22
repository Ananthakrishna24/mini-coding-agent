import type OpenAI from "openai";

// Each tool bundles the schema the model sees with the executor we run. One tool per file.
export type Tool = {
  schema: OpenAI.ChatCompletionTool;
  run: (args: Record<string, unknown>) => Promise<string>;
};
