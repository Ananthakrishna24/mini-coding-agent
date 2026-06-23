// Offline self-check for delegation — no model/network. Run: npm run check
// Covers the pure pieces: the depth cap, the fan-out cap, depth-scoped schemas, and the boundary
// validators. Real parallel recursion needs the model, so the multi-agent run is a manual check.
import assert from "node:assert/strict";
import { canSpawn, MAX_DEPTH, MAX_FANOUT, canFanOut, formatSubResult, parseSpawnArgs } from "./tools/spawn_agent";
import { schemasFor, dispatch, toolName } from "./tools";

const names = (depth: number) => schemasFor(depth).map(toolName);

// Depth cap: the top agent and a first-level subagent may delegate; the run at the cap may not, so a
// chain of subagents always terminates.
assert.equal(canSpawn(0), true, "the top agent (depth 0) may delegate");
assert.equal(canSpawn(MAX_DEPTH - 1), true, "a subagent below the cap may delegate one more level");
assert.equal(canSpawn(MAX_DEPTH), false, "a run at the depth cap may not delegate");

// Fan-out cap: a turn may launch up to MAX_FANOUT subagents at once, no more.
assert.equal(canFanOut(MAX_FANOUT), true, "spawning up to the fan-out cap is allowed");
assert.equal(canFanOut(MAX_FANOUT + 1), false, "spawning past the fan-out cap is refused");

// Depth-scoped schemas: every run gets the full toolset (a subagent can write and verify, not just
// read). spawn_agent is offered while below the cap and dropped at it; final_answer rides in every run.
const top = names(0);
assert.ok(top.includes("spawn_agent"), "top agent is offered delegation");
assert.ok(top.includes("write_file") && top.includes("edit_file"), "top agent may write");
const sub = names(1);
assert.ok(sub.includes("spawn_agent"), "a subagent below the cap may still delegate");
assert.ok(sub.includes("write_file") && sub.includes("edit_file"), "a subagent gets the full toolset");
assert.ok(sub.includes("read_file") && sub.includes("run_bash"), "a subagent keeps the read tools too");
assert.ok(sub.includes("final_answer"), "a subagent can still finish");
const capped = names(MAX_DEPTH);
assert.ok(!capped.includes("spawn_agent"), "a run at the depth cap is not offered delegation");

// The permissions gate still applies to every run: a denied call comes back as a recoverable result,
// not an execution. (rm -rf is on the deny-list in permissions.ts.)
const blocked = await dispatch("run_bash", JSON.stringify({ command: "rm -rf /" }));
assert.match(blocked, /^error: blocked:/, "a denied command is blocked, not executed");

// Boundary validators: a good goal parses; optional model/effort/resume_id validate; bad input throws.
assert.deepEqual(parseSpawnArgs(JSON.stringify({ goal: "  find auth call sites " })), { goal: "find auth call sites" });
assert.deepEqual(
  parseSpawnArgs(JSON.stringify({ goal: "do x", model: " a/b ", effort: "high", resume_id: " sub-1 " })),
  { goal: "do x", model: "a/b", effort: "high", resume_id: "sub-1" },
);
assert.throws(() => parseSpawnArgs(JSON.stringify({ goal: "  " })), /non-empty string/, "a blank goal is rejected");
assert.throws(() => parseSpawnArgs(JSON.stringify({ goal: "x", effort: "turbo" })), /low, medium, or high/, "a bad effort is rejected");
assert.throws(() => parseSpawnArgs("{not json"), /valid JSON/, "non-JSON args are rejected");

// Result framing: success/failure is explicit, and a failure surfaces the id so the parent can resume.
assert.equal(formatSubResult({ success: true, summary: "found 3 call sites" }, "sub-1"), "✓ found 3 call sites");
const fail = formatSubResult({ success: false, summary: "hit turn limit" }, "sub-2");
assert.match(fail, /^✗ subagent sub-2 did not finish:/);
assert.match(fail, /resume_id "sub-2"/, "a failed subagent's result tells the parent how to resume it");

console.log("ok — spawn_agent self-check passed");
