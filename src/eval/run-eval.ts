// The eval runner: run each case against the real CLI in its own throwaway workspace, check the result,
// and print a scorecard. Each case runs as a fresh subprocess (tsx src/index.ts <goal>) with its cwd set
// to a temp dir — that gives every case a clean workspace AND a clean process (no module-level state,
// model client, or context bleeding between cases), and it exercises the shipped one-shot path
// end-to-end rather than an in-process shortcut. Real model calls cost money and need an API key, so this
// is a `npm run eval` script, not part of the offline `npm run check`.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cases, type EvalCase } from "./cases";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.join(REPO_ROOT, "src", "index.ts");
const DEFAULT_TIMEOUT = 180_000; // a case allows a few model turns; killed past this so the suite can't hang

export type Outcome = { name: string; pass: boolean; detail: string; ms: number };

// Pure: turn per-case outcomes into the printable scorecard + an overall pass/fail. Separated from the
// running so it's testable offline without touching the model (see eval.check.ts).
export function summarize(outcomes: Outcome[]): { passed: number; total: number; lines: string[]; ok: boolean } {
  const passed = outcomes.filter((o) => o.pass).length;
  const total = outcomes.length;
  const lines = outcomes.map((o) => {
    const head = `${o.pass ? "PASS" : "FAIL"}  ${o.name}  (${(o.ms / 1000).toFixed(1)}s)`;
    return o.pass ? head : `${head}\n      ↳ ${o.detail}`;
  });
  lines.push("", `${passed}/${total} passed`);
  return { passed, total, lines, ok: passed === total };
}

// Minimal .env reader: KEY=VALUE per line, # comments and blanks skipped, surrounding quotes stripped.
// We load it ourselves and inject it into the child env because the child's cwd is a temp dir, so the
// CLI's own `--env-file=.env` (which resolves relative to cwd) would look in the wrong place.
function loadDotenv(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

const hasKey = (env: NodeJS.ProcessEnv) => Boolean(env.OPENROUTER_API_KEY || env.OPENAI_API_KEY);

// Run the agent on one goal in `workspace`, returning the exit code (null if killed on timeout) and the
// combined stdout/stderr. stderr is folded in so a crash trace and the deny-list's blocked-message are
// both visible to checks.
function runAgent(goal: string, workspace: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [ENTRY, goal], { cwd: workspace, env, timeout: timeoutMs, killSignal: "SIGKILL" });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ exitCode: null, stdout: `${out}\n[spawn error] ${e.message}` }));
    child.on("close", (code) => resolve({ exitCode: code, stdout: out }));
  });
}

async function runCase(c: EvalCase, env: NodeJS.ProcessEnv): Promise<Outcome> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "minicode-eval-"));
  const t0 = Date.now();
  try {
    c.setup?.(workspace);
    const { exitCode, stdout } = await runAgent(c.goal, workspace, env, c.timeoutMs ?? DEFAULT_TIMEOUT);
    let verdict: true | string;
    try {
      verdict = c.check({ workspace, exitCode, stdout });
    } catch (e: any) {
      verdict = `check threw: ${e.message ?? e}`;
    }
    return { name: c.name, pass: verdict === true, detail: verdict === true ? "" : verdict, ms: Date.now() - t0 };
  } finally {
    if (!process.env.EVAL_KEEP) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const env: NodeJS.ProcessEnv = { ...process.env, ...loadDotenv(path.join(REPO_ROOT, ".env")) };
  if (!hasKey(env)) {
    console.error("no API key found — set OPENROUTER_API_KEY or OPENAI_API_KEY in .env before running the eval");
    process.exit(2);
  }

  // Optional args filter the suite to named cases, e.g. `npm run eval -- create-file edit-file`.
  const wanted = process.argv.slice(2);
  const selected = wanted.length ? cases.filter((c) => wanted.includes(c.name)) : cases;
  if (!selected.length) {
    console.error(`no cases matched: ${wanted.join(", ")}\navailable: ${cases.map((c) => c.name).join(", ")}`);
    process.exit(2);
  }

  const outcomes: Outcome[] = [];
  for (const c of selected) {
    process.stdout.write(`▶ ${c.name} … `);
    const outcome = await runCase(c, env);
    console.log(outcome.pass ? "PASS" : "FAIL");
    outcomes.push(outcome);
  }

  const { lines, ok } = summarize(outcomes);
  console.log("\n" + lines.join("\n"));
  process.exit(ok ? 0 : 1);
}

// Only run when invoked directly (npm run eval); importing this module for `summarize` must not start a run.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
