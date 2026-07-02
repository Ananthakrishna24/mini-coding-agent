# Eval & Optimize Guide (for coding agents: Claude Code, Codex, or humans)

How to run the reliability eval, the quality benchmark, and the prompt-optimization loop in this
repo. Written so an agent can execute it end-to-end without asking questions.

## Prerequisites

1. `npm install` (Node ≥ 20).
2. A `.env` at the repo root (copy `.env.example`). Required keys:

| var | purpose |
|---|---|
| `OPENROUTER_API_KEY` (or `OPENAI_API_KEY` / `MISTRAL_API_KEY`) | runs the agent under test |
| `AGENT_MODEL` | default model under test (any `--models` flag overrides it) |
| `JUDGE_MODEL` | strong model that scores quality, e.g. `anthropic/claude-opus-4.8` |
| `OPTIMIZER_MODEL` | strong model that rewrites prompts (falls back to `JUDGE_MODEL`) |

The judge and optimizer are called through the same provider client as the agent, so their model
ids must be reachable with the same key (an OpenRouter key covers all of this).

3. Sanity gates before any eval work, and again before committing:

```
npm run typecheck
npm run check
```

`npm run check` is offline and free. `npm run eval*` and `npm run tune` spend real money.

## Layer 1 — Reliability eval (binary pass/fail)

```
npm run eval                                   # full suite, default model
npm run eval -- create-file edit-file          # named cases only
npm run eval -- --split train                  # one split only
npm run eval -- --models qwen/qwen-2.5-7b-instruct,openai/gpt-5.4 --repeat 3
```

- `--repeat N` runs every case N times and reports pass-rates. The agent is nondeterministic;
  never trust a delta from a single run. Use `--repeat 3` for any comparison.
- Multi-model runs print a `case × model` grid at the end.
- Every run writes `eval-results/<timestamp>/<model>/<case>/` containing:
  - `trajectory.jsonl` — every assistant turn, tool call, tool result, usage, compaction, final
  - `diff.patch` — git diff of the workspace (seed → final)
  - `stdout.txt`, `meta.json` — process output, pass/fail + metrics
- The scorecard prints per-run metrics: `turns · tokens in/out · tools (errors, edit-misses) ·
  bare responses · compactions`. Rising edit-misses or bare responses is a regression even while
  pass-rate holds.

Case list and splits live in `src/eval/cases.ts` (`split: "train" | "holdout"`, default train).

## Layer 2 — Quality benchmark (rubric judge)

```
npm run eval:quality                           # judges the latest eval-results dir
npm run eval:quality -- eval-results/<dir>     # judges a specific dir
npm run eval:quality -- --stability            # double-judges; flags dimensions that disagree by ≥2
```

- Requires `JUDGE_MODEL`. The judge scores each **passing** run 1–5 on six anchored dimensions
  (`src/eval/rubrics.ts`): correctness, minimality, convention_fit, process_efficiency,
  verification, final_answer_quality. Failing runs score 0 and are never judged — quality can
  never rescue a run that didn't work.
- Output: a table plus `quality.json` in the results dir with per-run scores, `passRate`, and
  `meanQualityOverPasses`.
- `--stability` flags rubric ambiguity (`unstable: [...]`). If a dimension is flagged often,
  fix its anchors in `rubrics.ts` — that's rubric noise, not signal.

The two headline numbers are read together: **pass-rate** (does it work) and **mean quality over
passes** (is the work good). Combined objective used by the tuner:
`objective = passRate × 100 + meanQuality × 10` — reliability dominates by construction.

## Layer 3 — Automated prompt-optimization loop

```
npm run tune -- --target qwen/qwen-2.5-7b-instruct
npm run tune -- --target <model> --iterations 8 --repeat 3 --min-delta 3 --prompt <start-file>
```

What one iteration does:

1. Evaluates the current best prompt on the **train** split of the gauntlet (`--repeat` runs each).
2. Judges quality; computes the objective.
3. Feeds the optimizer model the current prompt, the rubric, the scores, and the 3 worst runs
   (failure detail, judge critique, trajectory tail). The optimizer must change **at most two
   things**, may not add benchmark-specific hints, must keep the `final_answer` contract, and
   replies with only the new prompt text.
4. Evaluates the candidate on train. Accepts only if the objective improves by more than
   `--min-delta` (the noise band — a delta smaller than run-to-run variance is not a win).
5. On acceptance, validates on the **holdout** split. Train up + holdout down = overfitting;
   the candidate is rejected, and two such regressions stop the loop entirely.

Stops after `--iterations`, 3 consecutive rejections, or the overfitting stop. Artifacts land in
`eval-results/tune-<timestamp>/`: per-iteration candidate prompts, their full eval results, and
`report.json`.

Installing a winner:

```
mkdir -p src/prompts/tuned
cp eval-results/tune-<ts>/iter-<n>/system.candidate.md src/prompts/tuned/<model-slug>.md
AGENT_SYSTEM_PROMPT_FILE=src/prompts/tuned/<model-slug>.md npm run dev
```

Commit tuned prompts to git — they are reviewable artifacts, not scratch.

## Manual optimize loop (when you are the optimizer)

An agent (Claude Code / Codex) can run the loop itself instead of `npm run tune` — same
discipline, human-grade diagnosis:

1. Baseline: `npm run eval -- --split train --repeat 3 --models <target>` then
   `npm run eval:quality`. Record objective.
2. Read the worst runs' `trajectory.jsonl` and `quality.json` `worst_moment` fields. Diagnose
   whether the failure is prompt-attributable (instructions ignored, wrong tool habits, prose
   drift) or harness/model-limit (context overflow, API errors) — only the former is fixable here.
3. Write a candidate prompt file (start from `src/prompts/system.md`). Change at most two things.
   Never reference benchmark file names or tasks in the prompt.
4. Re-run step 1 with `AGENT_SYSTEM_PROMPT_FILE=<candidate>` in the environment.
5. Accept only if the objective improves by more than ~3 points; then confirm on
   `--split holdout` before declaring victory. Revert anything that wins train but loses holdout.

## Rules that keep the numbers honest

- **Never compare single runs.** `--repeat 3` minimum; compare pass-rates and means.
- **Quality is gated on pass.** Do not change this — it is what stops the loop from learning
  beautiful diffs that don't work.
- **Holdout is sacred.** The optimizer (automated or you) must never see holdout trajectories
  while writing a candidate. If holdout keeps regressing, the gauntlet is too small — add cases
  to `src/eval/cases.ts`, don't loosen the rule.
- **Prompts must stay task-agnostic.** A prompt that names `counter.txt` scores well and learned
  nothing.
- **Watch spend.** Metrics include real token counts per run; the tuner prints per-iteration
  spend. A full tune at defaults ≈ (cases × repeat × ~2) agent runs + judge calls per iteration.
- **Never push to `main`.** Work on a feature branch; eval artifacts (`eval-results/`) are
  gitignored and must stay out of commits.

## Extending the gauntlet

Add cases to `src/eval/cases.ts`. A good case: a machine-checkable outcome (`check` returns
`true` or a reason string), a `split` tag, and `rubricNotes` telling the judge what a correct,
minimal solution looks like (the gold knowledge). Cover a failure *shape*, not a variation of an
existing case. Then update the offline test in `src/eval.check.ts` if the check logic is
non-trivial, and run `npm run check`.
