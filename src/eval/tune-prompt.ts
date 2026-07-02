// Prompt auto-tuning loop: a strong optimizer model (OPTIMIZER_MODEL) iteratively rewrites the
// system prompt for a small target model, scored by the eval gauntlet (reliability) plus the rubric
// judge (quality). Optimizes on the train split only; accepted candidates are validated on holdout.
//   npm run tune -- --target qwen/qwen-2.5-7b-instruct --iterations 6 --repeat 2
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSuite, type RunRecord } from "./run-eval";
import { judgeResults, type QualityReport } from "./judge";
import { rubricText } from "./rubrics";
import { formatMetrics, parseTrajectory } from "./metrics";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PROMPT = path.join(REPO_ROOT, "src", "prompts", "system.md");
const WORST_RUNS = 3;
const TRAJECTORY_TAIL = 15;
const MAX_CONSECUTIVE_REJECTS = 3;

type EvalResult = { dir: string; records: RunRecord[]; quality: QualityReport; objective: number; spend: { prompt: number; completion: number } };

type Iteration = {
  iteration: number;
  accepted: boolean;
  objective: number;
  passRate: number;
  meanQuality: number;
  promptFile: string;
  holdoutObjective?: number;
  note?: string;
};

const objective = (q: QualityReport) => q.passRate * 100 + q.meanQualityOverPasses * 10;

async function evaluate(target: string, repeat: number, split: "train" | "holdout", resultsDir: string, promptFile?: string): Promise<EvalResult> {
  const { dir, records } = await runSuite({ models: [target], repeat, split, resultsDir, systemPromptFile: promptFile, quiet: false });
  const quality = await judgeResults(dir);
  const spend = records.reduce(
    (acc, r) => ({ prompt: acc.prompt + r.metrics.promptTokens, completion: acc.completion + r.metrics.completionTokens }),
    { prompt: 0, completion: 0 },
  );
  return { dir, records, quality, objective: objective(quality), spend };
}

function worstRuns(result: EvalResult): string {
  const byKey = new Map(result.quality.runs.map((s) => [`${s.case}#${s.repeat}`, s]));
  const ranked = [...result.records].sort((a, b) => {
    if (a.pass !== b.pass) return a.pass ? 1 : -1;
    return (byKey.get(`${a.case}#${a.repeat}`)?.mean ?? 0) - (byKey.get(`${b.case}#${b.repeat}`)?.mean ?? 0);
  });
  return ranked
    .slice(0, WORST_RUNS)
    .map((r) => {
      const score = byKey.get(`${r.case}#${r.repeat}`);
      let tail = "";
      try {
        const events = parseTrajectory(fs.readFileSync(path.join(r.dir, "trajectory.jsonl"), "utf8"));
        tail = events
          .slice(-TRAJECTORY_TAIL)
          .map((e) => JSON.stringify(e))
          .join("\n");
      } catch {}
      return [
        `### ${r.case} — ${r.pass ? `passed, quality ${score?.mean.toFixed(1)}/5` : `FAILED: ${r.detail}`}`,
        `Task: ${r.goal}`,
        `Metrics: ${formatMetrics(r.metrics)}`,
        score?.worst_moment ? `Judge's worst moment: ${score.worst_moment}` : "",
        tail ? `Trajectory tail:\n\`\`\`\n${tail}\n\`\`\`` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function optimizerPrompt(currentPrompt: string, result: EvalResult, targetModel: string): string {
  return `You are optimizing the system prompt of a small coding-agent model (${targetModel}).
The agent works by calling tools (read_file, edit_file, multi_edit, write_file, run_bash, grep,
glob, spawn_agent, update_plan) and MUST end every run by calling the final_answer tool.

## Current system prompt
<current_prompt>
${currentPrompt}
</current_prompt>

## Benchmark results with this prompt
Pass rate: ${Math.round(result.quality.passRate * 100)}% · mean quality over passes: ${result.quality.meanQualityOverPasses.toFixed(2)}/5

Quality rubric the judge scores against:
${rubricText()}

## Worst runs
${worstRuns(result)}

## Your job
Diagnose which failures are attributable to the prompt (not the harness or model limits) and write
ONE revised system prompt.

Hard rules:
- Change at most TWO things versus the current prompt (rewrite, add, or remove at most two rules or sections).
- Keep the final_answer contract: the agent must finish by calling final_answer.
- Do NOT add hints specific to any benchmark task (no file names, task phrasings, or expected answers from the runs above).
- Keep the prompt under 1200 words. Shorter is better for a small model.
- Concrete imperative instructions beat abstract principles for small models.

Reply with ONLY the full text of the revised system prompt. No preamble, no explanation, no code fences.`;
}

function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : t;
}

function parseArgs(argv: string[]) {
  const out = { target: "", iterations: 6, repeat: 2, minDelta: 3, prompt: DEFAULT_PROMPT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i] ?? "";
    else if (a === "--iterations") out.iterations = Number(argv[++i]) || 6;
    else if (a === "--repeat") out.repeat = Number(argv[++i]) || 2;
    else if (a === "--min-delta") out.minDelta = Number(argv[++i]) || 3;
    else if (a === "--prompt") out.prompt = path.resolve(argv[++i] ?? "");
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) {
    console.error("usage: npm run tune -- --target <model-id> [--iterations 6] [--repeat 2] [--min-delta 3] [--prompt <file>]");
    process.exit(2);
  }
  const optimizerModel = process.env.OPTIMIZER_MODEL || process.env.JUDGE_MODEL;
  if (!optimizerModel) {
    console.error("OPTIMIZER_MODEL (or JUDGE_MODEL) is not set in .env");
    process.exit(2);
  }
  const { chat } = await import("../llm");

  const tuneDir = path.join(REPO_ROOT, "eval-results", `tune-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  fs.mkdirSync(tuneDir, { recursive: true });

  console.log(`target ${args.target} · optimizer ${optimizerModel} · judge ${process.env.JUDGE_MODEL}`);
  console.log(`\n=== baseline (train split) ===`);
  let bestPromptFile = args.prompt;
  let best = await evaluate(args.target, args.repeat, "train", path.join(tuneDir, "iter-0-train"), bestPromptFile === DEFAULT_PROMPT ? undefined : bestPromptFile);
  console.log(`baseline objective ${best.objective.toFixed(1)} (pass ${Math.round(best.quality.passRate * 100)}%, quality ${best.quality.meanQualityOverPasses.toFixed(2)})`);

  console.log(`\n=== baseline (holdout split) ===`);
  const baselineHoldout = await evaluate(args.target, args.repeat, "holdout", path.join(tuneDir, "iter-0-holdout"), bestPromptFile === DEFAULT_PROMPT ? undefined : bestPromptFile);
  let bestHoldoutObjective = baselineHoldout.objective;
  console.log(`baseline holdout objective ${baselineHoldout.objective.toFixed(1)}`);

  const iterations: Iteration[] = [
    { iteration: 0, accepted: true, objective: best.objective, passRate: best.quality.passRate, meanQuality: best.quality.meanQualityOverPasses, promptFile: bestPromptFile, holdoutObjective: baselineHoldout.objective, note: "baseline" },
  ];
  let rejects = 0;
  let holdoutRegressions = 0;

  for (let i = 1; i <= args.iterations; i++) {
    console.log(`\n=== iteration ${i}: asking optimizer for a candidate ===`);
    const currentPrompt = fs.readFileSync(bestPromptFile, "utf8");
    const res = await chat([{ role: "user", content: optimizerPrompt(currentPrompt, best, args.target) }], undefined, { model: optimizerModel, effort: null });
    const candidate = stripFences(res.choices?.[0]?.message?.content ?? "");
    if (!candidate || candidate.length < 200) {
      console.log("optimizer returned an unusable prompt — skipping iteration");
      iterations.push({ iteration: i, accepted: false, objective: 0, passRate: 0, meanQuality: 0, promptFile: "", note: "unusable candidate" });
      if (++rejects >= MAX_CONSECUTIVE_REJECTS) break;
      continue;
    }
    const candidateFile = path.join(tuneDir, `iter-${i}`, "system.candidate.md");
    fs.mkdirSync(path.dirname(candidateFile), { recursive: true });
    fs.writeFileSync(candidateFile, candidate);

    console.log(`evaluating candidate on train split…`);
    const result = await evaluate(args.target, args.repeat, "train", path.join(tuneDir, `iter-${i}`, "train"), candidateFile);
    const delta = result.objective - best.objective;
    console.log(`candidate objective ${result.objective.toFixed(1)} (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}, need > +${args.minDelta}) · spend ~${Math.round((result.spend.prompt + result.spend.completion) / 1000)}k tokens`);

    const record: Iteration = { iteration: i, accepted: false, objective: result.objective, passRate: result.quality.passRate, meanQuality: result.quality.meanQualityOverPasses, promptFile: candidateFile };

    if (delta > args.minDelta) {
      console.log(`accepted on train — validating on holdout…`);
      const holdout = await evaluate(args.target, args.repeat, "holdout", path.join(tuneDir, `iter-${i}`, "holdout"), candidateFile);
      record.holdoutObjective = holdout.objective;
      console.log(`holdout objective ${holdout.objective.toFixed(1)} (baseline ${bestHoldoutObjective.toFixed(1)})`);
      if (holdout.objective < bestHoldoutObjective - args.minDelta) {
        holdoutRegressions++;
        record.note = "train improved but holdout regressed — rejected (overfitting signal)";
        console.log(record.note);
        if (holdoutRegressions >= 2) {
          console.log("two holdout regressions — stopping: the loop is overfitting; widen the gauntlet before continuing");
          iterations.push(record);
          break;
        }
      } else {
        record.accepted = true;
        best = result;
        bestPromptFile = candidateFile;
        bestHoldoutObjective = Math.max(bestHoldoutObjective, holdout.objective);
        rejects = 0;
        holdoutRegressions = 0;
        console.log(`candidate ACCEPTED — new best prompt: ${candidateFile}`);
      }
    } else {
      record.note = "below min-delta — rejected";
      console.log(record.note);
      if (++rejects >= MAX_CONSECUTIVE_REJECTS) {
        iterations.push(record);
        console.log("three consecutive rejections — stopping");
        break;
      }
    }
    iterations.push(record);
  }

  const report = { target: args.target, optimizerModel, minDelta: args.minDelta, bestPromptFile, bestObjective: best.objective, iterations };
  fs.writeFileSync(path.join(tuneDir, "report.json"), JSON.stringify(report, null, 2));

  console.log(`\n=== done ===`);
  console.log(`best prompt: ${bestPromptFile}`);
  console.log(`report: ${path.join(tuneDir, "report.json")}`);
  if (bestPromptFile !== args.prompt) {
    const slug = args.target.replace(/[^a-zA-Z0-9._-]+/g, "_");
    console.log(`to install: cp "${bestPromptFile}" src/prompts/tuned/${slug}.md and run with AGENT_SYSTEM_PROMPT_FILE=src/prompts/tuned/${slug}.md`);
  } else {
    console.log("no candidate beat the baseline — keeping the current prompt");
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
