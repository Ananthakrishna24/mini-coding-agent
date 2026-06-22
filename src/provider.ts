// Provider config: which LLM service to talk to, and the .env plumbing onboarding writes. Pure
// functions only (no SDK, no network, no import-time side effects) so the model client, the
// onboarding screen, and the offline self-check can all share this without booting a client.

export type Provider = "openrouter" | "openai";

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
};

export type Resolved = { provider: Provider; apiKey: string };

// Decide which provider to use from the environment. Rule:
//   1. an explicit PROVIDER wins (but only if its key is actually present);
//   2. otherwise infer from whichever key is set;
//   3. if BOTH keys are set with no PROVIDER, prefer OpenRouter (it's this project's original
//      provider and reaches the widest model set) — set PROVIDER=openai to override.
// Returns the chosen provider + its key, or an error string explaining what's missing.
export function resolveProvider(env: Record<string, string | undefined> = process.env): Resolved | { error: string } {
  const has = (p: Provider) => {
    const v = env[PROVIDERS[p].keyVar];
    return typeof v === "string" && v.trim().length > 0;
  };
  const explicit = env.PROVIDER?.trim().toLowerCase();

  if (explicit) {
    if (explicit !== "openrouter" && explicit !== "openai") {
      return { error: `PROVIDER="${env.PROVIDER}" is not recognized — use "openrouter" or "openai"` };
    }
    const p = explicit as Provider;
    if (!has(p)) return { error: `PROVIDER=${p} but ${PROVIDERS[p].keyVar} is not set` };
    return { provider: p, apiKey: env[PROVIDERS[p].keyVar]!.trim() };
  }

  // No explicit choice — infer. OpenRouter wins the tie when both keys are present.
  if (has("openrouter")) return { provider: "openrouter", apiKey: env.OPENROUTER_API_KEY!.trim() };
  if (has("openai")) return { provider: "openai", apiKey: env.OPENAI_API_KEY!.trim() };

  return { error: "no API key configured — set OPENROUTER_API_KEY or OPENAI_API_KEY (see .env.example)" };
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
