// Offline self-check for provider resolution + .env merge — no model/network. Run: npm run check
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProvider, mergeEnv, PROVIDERS, reasoningParams, openaiReasons, openaiVision, mistralVision } from "./provider";
import { migrateEnvFile } from "./onboarding";
import { createCodexFetch, parseJwtClaims, resolveOpenAICredential } from "./codex_auth";

function tempCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "minicode-codex-auth-"));
}

function jwt(payload: object): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

// --- resolveProvider ---

// no keys → a clear error, never a throw
{
  const r = resolveProvider({});
  assert.ok("error" in r, "no keys yields an error");
  assert.match(r.error, /OPENROUTER_API_KEY|OPENAI_API_KEY|MISTRAL_API_KEY/, "error names the env vars to set");
}

// single key → infer that provider
{
  const r = resolveProvider({ OPENROUTER_API_KEY: "sk-or-x" });
  assert.deepEqual(r, { provider: "openrouter", apiKey: "sk-or-x" }, "openrouter inferred from its key");
}
{
  const r = resolveProvider({ OPENAI_API_KEY: "sk-x" });
  assert.deepEqual(r, { provider: "openai", apiKey: "sk-x" }, "openai inferred from its key");
}
{
  const r = resolveProvider({ MISTRAL_API_KEY: "ms-x" });
  assert.deepEqual(r, { provider: "mistral", apiKey: "ms-x" }, "mistral inferred from its key");
}

// both keys, no PROVIDER → openrouter wins the tie
{
  const r = resolveProvider({ OPENROUTER_API_KEY: "sk-or-x", OPENAI_API_KEY: "sk-x" });
  assert.ok(!("error" in r) && r.provider === "openrouter", "openrouter is the documented default tie-break");
}

// explicit PROVIDER overrides the tie-break (and trims/lowercases)
{
  const r = resolveProvider({ OPENROUTER_API_KEY: "sk-or-x", OPENAI_API_KEY: "sk-x", PROVIDER: " OpenAI " });
  assert.ok(!("error" in r) && r.provider === "openai", "explicit PROVIDER chooses openai over the default");
}

// explicit PROVIDER without its key → error, not a silent fallback to the other one
{
  const r = resolveProvider({ OPENROUTER_API_KEY: "sk-or-x", PROVIDER: "openai" });
  assert.ok("error" in r && /OPENAI_API_KEY/.test(r.error), "PROVIDER=openai needs OPENAI_API_KEY");
}

// explicit PROVIDER=mistral works
{
  const r = resolveProvider({ MISTRAL_API_KEY: "ms-x", PROVIDER: "mistral" });
  assert.ok(!("error" in r) && r.provider === "mistral", "explicit PROVIDER=mistral works");
}

// explicit PROVIDER=openai can use Codex/ChatGPT auth instead of an API key
{
  const r = resolveProvider({ PROVIDER: "openai", CODEX_ACCESS_TOKEN: jwt({ chatgpt_account_id: "acc-1", exp: 4_102_444_800 }) });
  assert.deepEqual(r, { provider: "openai", apiKey: "codex-login", authMode: "codex" }, "openai can resolve from CODEX_ACCESS_TOKEN");
}

// OPENAI_AUTH=codex forces Codex auth even if an OpenAI API key is present
{
  const r = resolveProvider({
    PROVIDER: "openai",
    OPENAI_API_KEY: "sk-x",
    OPENAI_AUTH: "codex",
    CODEX_ACCESS_TOKEN: jwt({ chatgpt_account_id: "acc-2", exp: 4_102_444_800 }),
  });
  assert.deepEqual(r, { provider: "openai", apiKey: "codex-login", authMode: "codex" }, "OPENAI_AUTH=codex forces Codex auth");
}

// Codex file auth is read from CODEX_HOME/auth.json when available
{
  const home = tempCodexHome();
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-file" }, exp: 4_102_444_800 }),
      refresh_token: "refresh-file",
    },
  }));
  const credential = resolveOpenAICredential({ CODEX_HOME: home });
  assert.ok(credential && !("error" in credential) && credential.kind === "codex", "auth.json yields Codex credential");
  assert.equal(credential.accountId, "acc-file", "account id is extracted from Codex token claims");
  const r = resolveProvider({ PROVIDER: "openai", CODEX_HOME: home });
  assert.deepEqual(r, { provider: "openai", apiKey: "codex-login", authMode: "codex" }, "openai can resolve from Codex auth.json");
}

// mistral loses tie-break to openrouter and openai
{
  const r = resolveProvider({ OPENROUTER_API_KEY: "sk-or-x", MISTRAL_API_KEY: "ms-x" });
  assert.ok(!("error" in r) && r.provider === "openrouter", "openrouter beats mistral in tie-break");
}
{
  const r = resolveProvider({ OPENAI_API_KEY: "sk-x", MISTRAL_API_KEY: "ms-x" });
  assert.ok(!("error" in r) && r.provider === "openai", "openai beats mistral in tie-break");
}

// unknown PROVIDER → error
{
  const r = resolveProvider({ OPENAI_API_KEY: "sk-x", PROVIDER: "azure" });
  assert.ok("error" in r && /not recognized/.test(r.error), "unknown provider is rejected");
}

// blank/whitespace key doesn't count as present
{
  const r = resolveProvider({ OPENROUTER_API_KEY: "   " });
  assert.ok("error" in r, "a whitespace-only key is treated as missing");
}

// every provider has a usable default model id
for (const [name, conf] of Object.entries(PROVIDERS)) {
  assert.ok(conf.defaultModel.length > 0, `${name} has a default model`);
  assert.ok(conf.keyVar.endsWith("_API_KEY"), `${name} key var looks like an env key`);
}

// --- mergeEnv ---

// add into an empty file
assert.equal(mergeEnv("", { OPENAI_API_KEY: "sk-x" }), "OPENAI_API_KEY=sk-x\n", "writes a key into an empty .env");

// update in place, preserving position and unrelated lines + comments
{
  const before = "# header\nOPENROUTER_API_KEY=old\nFOO=bar\n";
  const after = mergeEnv(before, { OPENROUTER_API_KEY: "new" });
  assert.match(after, /# header/, "comment kept");
  assert.match(after, /FOO=bar/, "unrelated key kept");
  assert.match(after, /OPENROUTER_API_KEY=new/, "target key updated");
  assert.ok(!/=old/.test(after), "old value gone");
  assert.ok(after.indexOf("OPENROUTER_API_KEY") < after.indexOf("FOO"), "original line position preserved");
}

// append a new key while keeping existing ones
{
  const after = mergeEnv("OPENROUTER_API_KEY=a\n", { OPENAI_API_KEY: "b", PROVIDER: "openai" });
  assert.match(after, /OPENROUTER_API_KEY=a/, "existing key untouched");
  assert.match(after, /OPENAI_API_KEY=b/, "new key appended");
  assert.match(after, /PROVIDER=openai/, "second new key appended");
}

// null value removes a key
{
  const after = mergeEnv("A=1\nB=2\n", { A: null });
  assert.ok(!/A=1/.test(after), "removed key is gone");
  assert.match(after, /B=2/, "other key remains");
}

// exactly one trailing newline regardless of input
assert.equal(mergeEnv("A=1\n\n\n", { B: "2" }).endsWith("2\n"), true, "single trailing newline");
assert.ok(!mergeEnv("A=1", { B: "2" }).endsWith("\n\n"), "no double trailing newline");

// --- Codex fetch bridge: redirects model calls and refreshes expired file-backed tokens ---

assert.deepEqual(parseJwtClaims(jwt({ chatgpt_account_id: "acc-jwt" }))?.chatgpt_account_id, "acc-jwt", "JWT claims parse");

{
  let seenUrl = "";
  let seenHeaders = new Headers();
  let seenBody: any;
  const fakeFetch: typeof fetch = async (input, init) => {
    seenUrl = input.toString();
    seenHeaders = new Headers(init?.headers);
    seenBody = JSON.parse(String(init?.body));
    return Response.json({ ok: true });
  };

  const codexFetch = createCodexFetch(
    { kind: "codex", accessToken: "access-current", accountId: "acc-3", source: "env" },
    { endpoint: "https://chatgpt.test/backend-api/codex/responses", fetchImpl: fakeFetch },
  );
  await codexFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: "Bearer old", "x-test": "1" },
    body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
  });

  assert.equal(seenUrl, "https://chatgpt.test/backend-api/codex/responses", "Responses calls route through Codex endpoint");
  assert.equal(seenHeaders.get("authorization"), "Bearer access-current", "Codex bearer token replaces SDK auth");
  assert.equal(seenHeaders.get("ChatGPT-Account-Id"), "acc-3", "Codex account id is forwarded");
  assert.equal(seenHeaders.get("x-test"), "1", "non-auth headers are preserved");
  assert.deepEqual(seenBody, { model: "gpt-test", input: "hello", stream: true }, "Codex fetch leaves the SDK request body intact");
}

{
  const home = tempCodexHome();
  const authPath = path.join(home, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: jwt({ chatgpt_account_id: "old", exp: 1 }),
      refresh_token: "refresh-old",
    },
  }));

  let refreshes = 0;
  let seenAuth = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = input.toString();
    if (url.endsWith("/oauth/token")) {
      refreshes++;
      assert.match(String(init?.body), /refresh_token=refresh-old/, "refresh token is sent to OpenAI auth");
      return Response.json({
        access_token: "access-new",
        refresh_token: "refresh-new",
        id_token: jwt({ chatgpt_account_id: "new" }),
        expires_in: 3600,
      });
    }
    seenAuth = new Headers(init?.headers).get("authorization") ?? "";
    return new Response("{}", { status: 200 });
  };

  const credential = resolveOpenAICredential({ CODEX_HOME: home });
  assert.ok(credential && !("error" in credential) && credential.kind === "codex", "expired file token still loads");
  const codexFetch = createCodexFetch(credential, {
    endpoint: "https://chatgpt.test/backend-api/codex/responses",
    issuer: "https://auth.test",
    fetchImpl: fakeFetch,
  });

  await codexFetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" });
  const saved = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.equal(refreshes, 1, "expired Codex token is refreshed once");
  assert.equal(seenAuth, "Bearer access-new", "request uses refreshed token");
  assert.equal(saved.tokens.access_token, "access-new", "refreshed token is saved back to auth.json");
  assert.equal(saved.tokens.refresh_token, "refresh-new", "rotated refresh token is saved back to auth.json");
  assert.equal(saved.tokens.account_id, "new", "refreshed account id is saved back to auth.json");
}

// --- reasoningParams: provider-shaped effort body, or {} when no effort set ---

assert.deepEqual(reasoningParams("openai", null), {}, "no effort → no params");
assert.deepEqual(reasoningParams("openrouter", null), {}, "no effort → no params (openrouter)");
assert.deepEqual(reasoningParams("openai", "high"), { reasoning_effort: "high" }, "openai uses top-level reasoning_effort");
assert.deepEqual(reasoningParams("openrouter", "low"), { reasoning: { effort: "low" } }, "openrouter wraps it in reasoning.effort");
assert.deepEqual(reasoningParams("mistral", "high"), {}, "mistral ignores reasoning effort");

// --- openaiReasons: which OpenAI ids take an effort knob ---

for (const id of ["o1", "o3-mini", "o4", "gpt-5", "gpt-5.5"]) {
  assert.ok(openaiReasons(id), `${id} is a reasoning model`);
}
for (const id of ["gpt-4o", "gpt-4.1", "chatgpt-4o-latest"]) {
  assert.ok(!openaiReasons(id), `${id} is not a reasoning model`);
}

for (const id of ["gpt-4o", "gpt-4.1", "gpt-5.5", "o3", "o4-mini", "chatgpt-4o-latest"]) {
  assert.ok(openaiVision(id), `${id} accepts image input`);
}
for (const id of ["gpt-3.5-turbo", "o1-mini", "o3-mini"]) {
  assert.ok(!openaiVision(id), `${id} is text-only`);
}

// --- mistralVision: pixtral models accept images ---

for (const id of ["pixtral-large-latest", "pixtral-12b-2409"]) {
  assert.ok(mistralVision(id), `${id} accepts image input`);
}
for (const id of ["mistral-large-latest", "mistral-small-latest", "codestral-latest"]) {
  assert.ok(!mistralVision(id), `${id} is text-only`);
}
// --- migrateEnvFile ---
{
  const tmpFile = path.resolve(process.cwd(), ".env.test-migration");

  // Case 1: single key, no PROVIDER -> adds PROVIDER
  fs.writeFileSync(tmpFile, "OPENROUTER_API_KEY=sk-or-123\nAGENT_MODEL=some-model\n");
  migrateEnvFile(tmpFile);
  const content1 = fs.readFileSync(tmpFile, "utf8");
  assert.match(content1, /PROVIDER=openrouter/, "should migrate and add PROVIDER=openrouter");

  // Case 2: PROVIDER already present -> no change
  fs.writeFileSync(tmpFile, "OPENROUTER_API_KEY=sk-or-123\nPROVIDER=openai\n");
  migrateEnvFile(tmpFile);
  const content2 = fs.readFileSync(tmpFile, "utf8");
  assert.match(content2, /PROVIDER=openai/, "should preserve existing PROVIDER");
  assert.ok(!/PROVIDER=openrouter/.test(content2), "should not overwrite existing PROVIDER");

  // Case 3: multiple keys, no PROVIDER -> no change
  fs.writeFileSync(tmpFile, "OPENROUTER_API_KEY=sk-or-123\nOPENAI_API_KEY=sk-oa-123\n");
  migrateEnvFile(tmpFile);
  const content3 = fs.readFileSync(tmpFile, "utf8");
  assert.ok(!/PROVIDER=/.test(content3), "should not guess PROVIDER when multiple keys exist");

  // Cleanup
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
}

console.log("provider.check.ts ok");
