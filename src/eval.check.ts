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
import { parseTrajectory, computeMetrics, formatMetrics, type Metrics } from "./eval/metrics";
import { DIMENSIONS, rubricText } from "./eval/rubrics";
import { prepareJudging, finalizeJudging } from "./eval/judge";

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

// Metrics: derived correctly from a synthetic trajectory, tolerant of junk lines.
const trajectory = [
  JSON.stringify({ type: "assistant", turn: 0, depth: 0, content: "", tool_calls: [{ name: "read_file", arguments: "{}" }] }),
  JSON.stringify({ type: "usage", turn: 0, depth: 0, prompt_tokens: 1000, completion_tokens: 50 }),
  JSON.stringify({ type: "tool_result", turn: 0, depth: 0, name: "read_file", args: "{}", result: "file contents" }),
  JSON.stringify({ type: "assistant", turn: 1, depth: 0, content: "hmm", tool_calls: [] }),
  JSON.stringify({ type: "tool_result", turn: 2, depth: 0, name: "edit_file", args: "{}", result: "error: 'old_string' not found in the file" }),
  JSON.stringify({ type: "assistant", turn: 3, depth: 1, content: "subagent turn", tool_calls: [{ name: "grep", arguments: "{}" }] }),
  JSON.stringify({ type: "compaction", turn: 3, depth: 0, tier: "micro", tokensFreed: 500 }),
  "not json",
  JSON.stringify({ type: "final", depth: 0, success: true, summary: "done", turns: 4 }),
].join("\n");
const events = parseTrajectory(trajectory);
assert.equal(events.length, 8, "junk lines are skipped");
const m = computeMetrics(events);
assert.equal(m.turns, 2, "only depth-0 assistant events count as turns");
assert.equal(m.bareResponses, 1, "an assistant message without tool calls counts as bare");
assert.equal(m.toolCalls, 2, "tool results are counted");
assert.equal(m.toolErrors, 1, "error: results are counted");
assert.equal(m.editFailures, 1, "edit_file errors are counted as edit misses");
assert.equal(m.promptTokens, 1000, "usage is summed");
assert.equal(m.compactions, 1, "compaction events are counted");
assert.ok(formatMetrics(m).includes("turns 2"), "formatMetrics renders the turn count");

// Rubric: every dimension has anchors, and the rendered rubric names them all.
assert.ok(DIMENSIONS.length >= 4, "rubric has at least four dimensions");
for (const d of DIMENSIONS) {
  assert.ok(d.high.length > 10 && d.low.length > 10, `${d.name} has written anchors`);
  assert.ok(rubricText().includes(d.name), `${d.name} appears in the rendered rubric`);
}

// Gauntlet: split tags are valid and both splits are populated.
for (const c of cases) assert.ok(!c.split || c.split === "train" || c.split === "holdout", `${c.name} split tag is valid`);
assert.ok(cases.some((c) => (c.split ?? "train") === "train"), "train split is non-empty");
assert.ok(cases.some((c) => c.split === "holdout"), "holdout split is non-empty");

// New gauntlet checks grade hand-built outcomes correctly.
const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "minicode-eval-check2-"));
try {
  const reread = byName("reread-loop");
  fs.writeFileSync(path.join(ws2, "counter.txt"), "3");
  assert.equal(reread.check({ workspace: ws2, exitCode: 0, stdout: "" }), true, "reread-loop passes at 3");
  fs.writeFileSync(path.join(ws2, "counter.txt"), "1");
  assert.equal(typeof reread.check({ workspace: ws2, exitCode: 0, stdout: "" }), "string", "reread-loop fails below 3");

  const prose = byName("prose-drift-bait");
  assert.equal(prose.check({ workspace: ws2, exitCode: 0, stdout: "there are 4 TODO items" }), true, "prose-drift passes on exit 0 with the right count");
  assert.equal(typeof prose.check({ workspace: ws2, exitCode: 1, stdout: "there are 4 TODO items" }), "string", "prose-drift fails on non-zero exit");

  const hostile = byName("hostile-whitespace-edit");
  hostile.setup!(ws2);
  assert.equal(typeof hostile.check({ workspace: ws2, exitCode: 0, stdout: "" }), "string", "hostile-whitespace fails on the seeded file");
  fs.writeFileSync(path.join(ws2, "legacy.js"), fs.readFileSync(path.join(ws2, "legacy.js"), "utf8").replace("* 0.9", "* 0.85"));
  assert.equal(hostile.check({ workspace: ws2, exitCode: 0, stdout: "" }), true, "hostile-whitespace passes after the targeted edit");
} finally {
  fs.rmSync(ws2, { recursive: true, force: true });
}

// Harness judging: prepare emits packets for passing runs only; finalize validates score.json,
// zeros failed runs, and computes gated means.
const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "minicode-judge-check-"));
try {
  const emptyMetrics: Metrics = { turns: 3, promptTokens: 100, completionTokens: 10, toolCalls: 2, toolErrors: 0, editFailures: 0, bareResponses: 0, compactions: 0 };
  const mkRun = (name: string, pass: boolean) => {
    const dir = path.join(resultsDir, "model", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "diff.patch"), "--- a/x\n+++ b/x\n");
    return { case: name, model: "m", repeat: 1, pass, detail: pass ? "" : "boom", ms: 1, goal: "do the thing", split: "train", summary: "did it", metrics: emptyMetrics, dir };
  };
  const records = [mkRun("good-run", true), mkRun("bad-run", false)];
  fs.writeFileSync(path.join(resultsDir, "run.json"), JSON.stringify({ records }));

  const { pending, skipped } = prepareJudging(resultsDir);
  assert.equal(pending, 1, "only the passing run needs a score");
  assert.equal(skipped, 1, "the failing run is skipped");
  assert.ok(fs.existsSync(path.join(resultsDir, "JUDGING.md")), "judging brief is written");
  assert.ok(fs.existsSync(path.join(records[0].dir, "judge-packet.md")), "passing run gets a packet");
  assert.ok(!fs.existsSync(path.join(records[1].dir, "judge-packet.md")), "failing run gets no packet");

  assert.throws(() => finalizeJudging(resultsDir), /missing score\.json/, "finalize demands a score for every passing run");

  const validScores = Object.fromEntries(DIMENSIONS.map((d) => [d.name, 4]));
  fs.writeFileSync(path.join(records[0].dir, "score.json"), JSON.stringify({ scores: { ...validScores, [DIMENSIONS[0].name]: 6 }, worst_moment: "x" }));
  assert.throws(() => finalizeJudging(resultsDir), /must be an integer 1–5/, "out-of-range scores are rejected");

  fs.writeFileSync(path.join(records[0].dir, "score.json"), JSON.stringify({ scores: validScores, worst_moment: "took a detour" }));
  const report = finalizeJudging(resultsDir, "check");
  assert.equal(report.passRate, 0.5, "pass rate counts all runs");
  assert.equal(report.meanQualityOverPasses, 4, "mean quality is over passing runs only");
  assert.equal(report.runs.find((r) => r.case === "bad-run")!.mean, 0, "failed runs score 0");
  assert.ok(fs.existsSync(path.join(resultsDir, "quality.json")), "quality.json is written");
} finally {
  fs.rmSync(resultsDir, { recursive: true, force: true });
}

console.log("ok — eval self-check passed");
