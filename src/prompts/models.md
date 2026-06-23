# Model catalog

Hand-maintained list of models worth delegating to, with the reasoning effort to use and the kind of
task each one suits. The agent reads this (via `list_models`) when picking a `model` for a subagent.

Keep it short and honest. Edit it to match the models your provider key can actually reach — the `id`
column must be the exact id you pass to the provider (e.g. an OpenRouter `vendor/model` id). Delete
rows you don't use; a wrong id just fails the subagent's call.

| id | strengths | reasoning effort | good for |
|----|-----------|------------------|----------|
| `anthropic/claude-opus-4.8` | strongest reasoning + coding, large context | high for hard problems, medium otherwise | architecture, tricky bugs, multi-file refactors, reviews |
| `anthropic/claude-sonnet-4.6` | fast, strong coding, cheaper than Opus | medium | most coding subtasks, edits, focused investigation |
| `anthropic/claude-haiku-4.5` | very fast, cheap | low / default | wide searches, simple extraction, mechanical edits |
| `deepseek/deepseek-v4-flash` | cheap, fast, solid general coding | default | the default workhorse; bulk read-and-report work |
| `openai/gpt-5.4` | strong reasoning, good tool use | high for analysis | deep analysis, planning, cross-checking another model |
| `google/gemini-3-pro` | huge context, strong synthesis | medium | summarizing many files, long-document reasoning |

## How to choose

- **Match cost to difficulty.** Don't put a flagship on a one-file grep — a cheap, fast model is right
  for wide search and mechanical work. Save the expensive, high-effort models for genuinely hard
  reasoning or code that's easy to get subtly wrong.
- **Effort follows the task, not the model.** Use `low`/`default` for lookup and extraction; `high`
  only when the subtask needs real step-by-step reasoning. Higher effort costs more tokens and time.
- **When unsure, use the parent (current) model.** Omitting `model` is always safe.
