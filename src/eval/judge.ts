// Quality judge: scores passing eval runs against the rubric using a strong model (JUDGE_MODEL).
// Reads a results dir produced by run-eval.ts, writes quality.json next to run.json.
// Quality is gated on reliability: failing runs are never judged and score 0.
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
  let diff = "";
  try {
    diff = fs.readFileSync(path.join(r.dir, "diff.patch"), "utf8");
  } catch {}
  if (diff.length > DIFF_CLIP) diff = `${diff.slice(0, DIFF_CLIP)}\n…[diff truncated]`;

  const res = await chatFn(
    [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: judgePrompt(r, diff) },
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
  if (!judgeModel) throw new Error("JUDGE_MODEL is not set — add it to .env (e.g. JUDGE_MODEL=anthropic/claude-opus-4.8)");
  const { chat } = await import("../llm");

  const runJson = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")) as { records: RunRecord[] };
  const runs: RunScore[] = [];

  for (const r of runJson.records) {
    if (!r.pass) {
      runs.push({ case: r.case, model: r.model, repeat: r.repeat, pass: false, scores: Object.fromEntries(dimNames.map((d) => [d, 0])), mean: 0, worst_moment: `failed the binary check: ${r.detail}` });
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
    runs.push({ case: r.case, model: r.model, repeat: r.repeat, pass: true, scores, mean, worst_moment: first.worst_moment, ...(unstable?.length ? { unstable } : {}) });
  }

  const passes = runs.filter((r) => r.pass);
  const report: QualityReport = {
    judgeModel,
    passRate: runJson.records.length ? passes.length / runJson.records.length : 0,
    meanQualityOverPasses: passes.length ? passes.reduce((n, r) => n + r.mean, 0) / passes.length : 0,
    runs,
  };
  fs.writeFileSync(path.join(dir, "quality.json"), JSON.stringify(report, null, 2));
  return report;
}

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
  const header = "run".padEnd(width) + dimNames.map((d) => d.slice(0, 10).padStart(12)).join("") + "mean".padStart(8);
  console.log(header);
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
  const stability = args.includes("--stability");
  const dirArg = args.find((a) => !a.startsWith("--"));
  const dir = dirArg ? path.resolve(dirArg) : latestResultsDir();
  console.log(`judging ${dir}`);
  const report = await judgeResults(dir, { stability });
  printReport(report);
  console.log(`\nwrote ${path.join(dir, "quality.json")}`);
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
