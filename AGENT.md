# Agent Notes

- Build/test commands: `npm run check`, `npm run typecheck`, `npm run build`.
- Tool registry lives in `src/tools/index.ts`; each model-facing tool is one file under `src/tools/` exporting a `Tool`.
- Core file tools are workspace-confined through `resolveInWorkspace`; keep new filesystem tools behind the same boundary.
- Search tools: `glob` and `grep` are implemented in `src/tools/glob.ts` and `src/tools/grep.ts`; shared walking/glob helpers live in `src/tools/search-utils.ts`.
