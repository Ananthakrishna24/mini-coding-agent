// OpenRouter chat client — the model-I/O layer the agent is built on.
import OpenAI from "openai";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY missing — copy .env.example to .env and add your key");
}

export const MODEL = "deepseek/deepseek-v4-flash";

export const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  maxRetries: 4, // SDK retries 408/409/429/5xx + connection drops with exponential backoff + jitter
  timeout: 120_000, // ms per request — fail a hung connection instead of stalling the whole run
});

// One completion. Pass tools to let the model call them (tool_choice: auto).
export async function chat(
  messages: OpenAI.ChatCompletionMessageParam[],
  tools?: OpenAI.ChatCompletionTool[],
) {
  return client.chat.completions.create({
    model: MODEL,
    messages,
    ...(tools ? { tools, tool_choice: "auto" } : {}),
  });
}
