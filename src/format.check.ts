// Offline self-check for the spinner verb helpers + model summary — no model/network. Run: npm run check
import assert from "node:assert/strict";
import { toolVerb, thinkingVerb, describeModel } from "./format";
import type { ModelInfo } from "./llm"; // type-only — does not execute llm.ts (which needs an API key)

// known tools map to a present-tense action; unknown tools fall back to their raw name
assert.equal(toolVerb("read_file"), "Reading");
assert.equal(toolVerb("run_bash"), "Running");
assert.equal(toolVerb("totally_unknown"), "totally_unknown");

// describeModel: full catalog entry shows context + price + provider; an OpenAI-style entry (no
// context/price) skips those fields instead of printing "0 · $0.00/..." but still tags the provider.
const full: ModelInfo = { id: "deepseek/v4", name: "v4", context: 131000, promptPrice: 0.5, completionPrice: 1.5, tools: true, reasoning: false, vision: false, provider: "openrouter" };
const summ = describeModel(full, full.id);
assert.ok(summ.includes("131K") && summ.includes("per 1M") && summ.includes("openrouter"), `full summary: ${summ}`);
const bare: ModelInfo = { id: "gpt-5.5", name: "gpt-5.5", context: 0, promptPrice: 0, completionPrice: 0, tools: true, reasoning: true, vision: true, provider: "openai" };
const bareSumm = describeModel(bare, bare.id);
assert.ok(!bareSumm.includes("per 1M") && !bareSumm.includes("0 ·"), `bare summary should skip empty fields: ${bareSumm}`);
assert.ok(bareSumm.includes("gpt-5.5") && bareSumm.includes("openai"), `bare summary: ${bareSumm}`);
assert.equal(describeModel(undefined, "raw-id"), "raw-id"); // no catalog entry → just the id

// thinkingVerb always returns a non-empty word from the pool (catches bad index math / empty pool)
for (let i = 0; i < 100; i++) {
  const v = thinkingVerb();
  assert.ok(typeof v === "string" && v.length > 0, `bad verb: ${JSON.stringify(v)}`);
}

console.log("ok — format self-check passed");
