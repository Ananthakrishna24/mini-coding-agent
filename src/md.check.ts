// Offline self-check for the Markdown renderer — no model/network. Run: npm run check
// Tagging palette (B(...) etc.) so the assertions show exactly which span style fired.
import assert from "node:assert/strict";
import { renderMarkdown, type Palette } from "./md";

const P: Palette = {
  bold: (s) => `B(${s})`,
  italic: (s) => `I(${s})`,
  dim: (s) => `D(${s})`,
  heading: (s) => `H(${s})`,
  code: (s) => `C(${s})`,
};

assert.equal(renderMarkdown("**hi** there", P), "B(hi) there", "bold");
assert.equal(renderMarkdown("a *word* here", P), "a I(word) here", "italic");
assert.equal(renderMarkdown("run `npm test`", P), "run C(npm test)", "inline code");
assert.equal(renderMarkdown("## Title", P), "H(Title)", "heading");
assert.equal(renderMarkdown("- item", P), "  • item", "bullet");
assert.equal(renderMarkdown("3. step", P), "  3. step", "numbered");
// code spans are not re-parsed as emphasis
assert.equal(renderMarkdown("`a*b*c`", P), "C(a*b*c)", "code protects its contents");

// pipe table → bold header, dim rule, aligned rows
assert.equal(
  renderMarkdown("| A | B |\n| - | - |\n| 1 | 2 |", P),
  "B(A  B)\nD(─  ─)\n1  2",
  "table aligns and styles",
);

console.log("ok — markdown self-check passed");
