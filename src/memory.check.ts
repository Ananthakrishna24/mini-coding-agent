// Offline self-check for cross-run memory (Task 5.2) — no model/network. Run: npm run check
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMemory, MEMORY_FILE } from "./memory";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mem-"));
const file = path.join(dir, MEMORY_FILE);

// missing file → no memory, never throws (a fresh project must still run)
assert.equal(loadMemory(dir), "", "missing AGENT.md yields no memory section");

// blank / whitespace-only file → no dangling heading in the prompt
fs.writeFileSync(file, "   \n\t\n");
assert.equal(loadMemory(dir), "", "blank AGENT.md yields no memory section");

// present file → wrapped section with provenance + the actual content
fs.writeFileSync(file, "Build with `npm run check`.");
const loaded = loadMemory(dir);
assert.match(loaded, /^<memory>\n/, "opens with the memory data-fence");
assert.match(loaded, /<\/memory>$/, "closes the memory data-fence");
assert.match(loaded, /loaded from AGENT\.md/, "names the source file so the model knows what to edit");
assert.match(loaded, /verify against the current code/, "carries the don't-trust-blindly caveat");
assert.match(loaded, /Build with `npm run check`\./, "includes the file's content");

// binary / corrupt file → skipped, not injected into the prompt (NUL built via fromCharCode to keep
// this source file NUL-free, matching read-text)
fs.writeFileSync(file, "notes" + String.fromCharCode(0) + "more");
assert.equal(loadMemory(dir), "", "a file with NUL bytes is skipped, not loaded into context");

// over-long file → trimmed, not refused; bounded length + an explicit trim nudge
fs.writeFileSync(file, "x".repeat(20_000));
const capped = loadMemory(dir);
assert.ok(capped.length < 20_000, "over-long memory is trimmed, not loaded whole");
assert.match(capped, /memory truncated/, "truncation is announced so the file gets trimmed");

fs.rmSync(dir, { recursive: true, force: true });
console.log("ok — memory self-check passed");
