// Chat client — the model-I/O layer the agent is built on. Talks to either OpenRouter or OpenAI
// (OpenAI-compatible API; same SDK, different baseURL + key); the provider is resolved from the
// environment. The model is switchable at runtime (/model command); the catalog + per-model
// context/price come from the provider's own API and degrade gracefully when unavailable.
import OpenAI from "openai";
import { resolveProvider, PROVIDERS, type Provider } from "./provider";

const resolved = resolveProvider();
if ("error" in resolved) {
  throw new Error(`${resolved.error} — copy .env.example to .env, or run interactively to set it up`);
}
const provider: Provider = resolved.provider;
const conf = PROVIDERS[provider];

const DEFAULT_MODEL = process.env.AGENT_MODEL || conf.defaultModel;
const DEFAULT_WINDOW = 128_000; // assumed context window until we learn the real one from the catalog

let model = DEFAULT_MODEL;
let contextWindow = DEFAULT_WINDOW; // kept in sync with the active model so the budget tracks it

export const getProvider = () => provider;
export const getModel = () => model;
export const getContextWindow = () => contextWindow;

export const client = new OpenAI({
  ...(conf.baseURL ? { baseURL: conf.baseURL } : {}), // OpenAI uses the SDK default; OpenRouter overrides it
  apiKey: resolved.apiKey,
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

// --- model catalog: context window + price. OpenRouter ships both in its catalog; OpenAI's
// /v1/models lists ids only (no pricing, no context), so those fields stay 0 and the UI degrades
// to "no catalog price" / the assumed window — same fallback the OpenRouter path uses on a miss. ---

export type ModelInfo = {
  id: string;
  name: string;
  context: number;
  promptPrice: number; // USD per 1M input tokens
  completionPrice: number; // USD per 1M output tokens
  tools: boolean; // supports tool-calling — this is a tool-using agent, so non-tool models are useless here
};

let catalog: ModelInfo[] | null = null; // fetched once, then cached for the session

// OpenAI's catalog has no tool-capability flag and lists embeddings/audio/image models alongside
// chat ones. Keep the obvious chat/reasoning families and drop non-chat endpoints by name.
function isOpenAIChatModel(id: string): boolean {
  if (/embedding|whisper|tts|dall-e|audio|image|realtime|transcribe|moderation|search|codex/.test(id)) return false;
  return /^(gpt-|o\d|chatgpt-)/.test(id);
}

export async function fetchModels(): Promise<ModelInfo[]> {
  if (catalog) return catalog;

  if (provider === "openai") {
    // GET /v1/models needs the key; pricing/context aren't in the response, so leave them 0.
    const res = await client.models.list();
    catalog = res.data
      .filter((m) => isOpenAIChatModel(m.id))
      .map((m) => ({ id: m.id, name: m.id, context: 0, promptPrice: 0, completionPrice: 0, tools: true }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return catalog;
  }

  const res = await fetch(`${conf.baseURL}/models`, { signal: AbortSignal.timeout(10_000) });
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
