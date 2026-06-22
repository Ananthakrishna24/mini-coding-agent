// Offline self-check for the tools layer — no model/network needed. Run: npm run check
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { dispatch, capResult } from "./tools";

// capResult: small results pass through; big ones keep head + tail and mark what was cut.
assert.equal(capResult("short"), "short");
const big = capResult("A".repeat(20_000) + "ZZZ");
assert.ok(big.length < 20_000, "big result was trimmed");
assert.ok(big.startsWith("AAA"), "kept the head");
assert.ok(big.endsWith("ZZZ"), "kept the tail");
assert.match(big, /chars omitted/);

const f = ".agent-check.tmp";

// write -> read roundtrip
assert.match(await dispatch("write_file", JSON.stringify({ path: f, content: "hello" })), /wrote 5 bytes/);
assert.equal(await dispatch("read_file", JSON.stringify({ path: f })), "hello");
await fs.rm(f);

// run_bash returns stdout + exit code
assert.match(await dispatch("run_bash", JSON.stringify({ command: "echo hi" })), /exit 0\nhi/);

// trust-boundary failures come back as results, never thrown
assert.match(await dispatch("read_file", JSON.stringify({ path: "../../../etc/passwd" })), /escapes workspace/);
assert.match(await dispatch("nope", "{}"), /unknown tool/);
assert.match(await dispatch("read_file", "{bad"), /not valid JSON/);
assert.match(await dispatch("write_file", JSON.stringify({ path: 1 })), /must be strings/);

console.log("ok — tools self-check passed");
