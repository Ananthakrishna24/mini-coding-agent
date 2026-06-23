// Offline self-check for provider resolution + .env merge — no model/network. Run: npm run check
import assert from "node:assert/strict";
import { resolveProvider, mergeEnv, PROVIDERS, reasoningParams, openaiReasons, openaiVision } from "./provider";

// --- resolveProvider ---

// no keys → a clear error, never a throw
{
  const r = resolveProvider({});
  assert.ok("error" in r, "no keys yields an error");
  assert.match(r.error, /OPENROUTER_API_KEY|OPENAI_API_KEY/, "error names the env vars to set");
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

// --- reasoningParams: provider-shaped effort body, or {} when no effort set ---

assert.deepEqual(reasoningParams("openai", null), {}, "no effort → no params");
assert.deepEqual(reasoningParams("openrouter", null), {}, "no effort → no params (openrouter)");
assert.deepEqual(reasoningParams("openai", "high"), { reasoning_effort: "high" }, "openai uses top-level reasoning_effort");
assert.deepEqual(reasoningParams("openrouter", "low"), { reasoning: { effort: "low" } }, "openrouter wraps it in reasoning.effort");

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

console.log("provider.check.ts ok");
