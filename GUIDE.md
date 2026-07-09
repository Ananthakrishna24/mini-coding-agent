# Eval & Optimize Guide (for coding agents: Claude Code, Codex, or humans)

How to run the reliability eval, the quality benchmark, and the prompt-optimization loop in this
repo. Written so an agent can execute it end-to-end without asking questions.

The judging and optimizing are designed to be done by **the coding-agent harness you already pay
for** (a Claude Code or Codex session working in this repo) — not by extra paid API calls. The only
API spend is running the small model under test. An automated API-judge path exists behind explicit
flags for people who want it; it is opt-in, never the default.

## Prerequisites

1. `npm install` (Node ≥ 20).
2. A `.env` at the repo root (copy `.env.example`). Keys:

| var | required | purpose |
|---|---|---|
| `OPENROUTER_API_KEY` (or `OPENAI_API_KEY` / `MISTRAL_API_KEY`) | yes | runs the small model under test |
| `AGENT_MODEL` | yes | default model under test (`--models` overrides it) |
| `JUDGE_MODEL` | no | only for the opt-in `--api` judge / `npm run tune` |
| `OPTIMIZER_MODEL` | no | only for the opt-in automated `npm run tune` |

3. Sanity gates before any eval work, and again before committing:

```
npm run typecheck
npm run check
```

`npm run check` is offline and free. `npm run eval` spends money on the model under test only.

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

## Layer 2 — Quality benchmark (you are the judge)

Quality scoring is a three-step file workflow. No API calls; the agent reading this guide does the
scoring.

**Step 1 — prepare** (harness command, free):

```
npm run eval:quality                           # prepares the latest eval-results dir
npm run eval:quality -- eval-results/<dir>     # or a specific dir
```

This writes `JUDGING.md` at the results root (rubric + instructions + the list of runs to score)
and a `judge-packet.md` into each passing run's directory. Failing runs are skipped — they score 0
automatically; quality can never rescue a run that didn't work.

**Step 2 — score** (you, the coding agent):

Follow `JUDGING.md`. For each listed run: read its `judge-packet.md` (task, gold notes, diff, final
summary, metrics), read `trajectory.jsonl` in the same directory when you need process evidence,
write the rationale per dimension before deciding its score, then write `score.json` in that run's
directory. Six anchored 1–5 dimensions (`src/eval/rubrics.ts`): correctness, minimality,
convention_fit, process_efficiency, verification, final_answer_quality. Be harsh: a 5 must be
earned, a 3 has visible flaws.

**Step 3 — finalize** (harness command, free):

```
npm run eval:quality
```

Run again: it detects the score files, validates them (missing or out-of-range scores fail loudly),
zeros the failed runs, and writes `quality.json` with per-run scores, `passRate`, and
`meanQualityOverPasses`, plus a printed table.

The two headline numbers are read together: **pass-rate** (does it work) and **mean quality over
passes** (is the work good). Combined objective:
`objective = passRate × 100 + meanQuality × 10` — reliability dominates by construction.

Opt-in API judge (costs money, needs `JUDGE_MODEL`): `npm run eval:quality -- --api`
(add `--stability` to double-judge and flag dimensions that disagree by ≥2).

## Layer 3 — Optimize loop (you are the optimizer)

The recommended loop: the Claude Code / Codex session is both judge and optimizer. Total API spend
= the target model's eval runs, nothing else.

1. **Baseline.** `npm run eval -- --split train --repeat 3 --models <target>` then judge it
   (Layer 2). Record the objective. Do the same once for `--split holdout` and set it aside.
2. **Diagnose.** Read the worst runs' `trajectory.jsonl`, `judge-packet.md`, and your own
   `score.json` rationales. Classify each failure: prompt-attributable (instructions ignored,
   wrong tool habits, prose drift, no verification) vs harness/model-limit (context overflow, API
   errors). Only the former is fixable here; note the latter as harness todos.
3. **Write one candidate.** Copy the current prompt (`src/prompts/system.md` or the previous
   candidate) and change **at most two things**. Concrete imperative instructions beat abstract
   principles for small models. Never mention benchmark file names, task phrasings, or expected
   answers — a prompt that names `counter.txt` scores well and learned nothing. Keep the
   `final_answer` contract intact.
4. **Evaluate the candidate.** Re-run step 1's train command with the candidate injected:
   `AGENT_SYSTEM_PROMPT_FILE=<candidate-file> npm run eval -- --split train --repeat 3 --models <target>`
   then judge it (Layer 2).
5. **Accept or revert.** Accept only if the objective improves by more than ~3 points (the noise
   band — a delta smaller than run-to-run variance is not a win). On acceptance, confirm on
   `--split holdout` before declaring victory. Train up + holdout down = overfitting: revert the
   candidate; if it happens twice, stop tuning and widen the gauntlet instead.
6. **Repeat** from step 2 until two or three candidates in a row fail to clear the bar — that's
   convergence, not failure.

Installing a winner:

```
mkdir -p src/prompts/tuned
cp <candidate-file> src/prompts/tuned/<model-slug>.md
AGENT_SYSTEM_PROMPT_FILE=src/prompts/tuned/<model-slug>.md npm run dev
```

Commit tuned prompts to git — they are reviewable artifacts, not scratch. Keep a short log of
accepted/rejected candidates and their objectives in the PR description or a notes file; the next
session needs it to avoid retrying dead ends.

### Opt-in: fully automated loop (paid API)

`npm run tune -- --target <model> [--iterations 6] [--repeat 2] [--min-delta 3]` runs the same
loop unattended with `OPTIMIZER_MODEL` writing candidates and `JUDGE_MODEL` scoring — both paid
API calls. Same acceptance rules (min-delta on train, holdout validation, overfit stop). Artifacts
land in `eval-results/tune-<timestamp>/`. Use it only when you explicitly want to spend API money
on unattended tuning.

## Rules that keep the numbers honest

- **Never compare single runs.** `--repeat 3` minimum; compare pass-rates and means.
- **Quality is gated on pass.** Do not change this — it is what stops the loop from learning
  beautiful diffs that don't work.
- **Holdout is sacred.** Never read holdout trajectories while writing a candidate — judge them,
  record the number, look no deeper. If holdout keeps regressing, the gauntlet is too small — add
  cases to `src/eval/cases.ts`, don't loosen the rule.
- **Judge before you diagnose.** Score runs (Layer 2) before deciding what to change; writing the
  candidate first biases your own scoring.
- **Prompts must stay task-agnostic.** No benchmark file names, phrasings, or answers in any
  candidate.
- **Watch spend.** Metrics include real token counts per run; sum them before choosing `--repeat`.
- **Never push to `main`.** Work on a feature branch; eval artifacts (`eval-results/`) are
  gitignored and must stay out of commits.

## Extending the gauntlet

Add cases to `src/eval/cases.ts`. A good case: a machine-checkable outcome (`check` returns
`true` or a reason string), a `split` tag, and `rubricNotes` telling the judge what a correct,
minimal solution looks like (the gold knowledge). Cover a failure *shape*, not a variation of an
existing case. Then update the offline test in `src/eval.check.ts` if the check logic is
non-trivial, and run `npm run check`.
