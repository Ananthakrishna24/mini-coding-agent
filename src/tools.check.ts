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
assert.match(await dispatch("write_file", JSON.stringify({ path: ef, content: "stale overwrite" })), /has not been read completely/);
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

// multi_edit: a batch of exact-text edits applied all-or-nothing across one or more files.
const m1 = ".agent-check-multi1.tmp";
const m2 = ".agent-check-multi2.tmp";
await dispatch("write_file", JSON.stringify({ path: m1, content: "alpha\nbeta\ngamma" }));
await dispatch("write_file", JSON.stringify({ path: m2, content: "one two two" }));
// like edit_file, every target must be read first
assert.match(
  await dispatch("multi_edit", JSON.stringify({ edits: [{ path: m1, old_string: "alpha", new_string: "ALPHA" }] })),
  /has not been read completely/,
);
await dispatch("read_file", JSON.stringify({ path: m1 }));
await dispatch("read_file", JSON.stringify({ path: m2 }));
// one batch spanning two files, including a replace_all and a sequential same-file edit that depends
// on the earlier one's result
const ok = await dispatch("multi_edit", JSON.stringify({ edits: [
  { path: m1, old_string: "alpha", new_string: "ALPHA" },
  { path: m1, old_string: "ALPHA\nbeta", new_string: "ALPHA\nBETA" }, // sees the prior edit's output
  { path: m2, old_string: "two", new_string: "2", replace_all: true },
] }));
assert.match(ok, /edited 2 files/);
assert.match(ok, /\.agent-check-multi1\.tmp \(2 replacements\)/);
assert.match(ok, /\.agent-check-multi2\.tmp \(2 replacements\)/);
assert.equal(await dispatch("read_file", JSON.stringify({ path: m1 })), "ALPHA\nBETA\ngamma");
assert.equal(await dispatch("read_file", JSON.stringify({ path: m2 })), "one 2 2");
// transactional: a later failing edit rolls back the whole batch — the earlier valid edit is NOT written
await dispatch("read_file", JSON.stringify({ path: m1 }));
assert.match(
  await dispatch("multi_edit", JSON.stringify({ edits: [
    { path: m1, old_string: "ALPHA", new_string: "first" },
    { path: m1, old_string: "nope", new_string: "x" }, // fails -> nothing written
  ] })),
  /edit 2 .*not found/,
);
assert.equal(await dispatch("read_file", JSON.stringify({ path: m1 })), "ALPHA\nBETA\ngamma", "failed batch left the file untouched");
// ambiguity is reported with the offending edit's index, as a result not a throw
await dispatch("read_file", JSON.stringify({ path: m2 }));
assert.match(
  await dispatch("multi_edit", JSON.stringify({ edits: [{ path: m2, old_string: "2", new_string: "x" }] })),
  /edit 1 .*matches 2 places/,
);
// empty batch rejected
assert.match(await dispatch("multi_edit", JSON.stringify({ edits: [] })), /non-empty array/);
await fs.rm(m1);
await fs.rm(m2);

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

// run_bash with AbortSignal
const controller = new AbortController();
const bashPromise = dispatch("run_bash", JSON.stringify({ command: "sleep 10" }), controller.signal);
controller.abort();
const bashResult = await bashPromise;
assert.match(bashResult, /error: command interrupted by user/);

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

// web_fetch: fetch URL content, mock the network call to keep it offline.
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === "https://test.com/html") {
      return {
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: async () => "<html><head><style>body{color:red}</style></head><body><h1>Hello</h1><p>World!</p></body></html>",
      } as any;
    }
    if (url === "https://test.com/text") {
      return {
        ok: true,
        headers: new Map([["content-type", "text/plain"]]),
        text: async () => "Raw text",
      } as any;
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as any;
  }) as any;

  const htmlRes = await dispatch("web_fetch", JSON.stringify({ url: "https://test.com/html" }));
  assert.equal(htmlRes, "Hello\n\nWorld!");

  const textRes = await dispatch("web_fetch", JSON.stringify({ url: "https://test.com/text" }));
  assert.equal(textRes, "Raw text");

  const failRes = await dispatch("web_fetch", JSON.stringify({ url: "https://test.com/404" }));
  assert.match(failRes, /HTTP error! status: 404/);

  const invalidRes = await dispatch("web_fetch", JSON.stringify({ url: "not-a-url" }));
  assert.match(invalidRes, /Invalid URL/);
} finally {
  globalThis.fetch = originalFetch;
}

// web_search: search the web, mock the network call to keep it offline.
const originalSearchFetch = globalThis.fetch;
try {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("s.jina.ai")) {
      const query = decodeURIComponent(url.split("s.jina.ai/")[1] || "");
      if (query === "test query") {
        return {
          ok: true,
          text: async () => "Search Results: [Result 1](https://r1.com) - Snippet 1",
        } as any;
      }
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as any;
  }) as any;

  const searchRes = await dispatch("web_search", JSON.stringify({ query: "test query" }));
  assert.equal(searchRes, "Search Results: [Result 1](https://r1.com) - Snippet 1");

  const failSearch = await dispatch("web_search", JSON.stringify({ query: "bad query" }));
  assert.match(failSearch, /HTTP error! status: 404/);

  const invalidSearch = await dispatch("web_search", JSON.stringify({ query: "" }));
  assert.match(invalidSearch, /'query' must be a non-empty string/);
} finally {
  globalThis.fetch = originalSearchFetch;
}

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
assert.equal(
  await dispatch("update_plan", JSON.stringify({
    explanation: "tests revealed the loader runs first",
    plan: [{ step: "Reorder init", status: "in_progress" }],
  })),
  "tests revealed the loader runs first\n\n[~] Reorder init",
  "prepends explanation when given",
);
assert.match(
  await dispatch("update_plan", JSON.stringify({ explanation: 7, plan: [{ step: "a", status: "pending" }] })),
  /'explanation' must be a string/,
  "non-string explanation rejected",
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
