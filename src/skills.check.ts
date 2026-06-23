// Offline self-check for the skills loader — no model/network. Run: npm run check
// Covers the gradable logic: the bundled skills are discovered with descriptions, the prompt block lists
// them, read_skill returns a body for a real skill, and an untrusted name can't escape the skills dir.
import assert from "node:assert/strict";
import { listSkills, skillsPromptBlock, readSkill } from "./skills";

const skills = listSkills();

// The two seeded skills are discovered, each with a non-empty description.
for (const name of ["frontend-design", "design-thinking"]) {
  const s = skills.find((x) => x.name === name);
  assert.ok(s, `skill ${name} is discovered`);
  assert.ok(s!.description.length > 0, `skill ${name} has a description`);
}

// The prompt block lists every discovered skill under a Skills heading.
const block = skillsPromptBlock();
assert.match(block, /## Skills/, "prompt block has a Skills heading");
for (const s of skills) assert.ok(block.includes(s.name), `prompt block lists ${s.name}`);

// read_skill returns the full body for a real skill...
assert.match(readSkill("frontend-design"), /# Frontend Design/, "read_skill returns the skill body");

// ...and refuses anything outside the known set — including path traversal, absolute paths, non-strings.
for (const bad of ["../package", "../../etc/passwd", "/etc/passwd", "nope", "", 42 as any]) {
  assert.throws(() => readSkill(bad), /no skill/, `read_skill rejects ${JSON.stringify(bad)}`);
}

console.log("ok — skills self-check passed");
