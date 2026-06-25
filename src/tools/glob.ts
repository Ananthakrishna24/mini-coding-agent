import type { Tool } from "./types";
import { globToRegExp, normalizeSearchRoot, validatePositiveInteger, walkWorkspaceFiles } from "./search-utils";

export const glob: Tool = {
  schema: {
    type: "function",
    function: {
      name: "glob",
      description:
        "Fast file pattern matching within the workspace. Supports glob patterns like '**/*.ts' or 'src/**/*.tsx'. " +
        "Returns matching file paths sorted by modification time (newest first). Use this when finding files by name/pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to match against workspace-relative paths." },
          path: { type: "string", description: "Optional workspace-relative directory to search within. Defaults to workspace root." },
          limit: { type: "number", description: "Maximum number of matches to return. Default 100, max 1000." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  async run({ pattern, path, limit }) {
    if (typeof pattern !== "string" || pattern.trim() === "") throw new Error("glob: 'pattern' must be a non-empty string");
    const max = validatePositiveInteger(limit, "limit", 100, 1000);
    const root = normalizeSearchRoot(path);
    const re = globToRegExp(pattern);
    const files = await walkWorkspaceFiles(root.abs);
    const matches = files
      .filter((f) => re.test(root.rel ? f.rel.slice(root.rel.length + 1) : f.rel) || re.test(f.rel))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, max)
      .map((f) => f.rel);
    if (matches.length === 0) return "no matches";
    return matches.join("\n");
  },
};
