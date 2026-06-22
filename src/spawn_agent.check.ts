// Offline self-check for delegation (Task 6.1) — no model/network. Run: npm run check
// Covers the pure pieces: the depth cap, depth-scoped schemas, the read-only allow-set at dispatch,
// and the boundary validators. The recursion itself needs the model, so the two-agent run is a manual
// check, not an offline one.
import assert from "node:assert/strict";
import { canSpawn, MAX_DEPTH, formatSubResult, parseSpawnArgs } from "./tools/spawn_agent";
import { schemasFor, dispatch, toolName } from "./tools";

const names = (depth: number) => schemasFor(depth).map(toolName);

// Depth cap: the top agent may delegate; a run at the cap may not (so recursion terminates).
assert.equal(canSpawn(0), true, "the top agent (depth 0) may delegate");
assert.equal(canSpawn(MAX_DEPTH), false, "a run at the depth cap may not delegate");

// Depth-scoped schemas: the top agent sees the full toolset + spawn_agent; a subagent sees neither
// spawn_agent (can't recurse) nor the write tools (read-only), but still gets final_answer (must finish).
const top = names(0);
assert.ok(top.includes("spawn_agent"), "top agent is offered delegation");
assert.ok(top.includes("write_file") && top.includes("edit_file"), "top agent may write");
const sub = names(1);
assert.ok(!sub.includes("spawn_agent"), "a subagent is not offered delegation (can't recurse)");
assert.ok(!sub.includes("write_file") && !sub.includes("edit_file"), "a subagent can't write");
assert.ok(sub.includes("read_file") && sub.includes("run_bash"), "a subagent keeps the read-only tools");
assert.ok(sub.includes("final_answer"), "a subagent can still finish");

// Allow-set at dispatch (defence-in-depth): even if a subagent hallucinates a write call, it's blocked
// as a recoverable result, not run. A read stays allowed.
const allow = new Set(["read_file", "run_bash"]);
const blocked = await dispatch("write_file", JSON.stringify({ path: "x", content: "y" }), allow);
assert.match(blocked, /^error: blocked:/, "a write from a subagent is blocked, not executed");
assert.ok(!blocked.includes("wrote"), "the blocked write never touched the filesystem");

// Boundary validators: a good goal parses; a blank or non-JSON one throws a fix-it message.
assert.deepEqual(parseSpawnArgs(JSON.stringify({ goal: "  find auth call sites " })), { goal: "find auth call sites" });
assert.throws(() => parseSpawnArgs(JSON.stringify({ goal: "  " })), /non-empty string/, "a blank goal is rejected");
assert.throws(() => parseSpawnArgs("{not json"), /valid JSON/, "non-JSON args are rejected");

// Result framing: success/failure is explicit so the parent can react.
assert.equal(formatSubResult({ success: true, summary: "found 3 call sites" }), "✓ found 3 call sites");
assert.match(formatSubResult({ success: false, summary: "hit turn limit" }), /^✗ subagent did not finish:/);

console.log("ok — spawn_agent self-check passed");
