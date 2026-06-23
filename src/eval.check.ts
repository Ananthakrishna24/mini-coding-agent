// Offline self-check for the eval harness — no model/network. Run: npm run check
// Covers the gradable-offline pieces: the file-reading check helper, a representative case's check
// returning pass/fail correctly against a hand-built workspace, and the scorecard tally. The real model
// runs are the manual `npm run eval`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cases, fileText } from "./eval/cases";
import { summarize, type Outcome } from "./eval/run-eval";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "minicode-eval-check-"));
const byName = (name: string) => {
  const c = cases.find((x) => x.name === name);
  assert.ok(c, `case ${name} exists`);
  return c!;
};

try {
  // fileText: present file → contents, missing file → null (the building block for every outcome check).
  fs.writeFileSync(path.join(ws, "hello.txt"), "hi\n");
  assert.equal(fileText(ws, "hello.txt"), "hi\n", "fileText returns the contents of a present file");
  assert.equal(fileText(ws, "nope.txt"), null, "fileText returns null for a missing file");

  // A case's check grades a hand-built workspace: pass when the outcome is right, a reason string when not.
  const createFile = byName("create-file");
  assert.equal(createFile.check({ workspace: ws, exitCode: 0, stdout: "" }), true, "create-file passes when hello.txt = hi");

  fs.writeFileSync(path.join(ws, "hello.txt"), "wrong");
  assert.equal(typeof createFile.check({ workspace: ws, exitCode: 0, stdout: "" }), "string", "create-file fails (with a reason) on wrong contents");

  fs.rmSync(path.join(ws, "hello.txt"));
  assert.match(String(createFile.check({ workspace: ws, exitCode: 0, stdout: "" })), /not created/, "create-file fails clearly when the file is absent");

  // The guardrail case keys off stdout, not the filesystem: it passes only when the block surfaced.
  const guardrail = byName("guardrail-blocks-push");
  assert.equal(guardrail.check({ workspace: ws, exitCode: 1, stdout: "error: blocked: pushes to a remote" }), true, "guardrail passes when 'blocked' is in the output");
  assert.equal(typeof guardrail.check({ workspace: ws, exitCode: 0, stdout: "pushed ok" }), "string", "guardrail fails when no block surfaced");
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}

// summarize: counts passes, flips ok only on a clean sweep, and a FAIL line carries its reason.
const mixed: Outcome[] = [
  { name: "a", pass: true, detail: "", ms: 1000 },
  { name: "b", pass: false, detail: "b.txt was not created", ms: 2000 },
];
const s = summarize(mixed);
assert.equal(s.passed, 1, "one pass counted");
assert.equal(s.total, 2, "two cases counted");
assert.equal(s.ok, false, "ok is false when any case fails");
assert.ok(s.lines.some((l) => l.includes("1/2 passed")), "scorecard reports the tally");
assert.ok(s.lines.some((l) => l.includes("b.txt was not created")), "a failure line carries its reason");

assert.equal(summarize([{ name: "a", pass: true, detail: "", ms: 1 }]).ok, true, "ok is true on a clean sweep");

console.log("ok — eval self-check passed");
