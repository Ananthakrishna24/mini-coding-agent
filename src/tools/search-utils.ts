import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE, resolveInWorkspace } from "./workspace";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage"]);

export type WalkFile = { rel: string; abs: string; mtimeMs: number };

export function normalizeSearchRoot(p: unknown): { abs: string; rel: string } {
  if (p === undefined) return { abs: WORKSPACE, rel: "" };
  if (typeof p !== "string" || p.trim() === "") throw new Error("'path' must be a non-empty string when provided");
  const abs = resolveInWorkspace(p);
  return { abs, rel: path.relative(WORKSPACE, abs).split(path.sep).join("/") };
}

export async function walkWorkspaceFiles(rootAbs: string, maxFiles = 50_000): Promise<WalkFile[]> {
  const out: WalkFile[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const abs = path.join(dir, entry.name);
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        out.push({ abs, rel: path.relative(WORKSPACE, abs).split(path.sep).join("/"), mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk(rootAbs);
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const next = pattern[i + 1];
    if (c === "*") {
      if (next === "*") {
        const after = pattern[i + 2];
        if (after === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i++;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$+?.()|{}[]".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(out + "$", "i");
}

export function validatePositiveInteger(value: unknown, name: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`'${name}' must be a positive integer`);
  }
  return Math.min(value, max);
}
