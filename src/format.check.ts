// Offline self-check for the spinner verb helpers — no model/network. Run: npm run check
import assert from "node:assert/strict";
import { toolVerb, thinkingVerb } from "./format";

// known tools map to a present-tense action; unknown tools fall back to their raw name
assert.equal(toolVerb("read_file"), "Reading");
assert.equal(toolVerb("run_bash"), "Running");
assert.equal(toolVerb("totally_unknown"), "totally_unknown");

// thinkingVerb always returns a non-empty word from the pool (catches bad index math / empty pool)
for (let i = 0; i < 100; i++) {
  const v = thinkingVerb();
  assert.ok(typeof v === "string" && v.length > 0, `bad verb: ${JSON.stringify(v)}`);
}

console.log("ok — format self-check passed");
