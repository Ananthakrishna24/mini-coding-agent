// Offline self-check for the @-mention file ranking — no fs/network. Run: npm run check
import assert from "node:assert/strict";
import { rankFiles } from "./tools/workspace";

const files = ["src/app.tsx", "src/store.ts", "src/tools/workspace.ts", "README.md", "package.json"];

// empty query keeps natural order, capped
assert.deepEqual(rankFiles(files, ""), files);
assert.equal(rankFiles(files, "", 2).length, 2);

// basename-startswith ranks ahead of a deeper path-substring match
assert.deepEqual(rankFiles(files, "app"), ["src/app.tsx"]);

// case-insensitive; non-matches drop
assert.deepEqual(rankFiles(files, "README"), ["README.md"]);
assert.deepEqual(rankFiles(files, "zzz"), []);

// basename-startswith (workspace.ts) beats path-only substring (none here) — and path-startswith ("src/")
const ranked = rankFiles(files, "s");
assert.equal(ranked[0], "src/store.ts"); // store basename starts with "s" → tier 0, before path-startswith

console.log("workspace.check ok");
