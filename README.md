# mini-coding-agent

A minimal terminal coding agent: an LLM wrapped in a runtime loop that reads files,
edits code, and runs commands to work through a task in a repo. Built from the model
I/O layer up.

## Stack
- **TypeScript**, run directly with [`tsx`](https://github.com/privatenumber/tsx) — no build step.
- Model access via [OpenRouter](https://openrouter.ai); default model `deepseek/deepseek-v4-flash`.
- Native only — no CLI/color/spinner dependencies (`util.styleText`, `readline/promises`).

## Setup
```bash
npm install
cp .env.example .env   # then add your OPENROUTER_API_KEY
```

## Run
```bash
npm run dev                       # interactive chat — type a goal, 'exit' to quit
npm run dev -- "fix the failing test"   # one-shot — runs once, exits with a real code
DEBUG=1 npm run dev               # also print per-turn context-budget lines
npm run check                     # offline self-checks (no model/network)
```

## Layout
```
src/
  index.ts            CLI shell — interactive REPL + one-shot
  agent.ts            the agent loop (model → tools → results → repeat)
  llm.ts              OpenRouter client + chat helper
  context.ts          token accounting + history compaction
  permissions.ts      safety gate run before every tool call
  ui.ts               terminal color/spinner/render (native)
  prompts/system.md   the system prompt (standing orders), loaded at startup
  tools/              one file per tool; tools/index.ts assembles + dispatches
```
