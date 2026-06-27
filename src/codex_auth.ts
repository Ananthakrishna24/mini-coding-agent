import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPENAI_AUTH_ENV = "OPENAI_AUTH";
export const OPENAI_AUTH_CODEX = "codex";
export const CODEX_DUMMY_API_KEY = "codex-login";
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_CODEX_AUTH_ISSUER = "https://auth.openai.com";
export const DEFAULT_CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export type OpenAIAuthMode = "api-key" | "codex";

export type OpenAIApiKeyCredential = {
  kind: "api-key";
  apiKey: string;
  source: "env" | "codex-auth-json";
};

export type CodexCredential = {
  kind: "codex";
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  expiresAt?: number;
  authPath?: string;
  source: "env" | "auth-json";
};

export type OpenAICredential = OpenAIApiKeyCredential | CodexCredential;

type RawCodexAuth = {
  OPENAI_API_KEY?: unknown;
  tokens?: {
    id_token?: unknown;
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
};

type TokenResponse = {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type JwtClaims = {
  exp?: number;
  chatgpt_account_id?: string;
  organizations?: Array<{ id?: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
};

const trim = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function codexHome(env: Record<string, string | undefined> = process.env): string {
  return trim(env.CODEX_HOME) ?? path.join(os.homedir(), ".codex");
}

export function codexAuthPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(codexHome(env), "auth.json");
}

export function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as JwtClaims;
  } catch {
    return undefined;
  }
}

export function extractAccountIdFromClaims(claims: JwtClaims | undefined): string | undefined {
  if (!claims) return undefined;
  return (
    trim(claims.chatgpt_account_id) ??
    trim(claims["https://api.openai.com/auth"]?.chatgpt_account_id) ??
    trim(claims.organizations?.[0]?.id)
  );
}

function tokenExpiresAt(token: string | undefined): number | undefined {
  const exp = token ? parseJwtClaims(token)?.exp : undefined;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

function extractAccountId(tokens: Pick<TokenResponse, "id_token" | "access_token">, fallback?: string): string | undefined {
  return (
    extractAccountIdFromClaims(tokens.id_token ? parseJwtClaims(tokens.id_token) : undefined) ??
    extractAccountIdFromClaims(tokens.access_token ? parseJwtClaims(tokens.access_token) : undefined) ??
    trim(fallback)
  );
}

function readAuthJson(env: Record<string, string | undefined> = process.env): { path: string; auth: RawCodexAuth } | undefined {
  const authPath = codexAuthPath(env);
  if (!fs.existsSync(authPath)) return undefined;
  try {
    return { path: authPath, auth: JSON.parse(fs.readFileSync(authPath, "utf8")) as RawCodexAuth };
  } catch {
    return undefined;
  }
}

function codexCredentialFromEnv(env: Record<string, string | undefined>): CodexCredential | undefined {
  const accessToken = trim(env.CODEX_ACCESS_TOKEN);
  if (!accessToken) return undefined;
  return {
    kind: "codex",
    accessToken,
    accountId: extractAccountId({ access_token: accessToken }),
    expiresAt: tokenExpiresAt(accessToken),
    source: "env",
  };
}

function credentialFromAuthJson(env: Record<string, string | undefined>): OpenAICredential | undefined {
  const found = readAuthJson(env);
  if (!found) return undefined;

  const apiKey = trim(found.auth.OPENAI_API_KEY);
  if (apiKey) return { kind: "api-key", apiKey, source: "codex-auth-json" };

  const tokens = found.auth.tokens;
  const accessToken = trim(tokens?.access_token);
  if (!accessToken) return undefined;

  const idToken = trim(tokens?.id_token);
  const refreshToken = trim(tokens?.refresh_token);
  return {
    kind: "codex",
    accessToken,
    refreshToken,
    idToken,
    accountId: extractAccountId({ id_token: idToken, access_token: accessToken }, trim(tokens?.account_id)),
    expiresAt: tokenExpiresAt(accessToken),
    authPath: found.path,
    source: "auth-json",
  };
}

function shouldReadCodexAuthFile(env: Record<string, string | undefined>): boolean {
  return env === process.env || Object.prototype.hasOwnProperty.call(env, "CODEX_HOME");
}

export function resolveOpenAICredential(
  env: Record<string, string | undefined> = process.env,
): OpenAICredential | { error: string } | undefined {
  const requested = trim(env[OPENAI_AUTH_ENV])?.toLowerCase();
  if (requested && !["api", "api-key", OPENAI_AUTH_CODEX].includes(requested)) {
    return { error: `${OPENAI_AUTH_ENV}="${env[OPENAI_AUTH_ENV]}" is not recognized — use "api-key" or "codex"` };
  }

  if (requested !== OPENAI_AUTH_CODEX) {
    const apiKey = trim(env.OPENAI_API_KEY);
    if (apiKey) return { kind: "api-key", apiKey, source: "env" };
  }

  if (requested !== "api" && requested !== "api-key") {
    const envToken = codexCredentialFromEnv(env);
    if (envToken) return envToken;
  }

  const fileCredential = shouldReadCodexAuthFile(env) ? credentialFromAuthJson(env) : undefined;
  if (fileCredential) {
    if (requested === OPENAI_AUTH_CODEX && fileCredential.kind !== "codex") {
      return { error: `${OPENAI_AUTH_ENV}=codex but ${codexAuthPath(env)} contains API-key auth, not ChatGPT/Codex tokens` };
    }
    if ((requested === "api" || requested === "api-key") && fileCredential.kind !== "api-key") {
      return { error: `${OPENAI_AUTH_ENV}=api-key but OPENAI_API_KEY is not set` };
    }
    return fileCredential;
  }

  if (requested === OPENAI_AUTH_CODEX) {
    return { error: `${OPENAI_AUTH_ENV}=codex but no CODEX_ACCESS_TOKEN or ${codexAuthPath(env)} token cache was found` };
  }
  if (requested === "api" || requested === "api-key") {
    return { error: `${OPENAI_AUTH_ENV}=api-key but OPENAI_API_KEY is not set` };
  }
  return undefined;
}

export function codexCredentialNeedsRefresh(credential: CodexCredential, skewMs = 60_000): boolean {
  return typeof credential.expiresAt === "number" && credential.expiresAt <= Date.now() + skewMs;
}

function writeRefreshedAuthJson(credential: CodexCredential, tokens: TokenResponse, next: CodexCredential): void {
  if (!credential.authPath) return;
  const existing = fs.existsSync(credential.authPath)
    ? JSON.parse(fs.readFileSync(credential.authPath, "utf8")) as RawCodexAuth & Record<string, unknown>
    : {};
  const previousTokens = existing.tokens && typeof existing.tokens === "object" ? existing.tokens : {};
  existing.OPENAI_API_KEY ??= null;
  existing.auth_mode ??= "chatgpt";
  existing.tokens = {
    ...previousTokens,
    id_token: tokens.id_token ?? next.idToken ?? (previousTokens as RawCodexAuth["tokens"])?.id_token,
    access_token: next.accessToken,
    refresh_token: next.refreshToken ?? (previousTokens as RawCodexAuth["tokens"])?.refresh_token,
    account_id: next.accountId ?? (previousTokens as RawCodexAuth["tokens"])?.account_id,
  };
  existing.last_refresh = new Date().toISOString();
  fs.writeFileSync(credential.authPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(credential.authPath, 0o600);
}

export async function refreshCodexCredential(
  credential: CodexCredential,
  opts: { issuer?: string; fetchImpl?: typeof fetch } = {},
): Promise<CodexCredential> {
  if (!credential.refreshToken) {
    throw new Error("Codex access token is expired and no refresh token is available; run `codex login` again or set a fresh CODEX_ACCESS_TOKEN");
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const issuer = opts.issuer ?? process.env.CODEX_AUTH_ISSUER ?? DEFAULT_CODEX_AUTH_ISSUER;
  const response = await fetchImpl(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) throw new Error(`Codex token refresh failed: ${response.status}`);
  const tokens = (await response.json()) as TokenResponse;
  if (!tokens.access_token) throw new Error("Codex token refresh did not return an access token");

  const next: CodexCredential = {
    ...credential,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? credential.refreshToken,
    idToken: tokens.id_token ?? credential.idToken,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : tokenExpiresAt(tokens.access_token),
    accountId: extractAccountId(tokens, credential.accountId),
  };
  writeRefreshedAuthJson(credential, tokens, next);
  return next;
}

function headersFrom(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(
    typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
  );
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  headers.delete("authorization");
  return headers;
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function shouldUseCodexEndpoint(url: URL): boolean {
  return url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions");
}

export function createCodexFetch(
  initial: CodexCredential,
  opts: { endpoint?: string; issuer?: string; fetchImpl?: typeof fetch } = {},
): typeof fetch {
  let credential = { ...initial };
  let refreshPromise: Promise<CodexCredential> | undefined;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? process.env.CODEX_API_ENDPOINT ?? DEFAULT_CODEX_API_ENDPOINT;

  return async (input, init) => {
    if (codexCredentialNeedsRefresh(credential)) {
      refreshPromise ??= refreshCodexCredential(credential, { issuer: opts.issuer, fetchImpl }).finally(() => {
        refreshPromise = undefined;
      });
      credential = await refreshPromise;
    }

    const headers = headersFrom(input, init);
    headers.set("authorization", `Bearer ${credential.accessToken}`);
    if (credential.accountId) headers.set("ChatGPT-Account-Id", credential.accountId);

    const url = requestUrl(input);
    const target = shouldUseCodexEndpoint(url) ? endpoint : input;
    return fetchImpl(target, { ...init, headers });
  };
}
