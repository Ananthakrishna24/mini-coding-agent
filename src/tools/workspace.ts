// Shared trust boundary for every file tool: confine paths to the working directory.
// The model's paths are untrusted input, so this runs before any fs call.
import path from "node:path";
import fs from "node:fs";

export const WORKSPACE = process.cwd();

// Heavy/noise dirs the @-file picker never walks into. Hardcoded skip list — add a dir here if needed.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage"]);

let fileCache: string[] | null = null;

// Workspace-relative file paths for the @-mention picker, walked once and cached for the session.
// Skips SKIP_DIRS and dotfiles; capped so a giant tree can't stall the UI.
export function listWorkspaceFiles(limit = 5000): string[] {
  if (fileCache) return fileCache;
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        out.push(path.relative(WORKSPACE, abs));
        if (out.length >= limit) return;
      }
    }
  };
  walk(WORKSPACE);
  fileCache = out;
  return out;
}

// Rank file paths for the @-mention picker (pure, so it's testable without touching the fs). Empty
// query → natural order, capped. Otherwise case-insensitive: basename-startswith beats path-startswith
// beats substring-anywhere; non-matches drop. Stable sort keeps walk order within a tier.
export function rankFiles(files: string[], query: string, limit = 50): string[] {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();
  const score = (p: string) => {
    const lp = p.toLowerCase();
    const base = lp.slice(lp.lastIndexOf("/") + 1);
    if (base.startsWith(q)) return 0;
    if (lp.startsWith(q)) return 1;
    return base.includes(q) || lp.includes(q) ? 2 : 3;
  };
  return files
    .map((p) => [p, score(p)] as const)
    .filter(([, s]) => s < 3)
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([p]) => p);
}

export const matchFiles = (query: string, limit = 50) => rankFiles(listWorkspaceFiles(), query, limit);

export function resolveInWorkspace(p: string): string {
  const abs = path.resolve(WORKSPACE, p);
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  // Checks the path string, not the real (symlink-resolved) target — a symlink inside the workspace
  // could still point out. Local CLI = user's own risk; symlink/sandbox gating is a future task.
  return abs;
}
