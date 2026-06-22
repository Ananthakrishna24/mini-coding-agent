// Shared trust boundary for every file tool: confine paths to the working directory.
// The model's paths are untrusted input, so this runs before any fs call.
import path from "node:path";

export const WORKSPACE = process.cwd();

export function resolveInWorkspace(p: string): string {
  const abs = path.resolve(WORKSPACE, p);
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  // ponytail: this checks the path string, not the real (symlink-resolved) target — a symlink inside
  // the workspace could still point out. Local CLI = user's own risk; symlink/sandbox gating is Task 4.2.
  return abs;
}
