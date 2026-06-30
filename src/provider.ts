// Provider configuration and env file management logic.
import { CODEX_DUMMY_API_KEY, resolveOpenAICredential, type OpenAIAuthMode } from "./codex_auth";

export type Provider = "openrouter" | "openai" | "mistral";

// Per-provider defaults: API base, the env var holding the key, and a sensible starting model.
// OpenAI uses the SDK's built-in baseURL (null = don't override it).
export const PROVIDERS: Record<Provider, { label: string; baseURL: string | null; keyVar: string; defaultModel: string }> = {
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    keyVar: "OPENROUTER_API_KEY",
    defaultModel: "deepseek/deepseek-v4-flash",
  },
  openai: {
    label: "OpenAI",
    baseURL: null, // the openai SDK already points at api.openai.com by default
    keyVar: "OPENAI_API_KEY",
    defaultModel: "gpt-5.5", // flagship per OpenAI's "not sure where to start" guidance; Chat Completions + tools
  },
  mistral: {
    label: "Mistral",
    baseURL: "https://api.mistral.ai/v1",
    keyVar: "MISTRAL_API_KEY",
    defaultModel: "mistral-large-latest",
  },
};

export type Resolved = { provider: Provider; apiKey: string; authMode?: OpenAIAuthMode };

// --- reasoning effort: the low|medium|high knob reasoning models take ---

// The wire shape differs by provider: OpenAI Chat Completions takes a top-level `reasoning_effort`;
// OpenRouter wraps it as `reasoning: { effort }`. Returns the extra request body to merge into the
// completion call, or {} when no effort is set (so a non-reasoning model gets a clean request).
export function reasoningParams(provider: Provider, effort: string | null): Record<string, unknown> {
  if (!effort) return {};
  if (provider === "openai") return { reasoning_effort: effort };
  if (provider === "mistral") return {};
  return { reasoning: { effort } };
}

// OpenAI's catalog carries no capability flags, so infer reasoning support from the id: the o-series
// (o1/o3/o4…) and the gpt-5 family reason. OpenRouter reports it directly via supported_parameters,
// so this is only the OpenAI fallback.
export function openaiReasons(id: string): boolean {
  return /^o\d/.test(id) || /^gpt-5/.test(id);
}

export function openaiVision(id: string): boolean {
  if (/^gpt-3\.5/.test(id)) return false;
  if (/^o[13]-mini/.test(id)) return false;
  return true;
}

export function mistralVision(id: string): boolean {
  return /pixtral/.test(id);
}

export function openaiAuthMode(env: Record<string, string | undefined> = process.env): OpenAIAuthMode | { error: string } | undefined {
  const credential = resolveOpenAICredential(env);
  if (!credential) return undefined;
  if ("error" in credential) return credential;
  return credential.kind === "codex" ? "codex" : "api-key";
}

// Decide which provider to use from the environment. Rule:
//   1. an explicit PROVIDER wins (but only if its key is actually present);
//   2. otherwise infer from whichever key is set;
//   3. if BOTH keys are set with no PROVIDER, prefer OpenRouter (it's this project's original
//      provider and reaches the widest model set) — set PROVIDER=openai to override.
// Returns the chosen provider + its key, or an error string explaining what's missing.
export function resolveProvider(env: Record<string, string | undefined> = process.env): Resolved | { error: string } {
  const openaiCredential = resolveOpenAICredential(env);
  if (openaiCredential && "error" in openaiCredential) return openaiCredential;

  const has = (p: Provider) => {
    if (p === "openai") return !!openaiCredential;
    const v = env[PROVIDERS[p].keyVar];
    return typeof v === "string" && v.trim().length > 0;
  };
  const key = (p: Provider) => {
    if (p === "openai" && openaiCredential) {
      return openaiCredential.kind === "codex" ? CODEX_DUMMY_API_KEY : openaiCredential.apiKey;
    }
    return env[PROVIDERS[p].keyVar]!.trim();
  };
  const explicit = env.PROVIDER?.trim().toLowerCase();

  if (explicit) {
    if (!(explicit in PROVIDERS)) {
      return { error: `PROVIDER="${env.PROVIDER}" is not recognized — use "openrouter", "openai", or "mistral"` };
    }
    const p = explicit as Provider;
    if (!has(p)) {
      if (p === "openai") {
        return { error: `PROVIDER=openai but OPENAI_API_KEY is not set and no Codex login is available (run \`codex login\` or set CODEX_ACCESS_TOKEN)` };
      }
      return { error: `PROVIDER=${p} but ${PROVIDERS[p].keyVar} is not set` };
    }
    return {
      provider: p,
      apiKey: key(p),
      ...(p === "openai" && openaiCredential?.kind === "codex" ? { authMode: "codex" as const } : {}),
    };
  }

  // No explicit choice — infer. OpenRouter wins ties (widest catalog), then OpenAI, then Mistral.
  for (const p of ["openrouter", "openai", "mistral"] as const) {
    if (has(p)) {
      return {
        provider: p,
        apiKey: key(p),
        ...(p === "openai" && openaiCredential?.kind === "codex" ? { authMode: "codex" as const } : {}),
      };
    }
  }

  return { error: "no provider configured — set OPENROUTER_API_KEY, OPENAI_API_KEY, MISTRAL_API_KEY, or run `codex login` (see .env.example)" };
}

// --- .env file merge: add/update only the keys we own, leave everything else byte-for-byte ---

// Upsert each key in `updates` into an existing .env body. Existing lines for those keys are
// rewritten in place (preserving their position); unknown keys are appended. Comments, blank
// lines, and unrelated assignments are untouched. A `null` value removes the key.
export function mergeEnv(existing: string, updates: Record<string, string | null>): string {
  const lines = existing.length ? existing.split("\n") : [];
  const pending = new Map(Object.entries(updates));

  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m) return line; // comment, blank, or something we don't parse — keep it
    const key = m[1];
    if (!pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return value === null ? null : `${key}=${value}`;
  });

  // remove deleted keys (mapped to null above)
  let merged = out.filter((l): l is string => l !== null);

  // append keys that weren't already present
  for (const [key, value] of pending) {
    if (value === null) continue;
    merged.push(`${key}=${value}`);
  }

  // exactly one trailing newline
  return merged.join("\n").replace(/\n*$/, "") + "\n";
}
