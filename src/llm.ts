// Chat client interface for interacting with configured LLM providers.
import OpenAI from "openai";
import { resolveProvider, PROVIDERS, reasoningParams, openaiReasons, openaiVision, mistralVision, type Provider } from "./provider";

// A provider's key if one is configured right now (env, or a .env that --env-file / onboarding loaded).
const keyFor = (p: Provider): string | undefined => {
  const v = process.env[PROVIDERS[p].keyVar];
  return v && v.trim() ? v.trim() : undefined;
};
// Every provider we have a usable key for — the set the model catalog is drawn from.
export const availableProviders = (): Provider[] => (Object.keys(PROVIDERS) as Provider[]).filter(keyFor);

const resolved = resolveProvider();
if ("error" in resolved) {
  throw new Error(`${resolved.error} — copy .env.example to .env, or run interactively to set it up`);
}

const DEFAULT_WINDOW = 128_000; // assumed context window until we learn the real one from the catalog
let provider: Provider = resolved.provider; // follows the active model — switched when a model from another provider is picked
let model = process.env.AGENT_MODEL || PROVIDERS[provider].defaultModel;
let contextWindow = DEFAULT_WINDOW; // kept in sync with the active model so the budget tracks it

export const getProvider = () => provider;
export const getModel = () => model;
export const getContextWindow = () => contextWindow;

// Reasoning effort (low|medium|high) for the active model, or null = let the model default. Only sent
// for reasoning-capable models; setModel clears it when switching to one that can't take it.
let effort: string | null = null;
export const getEffort = () => effort;
export const setEffort = (e: string | null) => void (effort = e);

// A client for a provider (OpenAI uses the SDK's default baseURL; OpenRouter overrides it). Only ever
// called for a provider we have a key for.
function buildClient(p: Provider): OpenAI {
  const conf = PROVIDERS[p];
  return new OpenAI({
    ...(conf.baseURL ? { baseURL: conf.baseURL } : {}),
    apiKey: keyFor(p) ?? "",
    maxRetries: 4, // SDK retries 408/409/429/5xx + connection drops with exponential backoff + jitter
    timeout: 120_000, // ms per request — fail a hung connection instead of stalling the whole run
  });
}
let client = buildClient(provider); // rebuilt by setModel when the active model's provider changes

// One completion. Pass tools to let the model call them (tool_choice: auto). `opts` overrides the model
// and reasoning effort for this one call — a subagent run on a different model goes through here. The
// override reuses the active provider's client, so it assumes the chosen id is served by that provider
// (true for an OpenRouter-only setup); a cross-provider override would need a client for that provider.
export async function chat(
  messages: OpenAI.ChatCompletionMessageParam[],
  tools?: OpenAI.ChatCompletionTool[],
  opts?: { model?: string; effort?: string | null; signal?: AbortSignal; toolChoice?: OpenAI.ChatCompletionToolChoiceOption; temperature?: number },
) {
  const useModel = opts?.model ?? model;
  const useEffort = opts && "effort" in opts ? opts.effort ?? null : effort;
  const base = {
    model: useModel,
    messages,
    ...(tools ? { tools, tool_choice: opts?.toolChoice ?? "auto" } : {}),
    ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
  };
  const create = (extra: Record<string, unknown>, reqOpts?: { signal?: AbortSignal }) =>
    // cast: `reasoning` (OpenRouter) isn't in the SDK type
    client.chat.completions.create({ ...base, ...extra } as OpenAI.ChatCompletionCreateParamsNonStreaming, reqOpts);
  try {
    return await create(reasoningParams(provider, useEffort), opts?.signal ? { signal: opts.signal } : undefined); // reasoning_effort / reasoning.effort, only when set
  } catch (e: any) {
    // gpt-5.5/5.4 reject reasoning_effort alongside function tools on Chat Completions ("use /v1/responses").
    // Retry once without the effort knob so the call still lands — models that accept it (o-series, gpt-5.1)
    // never hit this path. Degrade the knob, not the request; the full fix is the Responses API.
    if (useEffort && e?.status === 400 && /reasoning_effort/i.test(String(e?.message))) return await create({}, opts?.signal ? { signal: opts.signal } : undefined);
    throw e;
  }
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
  reasoning: boolean; // takes a reasoning-effort knob — the /model flow then asks for the effort level
  vision: boolean; // accepts image input — gates attaching pasted/path images to the message
  provider: Provider; // which provider serves this model — so the client can be pointed at the right API
};

let catalog: ModelInfo[] | null = null; // fetched once, then cached for the session
export const resetCatalog = () => void (catalog = null); // after /setup adds a key, so a new provider's models appear

// OpenAI's catalog has no tool-capability flag and lists embeddings/audio/image models alongside
// chat ones. Keep the obvious chat/reasoning families and drop non-chat endpoints by name.
function isOpenAIChatModel(id: string): boolean {
  if (/embedding|whisper|tts|dall-e|audio|image|realtime|transcribe|moderation|search|codex/.test(id)) return false;
  return /^(gpt-|o\d|chatgpt-)/.test(id);
}

function isMistralChatModel(id: string): boolean {
  return !/embed/.test(id);
}

// Models served by one provider, tagged with it. OpenAI's /v1/models lists ids only (no pricing/context),
// so those fields stay 0 and the UI degrades like the OpenRouter miss path.
async function fetchProviderModels(p: Provider): Promise<ModelInfo[]> {
  const conf = PROVIDERS[p];
  if (p === "openai") {
    const res = await buildClient(p).models.list();
    return res.data
      .filter((m) => isOpenAIChatModel(m.id))
      .map((m) => ({ id: m.id, name: m.id, context: 0, promptPrice: 0, completionPrice: 0, tools: true, reasoning: openaiReasons(m.id), vision: openaiVision(m.id), provider: p }));
  }
  if (p === "mistral") {
    const res = await buildClient(p).models.list();
    return res.data
      .filter((m) => isMistralChatModel(m.id))
      .map((m) => ({ id: m.id, name: m.id, context: 0, promptPrice: 0, completionPrice: 0, tools: true, reasoning: false, vision: mistralVision(m.id), provider: p }));
  }
  const res = await fetch(`${conf.baseURL}/models`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`model catalog fetch failed: ${res.status}`);
  const { data } = (await res.json()) as { data: any[] };
  return data.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    context: m.context_length ?? m.top_provider?.context_length ?? 0,
    promptPrice: Number(m.pricing?.prompt ?? 0) * 1e6,
    completionPrice: Number(m.pricing?.completion ?? 0) * 1e6,
    tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"),
    reasoning: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("reasoning"),
    vision: Array.isArray(m.architecture?.input_modalities) && m.architecture.input_modalities.includes("image"),
    provider: p,
  }));
}

// Catalog across every provider we have a key for, so /model lists them all at once. A provider that
// fails (down, bad key) is swallowed so it can't hide the others. IDs are assumed unique across
// providers (OpenRouter's "a/b" ids don't collide with OpenAI's bare ids); first match wins if not.
export async function fetchModels(): Promise<ModelInfo[]> {
  if (catalog) return catalog;
  const lists = await Promise.all(availableProviders().map((p) => fetchProviderModels(p).catch((e) => {
    if (process.env.DEBUG) console.error(`[debug] catalog fetch failed for ${p}: ${e?.message ?? e}`);
    return [] as ModelInfo[];
  })));
  // Dedupe by id, first match wins. Providers (Mistral) list each model once per alias, repeating the
  // same id — left in, those collide as duplicate keys in the /model picker.
  const byId = new Map<string, ModelInfo>();
  for (const m of lists.flat()) if (!byId.has(m.id)) byId.set(m.id, m);
  catalog = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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
  if (info && info.provider !== provider) {
    provider = info.provider; // a model from another provider: point the client at that provider's API
    client = buildClient(provider);
  }
  if (info?.context) contextWindow = info.context;
  if (info && !info.reasoning) effort = null; // a non-reasoning model would reject an effort param
  return info;
}

// Tool-capable models whose id/name matches the query (case-insensitive). No query = all tool models.
export async function searchModels(query = ""): Promise<ModelInfo[]> {
  const q = query.trim().toLowerCase();
  const all = (await fetchModels()).filter((m) => m.tools);
  return q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : all;
}
