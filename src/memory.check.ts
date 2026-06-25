// Offline self-check for cross-run memory. Run: npm run check:memory
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMemory, MEMORY_FILE, memoryBudget } from "./memory";

const tmp = mkdtempSync(path.join(tmpdir(), "mem-"));
const cleanup = () => { try { rmSync(tmp, { recursive: true }); } catch {} };

// --- memoryBudget tests ---

// Default when no window is known → MAX_CHARS
assert.equal(memoryBudget(), 16_000);
assert.equal(memoryBudget(0), 16_000);

// Small model (32K window) → floor at MIN_CHARS
assert.equal(memoryBudget(32_000), 4_000);

// Standard model (128K window) → 4% of 128K = 5120
assert.equal(memoryBudget(128_000), 5_120);

// Large model (1M window) → capped at MAX_CHARS
assert.equal(memoryBudget(1_048_576), 16_000);

// --- loadMemory tests ---

// missing → empty
assert.equal(loadMemory(tmp), "");

// blank → empty
writeFileSync(path.join(tmp, MEMORY_FILE), "   \n\n  ");
assert.equal(loadMemory(tmp), "");

// present → wrapped
writeFileSync(path.join(tmp, MEMORY_FILE), "Build: npm run build");
const mem = loadMemory(tmp);
assert.ok(mem.includes("<memory>"));
assert.ok(mem.includes("</memory>"));
assert.ok(mem.includes("Build: npm run build"));
assert.ok(mem.includes(MEMORY_FILE));

// binary → skipped
writeFileSync(path.join(tmp, MEMORY_FILE), "good\0bad");
assert.equal(loadMemory(tmp), "");

// over-long → truncated (using small window for tighter budget)
const longContent = "x".repeat(20_000);
writeFileSync(path.join(tmp, MEMORY_FILE), longContent);
const truncated = loadMemory(tmp, 32_000); // 32K window → 4K char budget
assert.ok(truncated.includes("<memory>"));
assert.ok(truncated.length < 20_000 + 200, "memory was truncated");

// smart truncation with sections — first and last sections kept
const sectioned = [
  "## Important Conventions\nAlways use TypeScript\n",
  "## Old Notes\nSome old stuff here\n",
  "## More Old Notes\nMore old stuff\n",
  "## Recent Work\nJust finished the API\n",
].join("\n");
writeFileSync(path.join(tmp, MEMORY_FILE), sectioned);
const smartMem = loadMemory(tmp, 32_000); // tight budget
assert.ok(smartMem.includes("Important Conventions"), "first section preserved");
assert.ok(smartMem.includes("Recent Work"), "last section preserved");

cleanup();
console.log("ok — memory self-check passed (with adaptive budget + smart truncation)");
