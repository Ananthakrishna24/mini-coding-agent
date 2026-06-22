// OpenRouter chat client — the model-I/O layer the agent is built on. The model is switchable at
// runtime (/model command); the catalog + per-model context/price come from OpenRouter's own API.
import OpenAI from "openai";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY missing — copy .env.example to .env and add your key");
}

const DEFAULT_MODEL = process.env.AGENT_MODEL || "deepseek/deepseek-v4-flash";
const DEFAULT_WINDOW = 128_000; // assumed context window until we learn the real one from the catalog

let model = DEFAULT_MODEL;
let contextWindow = DEFAULT_WINDOW; // kept in sync with the active model so the budget tracks it

export const getModel = () => model;
export const getContextWindow = () => contextWindow;

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
    model,
    messages,
    ...(tools ? { tools, tool_choice: "auto" } : {}),
  });
}

// --- model catalog: context window + price, straight from OpenRouter ---

export type ModelInfo = {
  id: string;
  name: string;
  context: number;
  promptPrice: number; // USD per 1M input tokens
  completionPrice: number; // USD per 1M output tokens
  tools: boolean; // supports tool-calling — this is a tool-using agent, so non-tool models are useless here
};

let catalog: ModelInfo[] | null = null; // fetched once, then cached for the session

export async function fetchModels(): Promise<ModelInfo[]> {
  if (catalog) return catalog;
  const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`model catalog fetch failed: ${res.status}`);
  const { data } = (await res.json()) as { data: any[] };
  catalog = data.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    context: m.context_length ?? m.top_provider?.context_length ?? 0,
    promptPrice: Number(m.pricing?.prompt ?? 0) * 1e6,
    completionPrice: Number(m.pricing?.completion ?? 0) * 1e6,
    tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"),
  }));
  return catalog;
}

export async function modelInfo(id = model): Promise<ModelInfo | undefined> {
  return (await fetchModels().catch(() => [] as ModelInfo[])).find((m) => m.id === id);
}

// Switch the active model and sync the context window from the catalog (best-effort — a catalog miss
// or offline keeps the previous window rather than failing the switch).
export async function setModel(id: string): Promise<ModelInfo | undefined> {
  model = id;
  const info = await modelInfo(id).catch(() => undefined);
  if (info?.context) contextWindow = info.context;
  return info;
}

// Tool-capable models whose id/name matches the query (case-insensitive). No query = all tool models.
export async function searchModels(query = ""): Promise<ModelInfo[]> {
  const q = query.trim().toLowerCase();
  const all = (await fetchModels()).filter((m) => m.tools);
  return q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : all;
}
