// OpenRouter chat client — the model-I/O layer the agent is built on.
import OpenAI from "openai";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY missing — copy .env.example to .env and add your key");
}

export const MODEL = "google/gemini-3-flash-preview";

export const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Single completion. Grows to carry tools and streaming as those land.
export async function chat(messages: OpenAI.ChatCompletionMessageParam[]) {
  return client.chat.completions.create({ model: MODEL, messages });
}
