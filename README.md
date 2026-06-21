# mini-coding-agent

A minimal terminal coding agent: an LLM wrapped in a runtime loop that reads files,
edits code, and runs commands to work through a task in a repo. Built from the model
I/O layer up.

> Early stage. Currently ships the OpenRouter model client and an entry point. The
> agent loop, tools, and context management land next.

## Stack
- **TypeScript**, run directly with [`tsx`](https://github.com/privatenumber/tsx) — no build step.
- Model access via [OpenRouter](https://openrouter.ai); default model `google/gemini-3-flash-preview`.

## Setup
```bash
npm install
cp .env.example .env   # then add your OPENROUTER_API_KEY
```

## Run
```bash
npm run dev
```

## Layout
```
src/
  llm.ts      OpenRouter client + chat helper (model I/O)
  index.ts    entry point
```
