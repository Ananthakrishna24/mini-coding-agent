// The eval suite: a small set of representative tasks, each with a machine-checkable success condition.
// A case is a goal handed to the agent plus a check run against the workspace and process result after
// the run finishes. Keep this list short and representative — a suite that's slow to run is one that
// won't get run. Cover the shapes (create, edit, shell, multi-step, a refused action, delegation), not
// the volume.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// What a check sees after the run: the (already isolated) workspace dir, the process exit code
// (0 = the agent reported success, non-zero = failure or crash, null = killed on timeout), and the
// combined stdout/stderr. Outcome checks read the workspace; the exit code and stdout are there for the
// few assertions a filesystem check can't make (e.g. that a guardrail fired).
export type CheckContext = { workspace: string; exitCode: number | null; stdout: string };

// A check returns `true` on pass, or a human-readable reason string on fail. Returning the reason (not
// just false) is what makes a red line in the scorecard actionable.
export type Check = (ctx: CheckContext) => true | string;

export type EvalCase = {
  name: string;
  goal: string;
  setup?: (workspace: string) => void; // seed files into the fresh workspace before the run
  check: Check;
  timeoutMs?: number; // per-case ceiling; the runner kills the agent and fails the case past it
  split?: "train" | "holdout"; // tuning loop optimizes on train, accepts on holdout (default train)
  rubricNotes?: string; // gold knowledge for the quality judge — what a correct, minimal solution looks like
};

// Read a workspace-relative file, or null if it doesn't exist. The building block for outcome checks.
export function fileText(workspace: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(workspace, rel), "utf8");
  } catch {
    return null;
  }
}

// Assert a file exists and its trimmed contents equal `expected`. Trims because the model can't be held
// to an exact trailing newline and that's not what these cases are testing.
const fileEquals =
  (rel: string, expected: string): Check =>
  ({ workspace }) => {
    const got = fileText(workspace, rel);
    if (got === null) return `${rel} was not created`;
    return got.trim() === expected ? true : `${rel} = ${JSON.stringify(got.trim())}, expected ${JSON.stringify(expected)}`;
  };

const fileContains =
  (rel: string, needle: string): Check =>
  ({ workspace }) => {
    const got = fileText(workspace, rel);
    if (got === null) return `${rel} was not created`;
    return got.includes(needle) ? true : `${rel} does not contain ${JSON.stringify(needle)}`;
  };

export const cases: EvalCase[] = [
  {
    name: "create-file",
    goal: 'Create a file named hello.txt in the current directory containing exactly the text: hi',
    check: fileEquals("hello.txt", "hi"),
  },
  {
    name: "edit-file",
    goal: "The file config.txt has a line `debug=false`. Edit it so that line reads `debug=true`. Leave everything else unchanged.",
    setup: (ws) => fs.writeFileSync(path.join(ws, "config.txt"), "name=demo\ndebug=false\nverbose=false\n"),
    check: ({ workspace }) => {
      const got = fileText(workspace, "config.txt");
      if (got === null) return "config.txt is missing";
      if (!got.includes("debug=true")) return "debug was not set to true";
      if (got.includes("debug=false")) return "the old debug=false line is still present";
      if (!got.includes("name=demo")) return "unrelated lines were lost";
      return true;
    },
  },
  {
    name: "run-bash",
    goal: "Use the run_bash tool to create an empty file named touched.txt in the current directory.",
    check: ({ workspace }) => (fileText(workspace, "touched.txt") !== null ? true : "touched.txt was not created"),
  },
  {
    name: "multi-step-transform",
    goal: "First create a file step1.txt containing exactly the text ABC. Then create a second file step2.txt containing those same characters reversed.",
    check: fileEquals("step2.txt", "CBA"),
  },
  {
    // The guardrail must fire end-to-end: git push is on the permission deny-list, and (unlike an overtly
    // destructive command) the model will actually attempt it rather than self-refusing, so this reliably
    // exercises the deny-list rather than the model's own caution. Success = the block surfaced and no
    // push happened (there's no remote here to push to anyway).
    name: "guardrail-blocks-push",
    goal: "Use run_bash to run exactly this command: git push origin main",
    check: ({ stdout }) => (stdout.includes("blocked") ? true : "the deny-list did not block `git push` (no 'blocked' in output)"),
  },
  {
    // Outcome check only — the agent may read the files directly or delegate to subagents; either way the
    // combined result must be correct. Exercises the full stack (planning, multiple reads, a final write)
    // and, when it delegates, that delegation doesn't corrupt the result.
    name: "multi-file-combine",
    goal: "Read the files a.txt, b.txt and c.txt. Then write a new file combined.txt containing their contents joined by commas, in that order (a, then b, then c). You may spawn subagents to read them in parallel if you like.",
    setup: (ws) => {
      fs.writeFileSync(path.join(ws, "a.txt"), "alpha");
      fs.writeFileSync(path.join(ws, "b.txt"), "beta");
      fs.writeFileSync(path.join(ws, "c.txt"), "gamma");
    },
    check: fileContains("combined.txt", "alpha,beta,gamma"),
    split: "holdout",
  },

  // ── Small-model gauntlet: shapes that expose the failure modes trivial cases can't ──

  {
    name: "hostile-whitespace-edit",
    goal: "In legacy.js, change the discount multiplier from 0.9 to 0.85. Only the discounted function may change.",
    setup: (ws) =>
      fs.writeFileSync(
        path.join(ws, "legacy.js"),
        "function applyTotals(items) {\n" +
          "\tfor (const item of items) {\n" +
          "\t\titem.total = item.price * item.qty;\n" +
          "\t}\n" +
          "}\n" +
          "function applyDiscountedTotals(items) {\n" +
          "\tfor (const item of items) {\n" +
          "\t\titem.total = item.price * item.qty * 0.9;\n" +
          "\t}\n" +
          "}\n" +
          "module.exports = { applyTotals, applyDiscountedTotals };\n",
      ),
    check: ({ workspace }) => {
      const got = fileText(workspace, "legacy.js");
      if (got === null) return "legacy.js is missing";
      if (!got.includes("* 0.85")) return "multiplier was not changed to 0.85";
      if (got.includes("0.9")) return "the old 0.9 multiplier is still present";
      if (!got.includes("\t\titem.total = item.price * item.qty;\n")) return "the undiscounted function was altered";
      return true;
    },
    rubricNotes: "One-token change inside applyDiscountedTotals. The file mixes tabs and near-duplicate lines on purpose; rewriting the file or touching applyTotals is a failure of minimality.",
  },
  {
    name: "long-file-edit",
    goal: 'In big.js, the constant TARGET is set to "unset". Change it to "ready". Nothing else may change.',
    setup: (ws) => {
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) {
        if (i === 2800) lines.push('const TARGET = "unset";');
        else lines.push(`const row_${i} = ${i};`);
      }
      fs.writeFileSync(path.join(ws, "big.js"), lines.join("\n") + "\n");
    },
    check: ({ workspace }) => {
      const got = fileText(workspace, "big.js");
      if (got === null) return "big.js is missing";
      if (!got.includes('const TARGET = "ready";')) return "TARGET was not set to ready";
      if (got.split("\n").length < 2990) return "big.js lost lines — the file was rewritten, not edited";
      return true;
    },
    split: "holdout",
    rubricNotes: "The file is too large to read whole under a small context window; the right process is grep/paged reads plus a targeted edit_file. A whole-file rewrite is a process failure even if TARGET ends up correct.",
    timeoutMs: 240_000,
  },
  {
    name: "red-herring-error",
    goal: "Running `node test.js` in this project fails. Find the actual bug, fix it, and make sure `node test.js` passes before you finish.",
    setup: (ws) => {
      fs.writeFileSync(path.join(ws, "lib.js"), "module.exports.add = (a, b) => a - b;\n");
      fs.writeFileSync(
        path.join(ws, "test.js"),
        'const { add } = require("./lib");\n' +
          'if (add(2, 3) !== 5) {\n' +
          '  console.error("test failed: expected 5 — check the mode flag in config.js");\n' +
          "  process.exit(1);\n" +
          "}\n" +
          'console.log("ok");\n',
      );
      fs.writeFileSync(path.join(ws, "config.js"), 'module.exports = { mode: "sum" };\n');
    },
    check: ({ workspace }) => {
      const config = fileText(workspace, "config.js");
      if (config !== 'module.exports = { mode: "sum" };\n') return "config.js was modified — the error message was a red herring";
      try {
        execSync("node test.js", { cwd: workspace, timeout: 10_000, stdio: "pipe" });
      } catch {
        return "node test.js still fails";
      }
      return true;
    },
    rubricNotes: "The bug is `a - b` in lib.js; the test's error message falsely blames config.js. Editing config.js means the model trusted the message over the evidence. The trajectory should show the test actually re-run and passing.",
  },
  {
    name: "fix-and-verify",
    goal: "sum.js has a bug that makes `node run-tests.js` fail. Fix it, then run the tests and only finish once they pass.",
    setup: (ws) => {
      fs.writeFileSync(path.join(ws, "sum.js"), "module.exports = (nums) => {\n  let total = 0;\n  for (let i = 1; i < nums.length; i++) total += nums[i];\n  return total;\n};\n");
      fs.writeFileSync(
        path.join(ws, "run-tests.js"),
        'const sum = require("./sum");\n' +
          "const checks = [ [[1,2,3], 6], [[5], 5], [[], 0] ];\n" +
          "for (const [input, want] of checks) {\n" +
          "  const got = sum(input);\n" +
          '  if (got !== want) { console.error(`FAIL sum(${JSON.stringify(input)}) = ${got}, want ${want}`); process.exit(1); }\n' +
          "}\n" +
          'console.log("all tests pass");\n',
      );
    },
    check: ({ workspace }) => {
      try {
        execSync("node run-tests.js", { cwd: workspace, timeout: 10_000, stdio: "pipe" });
      } catch {
        return "node run-tests.js still fails";
      }
      return true;
    },
    split: "holdout",
    rubricNotes: "Off-by-one: the loop starts at i = 1. The fix is one character. Finishing without re-running run-tests.js is a verification failure regardless of the fix being right.",
  },
  {
    name: "prose-drift-bait",
    goal: "Read notes.txt and report how many TODO items it contains.",
    setup: (ws) =>
      fs.writeFileSync(
        path.join(ws, "notes.txt"),
        "meeting notes\nTODO: ship the login fix\ndone: update readme\nTODO: rotate the API key\nTODO: add retry to the client\nidea: dark mode\nTODO: delete dead code in utils\n",
      ),
    check: ({ exitCode, stdout }) => {
      if (exitCode !== 0) return "run did not end with a successful final_answer (prose drift or protocol failure)";
      return stdout.includes("4") ? true : "the reported count is not 4";
    },
    rubricNotes: "Pure Q&A: read one file, count 4 TODO lines, finish with final_answer carrying the count. Small models tend to answer in prose and never call final_answer — that is the failure this case exists to catch.",
  },
  {
    name: "reread-loop",
    goal: "counter.txt contains a number. Increment it by 1, three separate times — after each increment, read counter.txt again to confirm the new value before doing the next one.",
    setup: (ws) => fs.writeFileSync(path.join(ws, "counter.txt"), "0"),
    check: ({ workspace }) => {
      const got = fileText(workspace, "counter.txt");
      if (got === null) return "counter.txt is missing";
      return got.trim() === "3" ? true : `counter.txt = ${JSON.stringify(got.trim())}, expected 3`;
    },
    rubricNotes: "The task legitimately requires reading the same file with the same arguments repeatedly; a harness or model that treats re-reads as loops fails here. Final value must be exactly 3.",
  },
];
