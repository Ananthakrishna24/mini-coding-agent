// Quality judging for eval runs, gated on reliability: failing runs are never judged and score 0.
//
// Two ways to produce quality.json in a results dir:
//   1. Harness judging (default, zero API cost): `--prepare` writes a JUDGING.md brief plus a
//      judge-packet.md per passing run; a coding agent (Claude Code, Codex) scores each run by
//      writing score.json next to its packet; `--finalize` validates and merges into quality.json.
//      Running with no flag picks prepare or finalize automatically based on what exists.
//   2. API judging (opt-in, costs money): `--api` scores every run with JUDGE_MODEL directly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type OpenAI from "openai";
import { DIMENSIONS, rubricText } from "./rubrics";
import { formatMetrics } from "./metrics";
import { loadDotenv, type RunRecord } from "./run-eval";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RESULTS_ROOT = path.join(REPO_ROOT, "eval-results");
const DIFF_CLIP = 20_000;

for (const [k, v] of Object.entries(loadDotenv(path.join(REPO_ROOT, ".env")))) {
  if (!process.env[k]) process.env[k] = v;
}

export type RunScore = {
  case: string;
  model: string;
  repeat: number;
  pass: boolean;
  scores: Record<string, number>;
  mean: number;
  worst_moment: string;
  unstable?: string[];
};

export type QualityReport = {
  judgeModel: string;
  passRate: number;
  meanQualityOverPasses: number;
  runs: RunScore[];
};

const dimNames = DIMENSIONS.map((d) => d.name);

function readRecords(dir: string): RunRecord[] {
  return (JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as { records: RunRecord[] }).records;
}

function readDiff(runDir: string): string {
  let diff = "";
  try {
    diff = fs.readFileSync(path.join(runDir, "diff.patch"), "utf8");
  } catch {}
  return diff.length > DIFF_CLIP ? `${diff.slice(0, DIFF_CLIP)}\n…[diff truncated]` : diff;
}

function zeroScore(r: RunRecord): RunScore {
  return {
    case: r.case,
    model: r.model,
    repeat: r.repeat,
    pass: false,
    scores: Object.fromEntries(dimNames.map((d) => [d, 0])),
    mean: 0,
    worst_moment: `failed the binary check: ${r.detail}`,
  };
}

function writeReport(dir: string, judgeModel: string, records: RunRecord[], scored: RunScore[]): QualityReport {
  const passes = scored.filter((r) => r.pass);
  const report: QualityReport = {
    judgeModel,
    passRate: records.length ? passes.length / records.length : 0,
    meanQualityOverPasses: passes.length ? passes.reduce((n, r) => n + r.mean, 0) / passes.length : 0,
    runs: scored,
  };
  fs.writeFileSync(path.join(dir, "quality.json"), JSON.stringify(report, null, 2));
  return report;
}

// ── Harness judging: prepare packets, then finalize agent-written score.json files ──

const SCORE_SCHEMA_EXAMPLE = `{
  "rationale": { ${dimNames.map((d) => `"${d}": "one or two sentences of critique"`).join(", ")} },
  "scores": { ${dimNames.map((d) => `"${d}": 3`).join(", ")} },
  "worst_moment": "the single worst decision in this run, described concretely"
}`;

function judgingBrief(pending: RunRecord[]): string {
  return `# Judging brief

You are judging runs of a coding agent against the rubric below. Work through every run listed at
the bottom. For each one:

1. Open its \`judge-packet.md\` (task, gold notes, diff, final summary, process metrics).
2. If you need process evidence (thrash, verification, re-reads), read \`trajectory.jsonl\` in the
   same directory — you have file access; use it.
3. Write the rationale for each dimension BEFORE deciding its score. Be harsh but fair: a 5 must be
   earned, a 3 is "acceptable with visible flaws", a 1 is a clear failure of that dimension.
4. Write \`score.json\` in that run's directory, exactly this shape (integer scores 1–5):

\`\`\`json
${SCORE_SCHEMA_EXAMPLE}
\`\`\`

Rules:
- Judge only the evidence in that run's directory. Do not compare runs against each other.
- Do not reward verbosity or politeness; reward correct, minimal, verified work.
- Failed runs are not in your list — they score 0 automatically. Never score one anyway.
- When every run has a score.json, run \`npm run eval:quality\` again to validate and merge.

## Rubric
${rubricText()}

## Runs to score
${pending.map((r) => `- ${path.join(r.dir, "judge-packet.md")}`).join("\n")}
`;
}

function packetText(r: RunRecord): string {
  return [
    `# Judge packet: ${r.case} (${r.model}${r.repeat > 1 ? `, run ${r.repeat}` : ""})`,
    `## Task given to the agent\n${r.goal}`,
    r.rubricNotes ? `## Gold notes (what a correct, minimal solution looks like)\n${r.rubricNotes}` : "",
    `## Diff produced (git, seeded workspace vs final)\n\`\`\`diff\n${readDiff(r.dir) || "(empty diff — no file changes)"}\n\`\`\``,
    `## Agent's final summary\n${r.summary || "(none)"}`,
    `## Process metrics\n${formatMetrics(r.metrics)}\n\nFull trace: trajectory.jsonl in this directory.`,
    `## Output\nWrite score.json in this directory (see JUDGING.md at the results root for the schema and rubric).`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function prepareJudging(dir: string): { pending: number; skipped: number } {
  const records = readRecords(dir);
  const pending: RunRecord[] = [];
  let skipped = 0;
  for (const r of records) {
    if (!r.pass) {
      skipped++;
      continue;
    }
    fs.writeFileSync(path.join(r.dir, "judge-packet.md"), packetText(r));
    pending.push(r);
  }
  fs.writeFileSync(path.join(dir, "JUDGING.md"), judgingBrief(pending));
  return { pending: pending.length, skipped };
}

function readScoreFile(runDir: string): { scores: Record<string, number>; worst_moment: string } {
  const file = path.join(runDir, "score.json");
  if (!fs.existsSync(file)) throw new Error(`missing score.json in ${runDir} — score this run first (see JUDGING.md)`);
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const scores: Record<string, number> = {};
  for (const d of dimNames) {
    const v = Number(raw?.scores?.[d]);
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new Error(`${file}: scores.${d} must be an integer 1–5 (got ${JSON.stringify(raw?.scores?.[d])})`);
    scores[d] = v;
  }
  return { scores, worst_moment: String(raw?.worst_moment ?? "") };
}

export function finalizeJudging(dir: string, judgeName = "harness"): QualityReport {
  const records = readRecords(dir);
  const scored: RunScore[] = records.map((r) => {
    if (!r.pass) return zeroScore(r);
    const { scores, worst_moment } = readScoreFile(r.dir);
    const mean = dimNames.reduce((n, d) => n + scores[d], 0) / dimNames.length;
    return { case: r.case, model: r.model, repeat: r.repeat, pass: true, scores, mean, worst_moment };
  });
  return writeReport(dir, judgeName, records, scored);
}

export function hasPendingScores(dir: string): boolean {
  return readRecords(dir).some((r) => r.pass && fs.existsSync(path.join(r.dir, "score.json")));
}

// ── API judging (opt-in): JUDGE_MODEL scores runs directly ──

function scoreToolSchema(): OpenAI.ChatCompletionTool {
  const rationaleProps: Record<string, unknown> = {};
  const scoreProps: Record<string, unknown> = {};
  for (const d of dimNames) {
    rationaleProps[d] = { type: "string", description: "One or two sentences of critique for this dimension, written before scoring it." };
    scoreProps[d] = { type: "integer", minimum: 1, maximum: 5 };
  }
  return {
    type: "function",
    function: {
      name: "score",
      description: "Submit the rubric scores for this run. Write each rationale before its score.",
      parameters: {
        type: "object",
        properties: {
          rationale: { type: "object", properties: rationaleProps, required: dimNames, additionalProperties: false },
          scores: { type: "object", properties: scoreProps, required: dimNames, additionalProperties: false },
          worst_moment: { type: "string", description: "The single worst decision or moment in this run, quoted or described concretely." },
        },
        required: ["rationale", "scores", "worst_moment"],
        additionalProperties: false,
      },
    },
  };
}

const JUDGE_SYSTEM = `You are a strict senior code reviewer judging one run of a coding agent.
Score the run against the rubric below. Be harsh but fair: a 5 must be earned, a 3 is "acceptable
with visible flaws", a 1 is a clear failure of that dimension. Judge only the evidence given — the
task, the diff, the final summary, and the process metrics. Write the rationale for a dimension
BEFORE deciding its score. Do not reward verbosity or politeness; reward correct, minimal,
verified work.

Rubric:
${rubricText()}`;

function judgePrompt(r: RunRecord, diff: string): string {
  return [
    `## Task given to the agent\n${r.goal}`,
    r.rubricNotes ? `## Gold notes (what a correct, minimal solution looks like)\n${r.rubricNotes}` : "",
    `## Diff produced (git, seeded workspace vs final)\n\`\`\`diff\n${diff || "(empty diff — no file changes)"}\n\`\`\``,
    `## Agent's final summary\n${r.summary || "(none)"}`,
    `## Process metrics\n${formatMetrics(r.metrics)}`,
    `Call the score tool now.`,
  ].filter(Boolean).join("\n\n");
}

async function judgeOne(chatFn: typeof import("../llm").chat, judgeModel: string, r: RunRecord): Promise<{ scores: Record<string, number>; worst_moment: string }> {
  const res = await chatFn(
    [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: judgePrompt(r, readDiff(r.dir)) },
    ],
    [scoreToolSchema()],
    { model: judgeModel, toolChoice: { type: "function", function: { name: "score" } }, temperature: 0, effort: null },
  );
  const call = res.choices?.[0]?.message?.tool_calls?.[0];
  if (!call || call.type !== "function") throw new Error("judge did not call the score tool");
  const args = JSON.parse(call.function.arguments);
  const scores: Record<string, number> = {};
  for (const d of dimNames) {
    const v = Number(args.scores?.[d]);
    scores[d] = Number.isFinite(v) ? Math.max(1, Math.min(5, Math.round(v))) : 1;
  }
  return { scores, worst_moment: String(args.worst_moment ?? "") };
}

export async function judgeResults(dir: string, opts: { stability?: boolean } = {}): Promise<QualityReport> {
  const judgeModel = process.env.JUDGE_MODEL;
  if (!judgeModel) throw new Error("JUDGE_MODEL is not set — API judging needs it, or use the default harness judging (no flag)");
  const { chat } = await import("../llm");

  const records = readRecords(dir);
  const scored: RunScore[] = [];
  for (const r of records) {
    if (!r.pass) {
      scored.push(zeroScore(r));
      continue;
    }
    const first = await judgeOne(chat, judgeModel, r);
    let scores = first.scores;
    let unstable: string[] | undefined;
    if (opts.stability) {
      const second = await judgeOne(chat, judgeModel, r);
      unstable = dimNames.filter((d) => Math.abs(first.scores[d] - second.scores[d]) >= 2);
      scores = Object.fromEntries(dimNames.map((d) => [d, (first.scores[d] + second.scores[d]) / 2]));
    }
    const mean = dimNames.reduce((n, d) => n + scores[d], 0) / dimNames.length;
    scored.push({ case: r.case, model: r.model, repeat: r.repeat, pass: true, scores, mean, worst_moment: first.worst_moment, ...(unstable?.length ? { unstable } : {}) });
  }
  return writeReport(dir, judgeModel, records, scored);
}

// ── CLI ──

export function latestResultsDir(): string {
  const dirs = fs
    .readdirSync(RESULTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(RESULTS_ROOT, d.name, "run.json")))
    .map((d) => d.name)
    .sort();
  if (!dirs.length) throw new Error(`no results with run.json under ${RESULTS_ROOT} — run \`npm run eval\` first`);
  return path.join(RESULTS_ROOT, dirs[dirs.length - 1]);
}

function printReport(report: QualityReport): void {
  const width = Math.max(...report.runs.map((r) => r.case.length), 4) + 8;
  console.log("run".padEnd(width) + dimNames.map((d) => d.slice(0, 10).padStart(12)).join("") + "mean".padStart(8));
  for (const r of report.runs) {
    const label = `${r.case}${r.repeat > 1 ? ` r${r.repeat}` : ""}${r.pass ? "" : " ✗"}`;
    const cells = dimNames.map((d) => String(r.scores[d]).padStart(12)).join("");
    const flag = r.unstable?.length ? `  (unstable: ${r.unstable.join(",")})` : "";
    console.log(label.padEnd(width) + cells + r.mean.toFixed(1).padStart(8) + flag);
  }
  console.log(`\npass-rate ${Math.round(report.passRate * 100)}% · mean quality over passes ${report.meanQualityOverPasses.toFixed(2)} / 5 · judge ${report.judgeModel}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dirArg = args.find((a) => !a.startsWith("--"));
  const dir = dirArg ? path.resolve(dirArg) : latestResultsDir();

  if (args.includes("--api")) {
    console.log(`judging ${dir} with JUDGE_MODEL`);
    printReport(await judgeResults(dir, { stability: args.includes("--stability") }));
    console.log(`\nwrote ${path.join(dir, "quality.json")}`);
    return;
  }
  if (args.includes("--prepare") || !hasPendingScores(dir)) {
    const { pending, skipped } = prepareJudging(dir);
    console.log(`prepared ${dir}`);
    console.log(`${pending} run(s) to score (${skipped} failed run(s) auto-score 0)`);
    console.log(`\nnext: have your coding agent (Claude Code / Codex) follow ${path.join(dir, "JUDGING.md")},`);
    console.log(`then run \`npm run eval:quality\` again to validate and merge.`);
    return;
  }
  printReport(finalizeJudging(dir, process.env.JUDGE_NAME || "harness"));
  console.log(`\nwrote ${path.join(dir, "quality.json")}`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
