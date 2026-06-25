// Offline self-check for the tools layer — no model/network needed. Run: npm run check
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { dispatch, capResult, parseFinalAnswer } from "./tools";

// capResult: small results pass through; big ones keep head + tail and mark what was cut.
assert.equal(capResult("short"), "short");
const big = capResult("A".repeat(20_000) + "ZZZ");
assert.ok(big.length < 20_000, "big result was trimmed");
assert.ok(big.startsWith("AAA"), "kept the head");
assert.ok(big.endsWith("ZZZ"), "kept the tail");
assert.match(big, /chars omitted/);

const f = ".agent-check.tmp";

// write -> read roundtrip (whole file: no header, byte-identical). New files can be written;
// overwriting existing files requires a prior whole-file read.
assert.match(await dispatch("write_file", JSON.stringify({ path: f, content: "hello" })), /wrote 5 bytes/);
assert.equal(await dispatch("read_file", JSON.stringify({ path: f })), "hello");
assert.match(await dispatch("write_file", JSON.stringify({ path: f, content: "hello!" })), /wrote 6 bytes/);
assert.equal(await dispatch("read_file", JSON.stringify({ path: f })), "hello!");
await fs.rm(f);

// read_file line window: offset/limit page through a file, with a 1-based "# lines X-Y of Z" header
const lf = ".agent-check-lines.tmp";
await dispatch("write_file", JSON.stringify({ path: lf, content: "L1\nL2\nL3\nL4\nL5" }));
const win = await dispatch("read_file", JSON.stringify({ path: lf, offset: 2, limit: 2 }));
assert.match(win, /^# lines 2-3 of 5\n/, "window reports its 1-based range and total");
assert.match(win, /L2\nL3/, "returned exactly the requested lines");
assert.ok(!win.includes("L1") && !win.includes("L4"), "excluded lines outside the window");
// offset past EOF is an empty window, not a crash
assert.match(await dispatch("read_file", JSON.stringify({ path: lf, offset: 99 })), /# lines 99-98 of 5/);
// bad window values are rejected at the boundary, as results not throws
assert.match(await dispatch("read_file", JSON.stringify({ path: lf, offset: 0 })), /'offset' must be a positive integer/);
assert.match(await dispatch("read_file", JSON.stringify({ path: lf, limit: -1 })), /'limit' must be a positive integer/);
await fs.rm(lf);

// edit_file: surgical replace of a unique block, then read it back. Existing files must be read
// first, matching the reference harness's stale-overwrite protection.
const ef = ".agent-check-edit.tmp";
await dispatch("write_file", JSON.stringify({ path: ef, content: "alpha\nbeta\ngamma" }));
assert.match(await dispatch("edit_file", JSON.stringify({ path: ef, old_string: "beta", new_string: "BETA" })), /has not been read completely/);
await dispatch("read_file", JSON.stringify({ path: ef }));
assert.match(await dispatch("edit_file", JSON.stringify({ path: ef, old_string: "beta", new_string: "BETA" })), /1 replacement/);
assert.equal(await dispatch("read_file", JSON.stringify({ path: ef })), "alpha\nBETA\ngamma");
// not found / ambiguous / no-op come back as results, never thrown
assert.match(await dispatch("edit_file", JSON.stringify({ path: ef, old_string: "nope", new_string: "x" })), /not found/);
await dispatch("write_file", JSON.stringify({ path: ef, content: "x x x" }));
await dispatch("read_file", JSON.stringify({ path: ef }));
assert.match(await dispatch("edit_file", JSON.stringify({ path: ef, old_string: "x", new_string: "y" })), /matches 3 places/);
assert.match(await dispatch("edit_file", JSON.stringify({ path: ef, old_string: "x", new_string: "x" })), /identical/);
// replace_all hits every occurrence
assert.match(await dispatch("edit_file", JSON.stringify({ path: ef, old_string: "x", new_string: "y", replace_all: true })), /3 replacements/);
assert.equal(await dispatch("read_file", JSON.stringify({ path: ef })), "y y y");
// partial reads do not authorize overwriting or editing the whole existing file
await dispatch("write_file", JSON.stringify({ path: ef, content: "one\ntwo\nthree" }));
await dispatch("read_file", JSON.stringify({ path: ef, offset: 2, limit: 1 }));
assert.match(await dispatch("write_file", JSON.stringify({ path: ef, content: "replace" })), /has not been read completely/);
assert.match(await dispatch("edit_file", JSON.stringify({ path: ef, old_string: "two", new_string: "TWO" })), /has not been read completely/);
// external changes after a read force a re-read before modification
await dispatch("read_file", JSON.stringify({ path: ef }));
await new Promise((resolve) => setTimeout(resolve, 5));
await fs.writeFile(ef, "changed outside tool");
assert.match(await dispatch("edit_file", JSON.stringify({ path: ef, old_string: "changed", new_string: "CHANGED" })), /changed since it was read/);
// new_string with a $ pattern is inserted literally, not treated as a backreference
await dispatch("read_file", JSON.stringify({ path: ef }));
await dispatch("write_file", JSON.stringify({ path: ef, content: "find_me" }));
await dispatch("read_file", JSON.stringify({ path: ef }));
await dispatch("edit_file", JSON.stringify({ path: ef, old_string: "find_me", new_string: "$& and $1" }));
assert.equal(await dispatch("read_file", JSON.stringify({ path: ef })), "$& and $1");
await fs.rm(ef);

// read size guard: a file over the limit is refused (not OOM'd), as a result pointing at run_bash
const bigf = ".agent-check-big.tmp";
await fs.writeFile(bigf, "x".repeat(5 * 1024 * 1024 + 1));
assert.match(await dispatch("read_file", JSON.stringify({ path: bigf })), /over the 5MB read limit/);
assert.match(await dispatch("edit_file", JSON.stringify({ path: bigf, old_string: "x", new_string: "y" })), /has not been read completely/);
await fs.rm(bigf);

// binary guard: a file with NUL bytes is refused as text (points at run_bash), so decoded garbage
// can't pollute the context. NUL built via fromCharCode to keep this source file NUL-free.
const binf = ".agent-check-bin.tmp";
await fs.writeFile(binf, "PNG" + String.fromCharCode(0) + "\x89data");
assert.match(await dispatch("read_file", JSON.stringify({ path: binf })), /looks binary/);
await fs.rm(binf);

// run_bash returns stdout + exit code
assert.match(await dispatch("run_bash", JSON.stringify({ command: "echo hi" })), /exit 0\nhi/);

// glob: file discovery by pattern, newest first enough to include the expected workspace-relative path
await fs.mkdir(".agent-check-search", { recursive: true });
await fs.writeFile(".agent-check-search/alpha.ts", "export const alpha = 1;\n");
await fs.writeFile(".agent-check-search/beta.js", "console.log('beta');\n");
assert.match(
  await dispatch("glob", JSON.stringify({ pattern: "**/*.ts", path: ".agent-check-search" })),
  /\.agent-check-search\/alpha\.ts/,
  "glob finds matching files under a root",
);
assert.equal(await dispatch("glob", JSON.stringify({ pattern: "**/*.py", path: ".agent-check-search" })), "no matches");
assert.match(await dispatch("glob", JSON.stringify({ pattern: "" })), /'pattern' must be a non-empty string/);
assert.match(await dispatch("glob", JSON.stringify({ pattern: "**/*", limit: 0 })), /'limit' must be a positive integer/);

// grep: rg-quality search primitive with output modes and glob filtering
assert.match(
  await dispatch("grep", JSON.stringify({ pattern: "alpha", path: ".agent-check-search", output_mode: "content" })),
  /\.agent-check-search\/alpha\.ts:1:export const alpha = 1;/,
  "grep content mode returns file:line:content",
);
assert.match(
  await dispatch("grep", JSON.stringify({ pattern: "alpha", path: ".agent-check-search", output_mode: "files_with_matches", glob: "*.ts" })),
  /\.agent-check-search\/alpha\.ts/,
  "grep files_with_matches mode returns matching paths",
);
assert.match(
  await dispatch("grep", JSON.stringify({ pattern: "alpha", path: ".agent-check-search", output_mode: "count" })),
  /\.agent-check-search\/alpha\.ts:1/,
  "grep count mode returns file:count",
);
assert.equal(await dispatch("grep", JSON.stringify({ pattern: "missing", path: ".agent-check-search" })), "no matches");
assert.match(await dispatch("grep", JSON.stringify({ pattern: "alpha", output_mode: "bad" })), /output_mode/);
await fs.rm(".agent-check-search", { recursive: true, force: true });

// trust-boundary failures come back as results, never thrown
assert.match(await dispatch("read_file", JSON.stringify({ path: "../../../etc/passwd" })), /escapes workspace/);
assert.match(await dispatch("nope", "{}"), /unknown tool/);
assert.match(await dispatch("read_file", "{bad"), /not valid JSON/);
assert.match(await dispatch("write_file", JSON.stringify({ path: 1 })), /must be strings/);

// final_answer: the terminal payload is re-validated at the boundary — the schema sent to the model
// isn't trusted. Good payload parses (and trims); every bad shape throws a fix-it error.
assert.deepEqual(parseFinalAnswer(JSON.stringify({ success: true, summary: " done " })), { success: true, summary: "done" });
assert.throws(() => parseFinalAnswer(JSON.stringify({ summary: "x" })), /success/, "missing success rejected");
assert.throws(() => parseFinalAnswer(JSON.stringify({ success: "yes", summary: "x" })), /boolean/, "non-boolean success rejected");
assert.throws(() => parseFinalAnswer(JSON.stringify({ success: true })), /summary/, "missing summary rejected");
assert.throws(() => parseFinalAnswer(JSON.stringify({ success: true, summary: "  " })), /non-empty/, "blank summary rejected");
assert.throws(() => parseFinalAnswer('{"success":true,"summa'), /valid JSON/, "truncated args rejected, not crashed on");

// update_plan: validate the list at the boundary, render a checkbox list back. Tested through
// dispatch (offline) — a good list renders; bad statuses, blank steps, and >1 in_progress are
// rejected as results, not throws.
const plan = JSON.stringify({
  plan: [
    { step: "Add config option", status: "completed" },
    { step: "Wire through loader", status: "in_progress" },
    { step: "Update docs", status: "pending" },
  ],
});
assert.equal(
  await dispatch("update_plan", plan),
  "[x] Add config option\n[~] Wire through loader\n[ ] Update docs",
  "renders status marks in order",
);
assert.match(await dispatch("update_plan", JSON.stringify({ plan: [] })), /non-empty array/, "empty plan rejected");
assert.match(
  await dispatch("update_plan", JSON.stringify({ plan: [{ step: "x", status: "done" }] })),
  /invalid status/,
  "bad status value rejected",
);
assert.match(
  await dispatch("update_plan", JSON.stringify({ plan: [{ step: "  ", status: "pending" }] })),
  /non-empty 'step'/,
  "blank step text rejected",
);
assert.match(
  await dispatch("update_plan", JSON.stringify({ plan: [
    { step: "a", status: "in_progress" },
    { step: "b", status: "in_progress" },
  ] })),
  /one step may be 'in_progress'/,
  "two in_progress steps rejected",
);

console.log("ok — tools self-check passed");
