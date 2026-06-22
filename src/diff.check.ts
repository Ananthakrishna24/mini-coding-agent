// Offline self-check for the line differ — no model/network. Run: npm run check
import assert from "node:assert/strict";
import { diffLines } from "./diff";

// one line swapped between two kept lines: keep, remove old, add new, keep
assert.deepEqual(diffLines(["a", "b", "c"], ["a", "B", "c"]), [
  { tag: " ", text: "a" },
  { tag: "-", text: "b" },
  { tag: "+", text: "B" },
  { tag: " ", text: "c" },
]);

// pure addition at the end
assert.deepEqual(diffLines(["x"], ["x", "y"]), [
  { tag: " ", text: "x" },
  { tag: "+", text: "y" },
]);

// pure deletion
assert.deepEqual(diffLines(["x", "y"], ["x"]), [
  { tag: " ", text: "x" },
  { tag: "-", text: "y" },
]);

// identical input → everything kept, nothing flagged
assert.deepEqual(diffLines(["x"], ["x"]), [{ tag: " ", text: "x" }]);

console.log("ok — diff self-check passed");
