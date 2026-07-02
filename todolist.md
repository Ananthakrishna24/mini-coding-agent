# Improvement Todolist

Priority-ordered work items for extracting more performance from small models (and improving the
harness for all models). Each item says **what** to do, **where** in the code, **how** to do it, and
**done-when** criteria. Sizes: S = under ~50 lines, M = ~50–200 lines, L = a real feature.

Ground rule for the whole list: **P0 ships first.** Every later item claims to improve small-model
performance; without P0 there is no way to verify that claim, and prompt/loop changes are exactly the
kind of change that "feels better" while measuring worse.

---

## P0 — Measurement first (build the gauntlet before tuning anything)

### P0.1 — Trajectory capture (S/M)

**What:** Record the full run — every model request/response, tool call, tool result, token usage,
compaction event, and the final result — to a JSONL file, switchable via env.

**Where:** `src/agent.ts` (the `run()` loop), `src/eval/run-eval.ts` (set the env per case).

**How:**
- Add a tiny module `src/trajectory.ts` with `logEvent(event: object)`. When
  `AGENT_TRAJECTORY=/path/to/file.jsonl` is set, append one JSON line per event; when unset, no-op.
- Emit events in `agent.ts`: `{type:"assistant", turn, content, tool_calls}`,
  `{type:"tool_result", turn, name, args, result, ms}`, `{type:"usage", prompt_tokens, completion_tokens}`,
  `{type:"compaction", tier, tokensFreed}`, `{type:"final", success, summary, turns}`.
- In `run-eval.ts` `runCase()`, create a per-run results dir
  (`eval-results/<timestamp>/<case>-<model>.jsonl`) and pass `AGENT_TRAJECTORY` into the child env.

**Done when:** `npm run eval` leaves a JSONL per case that replays the whole run, and unsetting the
env produces zero overhead.

### P0.2 — Mechanical (objective) metrics in the scorecard (S)

**What:** Derive per-run metrics from the trajectory and print them next to PASS/FAIL: turns used,
total tokens in/out, tool-error count, `edit_file` failure count, repeated-call count, bare-prose
(final_answer protocol violation) count, compactions triggered.

**Where:** New `src/eval/metrics.ts`; extend `summarize()` in `src/eval/run-eval.ts`.

**How:** Pure function `computeMetrics(events: TrajectoryEvent[]): Metrics` — count events where the
tool result starts with `error:`, where an `edit_file` result contains `not found`/`matches N places`,
etc. These are free, deterministic, and don't need a judge; they are the early-warning system for
regressions the binary check can't see.

**Done when:** Scorecard prints a metrics row per case; `eval.check.ts` gets an offline test feeding
`computeMetrics` a synthetic trajectory.

### P0.3 — Expand the eval into a small-model gauntlet (M)

**What:** Add cases that are adversarial *specifically for small models*. The current six cases in
`src/eval/cases.ts` are near-100% for any competent model and can't measure improvement.

**Where:** `src/eval/cases.ts`.

**How — add at least these case shapes:**
1. **Exact-match edit on hostile whitespace:** seed a file with tabs+spaces mix and near-duplicate
   lines; require a one-line change. Tests `edit_file` recovery (see P1.3).
2. **Long-file edit:** seed a ~3–5k-line file; require an edit near the bottom. Tests read
   paging + tool-result caps under a small window.
3. **Red-herring error:** seed a failing test whose error message points at the wrong file. Tests
   diagnose-vs-thrash.
4. **Multi-step with verification:** "fix the bug, then run the test script and only finish when it
   passes" — check both the fix and that the trajectory contains a passing `run_bash`.
5. **Prose-drift bait:** a pure Q&A task ("read X and tell me Y") — historically where small models
   answer in prose and never call `final_answer`. Check exit code 0.
6. **Re-read legitimacy:** a task that genuinely requires reading the same file 3+ times
   (read → edit → verify → edit → verify). Today this can trip the repeat guard (see P1.4).

**Done when:** A strong model passes ≥90% and a ~8B-class model measurably does not (that gap is the
headroom every later item gets judged against).

### P0.4 — Model-matrix runner (S)

**What:** Run the whole gauntlet across a list of models in one command and print a comparison table.

**Where:** `src/eval/run-eval.ts` (the child already respects `AGENT_MODEL` — see `src/llm.ts:20`).

**How:** Accept `--models a,b,c` (or `EVAL_MODELS` env); loop the suite per model, injecting
`AGENT_MODEL` into the child env; print one scorecard per model plus a final `case × model` grid.
Add `--repeat N` (run each case N times, report pass-rate) — single runs of a nondeterministic system
are noise; N=3 is the minimum for trusting a delta.

**Done when:** `npm run eval -- --models openai/gpt-5.4,qwen/qwen-2.5-7b --repeat 3` produces a grid.

---

## P1 — Mechanical reliability wins (strictly non-degrading for big models)

### P1.1 — Low default temperature for the agent loop (S)

**What:** Send `temperature` on every chat call, default low (0.1–0.2), overridable via
`AGENT_TEMPERATURE` env.

**Where:** `src/llm.ts` — the `base` object in `chat()` (~line 57).

**Why:** Small-model tool-call JSON validity degrades sharply at provider-default temperatures
(often 0.7–1.0). This is the cheapest single win on the list.

**How:** `...(TEMP !== null ? { temperature: TEMP } : {})`. Some reasoning models (o-series) reject
`temperature`; mirror the existing `reasoning_effort` 400-retry pattern at `src/llm.ts:63-68` —
on a 400 mentioning `temperature`, retry once without it.

**Done when:** Requests carry the temperature; `AGENT_TEMPERATURE=default` (or empty) restores
provider default; the 400 fallback is covered by a check.

### P1.2 — Forced `final_answer` instead of hard failure on prose drift (S)

**What:** Today a second bare prose reply fails the whole run
(`BARE_RESPONSE_LIMIT = 2`, `src/agent.ts:149-164`). Instead, on the second bare reply, retry that
single completion with `tool_choice: {type:"function", function:{name:"final_answer"}}` so the model
is mechanically forced to emit the structured ending. Only fail if the forced call also fails.

**Where:** `src/agent.ts:149-164`; `chat()` in `src/llm.ts` needs an optional `toolChoice` in `opts`.

**How:** Also improve the nudge text: quote the model's own prose back —
*"If that reply was your final answer, call final_answer with it as the summary."* Small models
follow concrete instructions about their own output far better than protocol reminders.

**Done when:** The P0.3 prose-drift case passes on a small model that previously failed it; big-model
runs are unaffected (they never hit the second bare reply).

### P1.3 — Closest-match feedback on `edit_file` misses (M)

**What:** When `old_string` isn't found (`src/tools/edit_file.ts:45`), return the *nearest region* of
the file in the error so the model can self-correct in one turn instead of re-reading everything.

**How:**
- Write `findClosestMatch(text: string, needle: string)` in a new `src/tools/fuzzy.ts`:
  line-window scan comparing whitespace-normalized similarity (e.g. per-line trigram or
  Levenshtein-on-normalized-lines; keep it O(lines × needle_lines), no deps).
- Error becomes:
  `edit_file: 'old_string' not found. Closest match (lines 40-44, differs in whitespace):\n<exact text from file>\nUse this exact text as old_string if it is what you meant.`
- **Do NOT auto-apply fuzzy matches.** Show, don't guess — silent near-match application corrupts
  files. The model must resend the edit with the exact text.

**Done when:** The P0.3 hostile-whitespace case shows one-turn recovery in trajectories; unit tests
in `tools.check.ts` cover exact-hit, whitespace-diff hit, and no-plausible-match ("not found" with no
suggestion) paths.

### P1.4 — Repeat guard counts consecutive repeats only (S)

**What:** `seen` in `src/agent.ts:111,197-204` counts identical calls across the *entire run* and the
third occurrence hard-fails. Reading the same file three times over a 40-turn run is normal — and the
micro-compact truncation message (`src/context.ts:70`) explicitly tells the model to re-read files.

**How:** Reset a signature's count whenever a *different* successful tool call lands in between
(track `lastSig`; identical-to-last increments, anything else resets that signature to 1). Keep the
hard stop at 3 consecutive — that's a genuine tight loop.

**Done when:** The P0.3 re-read case passes; a synthetic tight loop (same call 3× back-to-back) still
stops.

### P1.5 — Recovery-grade error messages everywhere (S)

**What:** Every terminal error string is a place a small model either recovers or dies. Fix the dead
ends:
- `dispatch()` unknown tool (`src/tools/index.ts:52`): append the valid tool names —
  `unknown tool 'read'. Available: read_file, write_file, edit_file, …`.
- `dispatch()` invalid JSON args (`src/tools/index.ts:58`): before rejecting, attempt trivial repair
  (strip trailing commas, escape raw newlines inside strings, strip markdown fences). ~15 lines.
  If repair succeeds, proceed; if not, include the first ~100 chars of the raw args in the error.
- `grep` no matches (`src/tools/grep.ts:126`): suggest the next move —
  `no matches — try a broader pattern, or drop the glob filter`.

**Done when:** Each has a unit test in `tools.check.ts`; the JSON repairer never "fixes" valid JSON
into something else (property: `repair(validJson) === validJson`).

### P1.6 — `run_bash` output keeps head AND tail under truncation (S)

**What:** `microCompact` (`src/context.ts:108`) keeps only the first 800 chars of old tool output —
but for `run_bash` the exit summary/error is at the *end*. Reuse the head+tail split already written
in `capResult` (`src/tools/index.ts:41-47`).

**Done when:** A truncated bash result in a compacted history still shows its tail; covered in
`context.check.ts`.

---

## P2 — Small-model prompt tier

### P2.1 — `system.small.md` replacement prompt with one few-shot episode (M)

**What:** The main prompt (`src/prompts/system.md`, ~110 lines of abstract guidance) is written for
frontier models; a 7B model can't act on "hold the bar of the strongest practitioner" and it costs
~2k tokens of an 8–32k window. Build a *replacement* (not addendum — the OpenAI file at
`src/prompts/system.openai.md` is an addendum; this is a different mechanism):
- Short imperative rules only (~25 lines): read before editing, one change then verify, batch
  independent calls, always end with `final_answer`.
- **One worked few-shot episode**: a complete miniature transcript
  (task → `read_file` → `edit_file` → `run_bash` test → `final_answer`) rendered as example text.
  For small models a single concrete trajectory outperforms any amount of prose about habits.

**Where:** New `src/prompts/system.small.md`; selection in `buildSystemPrompt()`
(`src/agent.ts:50-65`).

**How to select:** `getContextWindow() < SMALL_WINDOW_THRESHOLD` (e.g. 48k) OR explicit
`AGENT_PROMPT_TIER=small` env. Window-based is a proxy, not truth — the env override is the escape
hatch; the tuning loop (P5) will pick the right tier per model empirically anyway.

**Done when:** Gauntlet pass-rate on a small model improves vs. the full prompt (P0.4 matrix,
`--repeat 3`), and the frontier-model runs still use the full prompt unchanged.

### P2.2 — Do-NOT list (guard against scaffolding creep) (S)

**What:** Documentation item: record in this file and in `AGENT.md` that we deliberately do **not**
add forced planning phases, ReAct-style thought fields, or mandatory step-by-step templates. Small
models fill those with filler that pollutes context; frontier models are degraded by them (see the
"less scaffolding, sharper contracts" note in `system.openai.md`). Any such proposal must beat the
baseline on the P0 gauntlet first.

---

## P3 — Context scaling & cache hygiene

### P3.1 — Scale tool-result caps with the context window (S)

**What:** `MAX_TOOL_RESULT = 12_000` chars (`src/tools/index.ts:40`) is a rounding error at 200k
context and ~1/3 of the usable budget at 8k.

**How:** `capResult` takes the cap from a function of `getContextWindow()` — e.g.
`clamp(window_tokens * 4 * 0.08, 4_000, 24_000)` chars. Careful: `tools/index.ts` must not import
`llm.ts` cyclically — pass the cap in from the dispatcher or read it via a setter the agent
initializes.

**Done when:** On a 8k-window model no single tool result exceeds ~10% of budget; long-file gauntlet
case (P0.3 #2) improves.

### P3.2 — Micro-compact hysteresis (don't shred the prompt cache every turn) (S/M)

**What:** Past 75% budget, `microCompact` (`src/context.ts:78-114`) mutates old tool messages in
place *every turn* (the keep-window slides), invalidating the provider's cached prompt prefix at
exactly the moment context is biggest. The harness already cares about caching (date-only line in
`buildSystemPrompt`, `src/agent.ts:54`) — this is the inconsistency.

**How:** When crossing the 75% threshold, compact aggressively down to a target (~60%) in one pass —
truncate *more* old results per pass (drop `TOOL_RESULT_KEEP_RECENT` protection for all but the last
2–3, lower `TOOL_RESULT_MAX_CHARS`) — then don't micro-compact again until 75% is crossed again.
One cache invalidation per band instead of per turn.

**Done when:** A trajectory under sustained context pressure shows micro-compact firing in bursts,
not every turn.

### P3.3 — Small-window summarization: earlier, shorter, safer (M)

**What:** The summary tier (`src/agent.ts:328-365`) fires at 90–98% and sends the *entire
over-budget history plus* the long 9-section `COMPACT_PROMPT` to the same model. On a small window
the summarization request itself can exceed the real limit → API error → emergency drop. And a 7B
model asked for a 9-section structured summary produces mush.

**How:**
- If `inputBudget < 48k`: trigger the summary tier at ~80% instead of 90%, and use a short compact
  prompt (~6 lines: goal, files touched, what changed, what failed, next step).
- Before sending the summarization request, if the history + prompt estimate exceeds budget,
  hard-truncate the middle of the history for the summarization call only.

**Where:** `src/context.ts` (thresholds become functions of budget; second `COMPACT_PROMPT_SHORT`),
`src/agent.ts` summary branch.

**Done when:** Sustained-pressure runs on a 16k model reach the summary tier without API-level
context errors; emergency `drop` tier becomes rare in trajectories.

### P3.4 — Harness-maintained state block (survives compaction for free) (M)

**What:** The harness already *knows* the durable facts — files read/edited (`file-state.ts`), the
current plan (`update_plan`), the original goal. Maintain a compact state block mechanically and
re-inject it after any summary/drop compaction, so continuity does not depend on a small model
writing a good summary.

**How:** Track in `run()`: goal, plan steps + statuses, list of files written/edited. After a
summary or drop compaction, append a synthetic user message:
`<state>goal: …\nplan: …\nfiles changed: …</state>`. ~40 lines, zero model competence required.

**Done when:** After a hard-drop, the model's next actions still target the right files (visible in
the P0.3 long-run trajectories).

---

## P4 — Model output QUALITY benchmark (rubric judge)

> Goal: today the eval answers "did it work?" (binary reliability). This adds "how good was it?" —
> scored by a strong judge model (Claude / GPT / whatever key is configured) against explicit
> rubrics, so quality deltas between prompts/models/harness-changes become a number you can compare.

### P4.1 — Make workspaces diffable (S)

**What:** Judges score *changes*, so capture them precisely.

**How:** In `runCase()` (`src/eval/run-eval.ts:74-90`), after `setup()`, run
`git init && git add -A && git commit -m seed` in the temp workspace; after the run, capture
`git diff HEAD` (plus `git status --porcelain` for untracked files, and their contents). Store the
diff alongside the trajectory in the results dir. Cheap, exact, and judge-friendly.

**Done when:** Every eval result dir contains `diff.patch` per case.

### P4.2 — Rubric definitions (S — but the thinking matters most)

**What:** A rubric file per case *shape*, plus a global rubric. Keep 4–6 dimensions, each scored
1–5 **with written anchors** (what a 1 looks like, what a 5 looks like) — anchor-free numeric scales
produce judge noise.

**Where:** New `src/eval/rubrics.ts` (typed objects, not markdown, so the judge prompt is assembled
mechanically). Add an optional `rubricNotes` field to `EvalCase` for case-specific gold knowledge
("the correct fix is X; touching Y is scope creep").

**Global dimensions:**
| dimension | 5 looks like | 1 looks like |
|---|---|---|
| correctness | does exactly what was asked, edge cases held | wrong or partial despite passing the binary check |
| minimality | smallest coherent diff, no drive-by edits | unrelated files touched, rewrites instead of edits |
| convention fit | matches surrounding style/idiom | ignores file's existing patterns |
| process efficiency | few turns, no thrash, batched reads | repeated failed calls, redundant re-reads |
| verification | ran the relevant check after changing | edited and finished blind |
| final answer quality | honest, specific, matches the diff | vague, wrong, or overclaims |

Note: process efficiency and verification are **computed from the trajectory metrics (P0.2) where
possible** and only judged where they aren't — never ask a judge for something you can count.

### P4.3 — The judge runner (M/L)

**What:** `src/eval/judge.ts` + a `npm run eval:quality` entry.

**How:**
- Input per case: goal, `rubricNotes`, the seed files, `diff.patch`, the final summary, and the
  trajectory metrics. **Not** the full trajectory by default (cost + judge distraction); add
  `--full-trajectory` for debugging.
- Judge model configured via `JUDGE_MODEL` env (e.g. `anthropic/claude-opus-4.8` through the existing
  OpenRouter client — reuse `chat()` from `src/llm.ts` with the `opts.model` override that already
  exists for subagents).
- Force structured output: give the judge a single `score` tool
  (`{scores: {dimension: int}, rationale_per_dimension: {…}, worst_moment: string}`) with
  `tool_choice` forced — same mechanism as P1.2. Rationale *before* score in the schema field order
  (judges score better after writing the critique).
- **Gate quality on reliability:** only passing runs get quality scores; failing runs score 0 and
  keep their binary FAIL. This prevents the classic failure where prompt tuning (P5) learns to
  produce beautiful diffs that don't work.
- Judge twice with the same inputs (temperature 0) and flag dimensions where the two scores differ
  by ≥2 — that's rubric ambiguity to fix, not signal.

**Output:** `eval-results/<timestamp>/quality.json` + a printed table
(`case × dimension`, plus mean per dimension and overall). The scorecard now has two numbers per
model: **pass-rate** (reliability) and **mean quality** (only over passes).

**Done when:** Two consecutive `eval:quality` runs on the same trajectories agree within ~0.5 mean
score (judge stability), and a deliberately-bad run (e.g. `write_file` whole-file rewrite instead of
an edit) scores visibly lower on minimality.

### P4.4 — Judge-quality checks (S)

**What:** Trust but verify the judge. Keep 3–5 hand-scored reference runs (good, mediocre, bad) in
`src/eval/fixtures/`; `eval.check`-style test asserts the judge ranks them in the right order.
Re-run whenever the rubric or judge model changes.

---

## P5 — Prompt auto-tuning loop (strong model optimizes the small model's prompt)

> The idea you described: a powerful model (Claude/Codex-class) iteratively rewrites the small
> model's system prompt, runs the benchmark, and keeps improvements — until quality stops improving.
> This is only sane *after* P0 (measurement), P1 (mechanical floor), and P4 (quality score) exist,
> because the optimizer needs a trustworthy objective. Optimizing against a weak eval produces
> prompts overfitted to the eval, not better prompts.

### P5.1 — Split cases into train / holdout (S)

**What:** Tag each `EvalCase` with `split: "train" | "holdout"` (roughly 70/30, both splits covering
all case shapes). The optimizer only ever sees train results; acceptance is judged on holdout.
Without this, the loop *will* overfit — that's not a risk, it's a certainty on a small suite.

### P5.2 — The optimizer loop (L)

**What:** `src/eval/tune-prompt.ts`, run as `npm run tune -- --target qwen/qwen-2.5-7b --iterations 8`.

**How (per iteration):**
1. Run the train split on the target model with the current candidate prompt
   (`--repeat 3`; use pass-rate + mean quality as the objective:
   `score = pass_rate * 100 + mean_quality * 10` — reliability dominates by construction).
2. Select the 3 worst runs (failed, or lowest quality) and pull their trajectories + judge
   rationales + `worst_moment` strings.
3. Ask the optimizer model (`OPTIMIZER_MODEL` env, a strong model) with a meta-prompt:
   *"Here is the current system prompt, the rubric, the scores, and the worst trajectories with
   judge critiques. Diagnose the prompt-attributable failures and propose ONE revised prompt.
   Rules: keep it under N tokens; do not add case-specific hints (naming eval file names or tasks
   is forbidden); do not remove the final_answer contract; change at most 2 things per iteration."*
   The "at most 2 changes" rule keeps the search interpretable and lets you attribute wins.
4. Write the candidate to `eval-results/tune/<iter>/system.candidate.md`, run the train split with
   it (inject via a new `AGENT_SYSTEM_PROMPT_FILE` env read in `buildSystemPrompt()` —
   `src/agent.ts:50`), and **accept only if** train score improves by more than the noise band
   (estimate noise from repeat variance in step 1; a delta smaller than the spread of repeats is
   not a win).
5. On acceptance, also run the holdout split. If holdout regresses while train improves twice in a
   row → stop: the loop is overfitting; widen the gauntlet before continuing.

**Termination:** max iterations, or 3 consecutive rejected candidates, or holdout-regression stop.
Final output: best prompt + a report (`per-iteration scores, accepted diffs, total spend`).

**Cost control:** print running token spend per iteration (usage is already returned by `chat()`);
hard budget via `TUNE_MAX_USD` using catalog prices (`src/llm.ts` `ModelInfo.promptPrice`).

### P5.3 — Per-model prompt registry (S)

**What:** Once tuned prompts exist, store them as `src/prompts/tuned/<model-id-slug>.md` and have
`buildSystemPrompt()` prefer an exact model match, then the size tier (P2.1), then the default.
Check the tuned prompts into git — they are build artifacts worth reviewing like code.

---

## Explicitly rejected (do not implement without new evidence)

- **Silent fuzzy-apply in `edit_file`** — auto-applying near-matches corrupts files; P1.3 shows the
  match and makes the model confirm.
- **Forced planning/ReAct thought fields** — filler generator for small models, measured degradation
  for large ones (see P2.2).
- **A single universal prompt tuned for all model sizes** — the scaffolding small models need is the
  scaffolding that degrades frontier models. Tier it (P2.1/P5.3).
- **Letting quality scores override the binary pass gate** — quality is only computed over passing
  runs, always (P4.3).
