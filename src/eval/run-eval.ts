// The eval runner: run each case against the real CLI in its own throwaway workspace, check the result,
// and print a scorecard. Each case runs as a fresh subprocess (tsx src/index.ts <goal>) with its cwd set
// to a temp dir. Real model calls cost money and need an API key, so this is `npm run eval`, not part of
// the offline `npm run check`. Also exported as a library for the judge (judge.ts) and tuning loop
// (tune-prompt.ts): every run leaves a results dir with trajectory.jsonl, diff.patch, and meta.json.
import { spawn, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cases, type EvalCase } from "./cases";
import { parseTrajectory, computeMetrics, formatMetrics, type Metrics, type TrajectoryEvent } from "./metrics";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.join(REPO_ROOT, "src", "index.ts");
const RESULTS_ROOT = path.join(REPO_ROOT, "eval-results");
const DEFAULT_TIMEOUT = 180_000;

export type Outcome = { name: string; pass: boolean; detail: string; ms: number; metrics?: string };

export type RunRecord = {
  case: string;
  model: string;
  repeat: number;
  pass: boolean;
  detail: string;
  ms: number;
  goal: string;
  rubricNotes?: string;
  split: "train" | "holdout";
  summary: string;
  metrics: Metrics;
  dir: string;
};

export function summarize(outcomes: Outcome[]): { passed: number; total: number; lines: string[]; ok: boolean } {
  const passed = outcomes.filter((o) => o.pass).length;
  const total = outcomes.length;
  const lines = outcomes.map((o) => {
    const head = `${o.pass ? "PASS" : "FAIL"}  ${o.name}  (${(o.ms / 1000).toFixed(1)}s)`;
    const withMetrics = o.metrics ? `${head}\n      ${o.metrics}` : head;
    return o.pass ? withMetrics : `${withMetrics}\n      ↳ ${o.detail}`;
  });
  lines.push("", `${passed}/${total} passed`);
  return { passed, total, lines, ok: passed === total };
}

export function loadDotenv(file: string): Record<string, string> {
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

export function evalEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...loadDotenv(path.join(REPO_ROOT, ".env")) };
}

const hasKey = (env: NodeJS.ProcessEnv) => Boolean(env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || env.MISTRAL_API_KEY);

const git = (args: string, cwd: string) => execSync(`git -c user.email=eval@local -c user.name=eval -c commit.gpgsign=false ${args}`, { cwd, stdio: "pipe", timeout: 30_000 }).toString();

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

const slug = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_");

async function runCase(c: EvalCase, env: NodeJS.ProcessEnv, model: string | undefined, runDir: string): Promise<RunRecord> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "minicode-eval-"));
  fs.mkdirSync(runDir, { recursive: true });
  const trajectoryFile = path.join(runDir, "trajectory.jsonl");
  const t0 = Date.now();
  try {
    c.setup?.(workspace);
    let gitOk = true;
    try {
      git("init -q", workspace);
      git("add -A", workspace);
      git('commit -qm seed --allow-empty', workspace);
    } catch {
      gitOk = false;
    }

    const childEnv: NodeJS.ProcessEnv = { ...env, AGENT_TRAJECTORY: trajectoryFile };
    if (model) childEnv.AGENT_MODEL = model;
    const { exitCode, stdout } = await runAgent(c.goal, workspace, childEnv, c.timeoutMs ?? DEFAULT_TIMEOUT);

    let diff = "";
    if (gitOk) {
      try {
        git("add -A", workspace);
        diff = git("diff --cached HEAD", workspace);
      } catch {}
    }
    fs.writeFileSync(path.join(runDir, "diff.patch"), diff);
    fs.writeFileSync(path.join(runDir, "stdout.txt"), stdout);

    let verdict: true | string;
    try {
      verdict = c.check({ workspace, exitCode, stdout });
    } catch (e: any) {
      verdict = `check threw: ${e.message ?? e}`;
    }

    let events: TrajectoryEvent[] = [];
    try {
      events = parseTrajectory(fs.readFileSync(trajectoryFile, "utf8"));
    } catch {}
    const finalEvent = [...events].reverse().find((e) => e.type === "final" && e.depth === 0);

    const record: RunRecord = {
      case: c.name,
      model: model ?? env.AGENT_MODEL ?? "(default)",
      repeat: 0,
      pass: verdict === true,
      detail: verdict === true ? "" : verdict,
      ms: Date.now() - t0,
      goal: c.goal,
      rubricNotes: c.rubricNotes,
      split: c.split ?? "train",
      summary: finalEvent?.summary ?? "",
      metrics: computeMetrics(events),
      dir: runDir,
    };
    fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(record, null, 2));
    return record;
  } finally {
    if (!process.env.EVAL_KEEP) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

export type SuiteOpts = {
  models?: (string | undefined)[];
  repeat?: number;
  names?: string[];
  split?: "train" | "holdout";
  resultsDir?: string;
  systemPromptFile?: string;
  quiet?: boolean;
};

export async function runSuite(opts: SuiteOpts = {}): Promise<{ dir: string; records: RunRecord[] }> {
  const env = evalEnv();
  if (!hasKey(env)) throw new Error("no API key found — set OPENROUTER_API_KEY or OPENAI_API_KEY in .env");
  if (opts.systemPromptFile) env.AGENT_SYSTEM_PROMPT_FILE = path.resolve(opts.systemPromptFile);

  let selected = opts.names?.length ? cases.filter((c) => opts.names!.includes(c.name)) : cases;
  if (opts.split) selected = selected.filter((c) => (c.split ?? "train") === opts.split);
  if (!selected.length) throw new Error(`no cases matched\navailable: ${cases.map((c) => c.name).join(", ")}`);

  const dir = opts.resultsDir ?? path.join(RESULTS_ROOT, new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  fs.mkdirSync(dir, { recursive: true });

  const models = opts.models?.length ? opts.models : [undefined];
  const repeat = Math.max(1, opts.repeat ?? 1);
  const records: RunRecord[] = [];

  for (const model of models) {
    const label = model ?? env.AGENT_MODEL ?? "(default)";
    if (!opts.quiet && models.length > 1) console.log(`\n== ${label} ==`);
    for (const c of selected) {
      for (let r = 0; r < repeat; r++) {
        const tag = repeat > 1 ? `${c.name}__r${r + 1}` : c.name;
        if (!opts.quiet) process.stdout.write(`▶ ${tag} … `);
        const runDir = path.join(dir, slug(label), tag);
        const record = await runCase(c, env, model, runDir);
        record.repeat = r + 1;
        fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(record, null, 2));
        if (!opts.quiet) console.log(record.pass ? "PASS" : "FAIL");
        records.push(record);
      }
    }
  }

  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ records }, null, 2));
  return { dir, records };
}

export function passRate(records: RunRecord[]): number {
  return records.length ? records.filter((r) => r.pass).length / records.length : 0;
}

function printGrid(records: RunRecord[]): void {
  const models = [...new Set(records.map((r) => r.model))];
  const names = [...new Set(records.map((r) => r.case))];
  const width = Math.max(...names.map((n) => n.length)) + 2;
  console.log("\n" + "case".padEnd(width) + models.map((m) => m.padStart(24)).join(""));
  for (const name of names) {
    const cells = models.map((m) => {
      const runs = records.filter((r) => r.case === name && r.model === m);
      const passed = runs.filter((r) => r.pass).length;
      return `${passed}/${runs.length}`.padStart(24);
    });
    console.log(name.padEnd(width) + cells.join(""));
  }
  const totals = models.map((m) => {
    const runs = records.filter((r) => r.model === m);
    return `${Math.round(passRate(runs) * 100)}%`.padStart(24);
  });
  console.log("pass-rate".padEnd(width) + totals.join(""));
}

function parseArgs(argv: string[]): { models: (string | undefined)[]; repeat: number; split?: "train" | "holdout"; names: string[] } {
  const out: { models: (string | undefined)[]; repeat: number; split?: "train" | "holdout"; names: string[] } = { models: [undefined], repeat: 1, names: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--models") out.models = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--repeat") out.repeat = Number(argv[++i]) || 1;
    else if (a === "--split") out.split = argv[++i] as "train" | "holdout";
    else out.names.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dir, records } = await runSuite(args);

  for (const model of [...new Set(records.map((r) => r.model))]) {
    const runs = records.filter((r) => r.model === model);
    const outcomes: Outcome[] = runs.map((r) => ({
      name: args.repeat > 1 ? `${r.case} (run ${r.repeat})` : r.case,
      pass: r.pass,
      detail: r.detail,
      ms: r.ms,
      metrics: formatMetrics(r.metrics),
    }));
    const { lines } = summarize(outcomes);
    console.log(`\n── ${model} ──\n${lines.join("\n")}`);
  }
  if (new Set(records.map((r) => r.model)).size > 1) printGrid(records);
  console.log(`\nresults: ${dir}`);
  process.exit(records.every((r) => r.pass) ? 0 : 1);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
