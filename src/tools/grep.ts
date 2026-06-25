import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import type { Tool } from "./types";
import { globToRegExp, normalizeSearchRoot, validatePositiveInteger, walkWorkspaceFiles } from "./search-utils";

const execFileAsync = promisify(execFile);
type OutputMode = "content" | "files_with_matches" | "count";

function parseMode(value: unknown): OutputMode {
  if (value === undefined) return "files_with_matches";
  if (value === "content" || value === "files_with_matches" || value === "count") return value;
  throw new Error("grep: 'output_mode' must be one of: content, files_with_matches, count");
}

function parseBoolean(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`grep: '${name}' must be a boolean`);
  return value;
}

function prefixRipgrepOutput(output: string, rootRel: string): string {
  if (!rootRel) return output;
  return output
    .split("\n")
    .map((line) => {
      if (!line) return line;
      const clean = line.startsWith("./") ? line.slice(2) : line;
      return `${rootRel}/${clean}`;
    })
    .join("\n");
}

async function tryRipgrep(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync("rg", args, { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
    return stdout + stderr;
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    if (e.code === 1) return ""; // no matches
    if (e.killed && e.signal) throw new Error("grep: rg timed out after 60s");
    throw new Error(`grep: rg failed: ${e.stderr || e.message}`);
  }
}

async function fallbackGrep(rootAbs: string, rootRel: string, pattern: string, mode: OutputMode, glob: string | undefined, multiline: boolean, max: number): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, multiline ? "ms" : "");
  } catch (e: any) {
    throw new Error(`grep: invalid regex pattern: ${e.message}`);
  }
  const globRe = glob ? globToRegExp(glob) : null;
  const files = await walkWorkspaceFiles(rootAbs);
  const out: string[] = [];
  for (const f of files) {
    const relToRoot = rootRel ? f.rel.slice(rootRel.length + 1) : f.rel;
    if (globRe && !globRe.test(relToRoot) && !globRe.test(f.rel)) continue;
    let text: string;
    try {
      text = await fs.readFile(f.abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes(String.fromCharCode(0))) continue;
    if (mode === "files_with_matches") {
      if (re.test(text)) out.push(f.rel);
    } else if (mode === "count") {
      const count = multiline ? (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length : text.split("\n").filter((line) => re.test(line)).length;
      if (count > 0) out.push(`${f.rel}:${count}`);
    } else {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) out.push(`${f.rel}:${i + 1}:${lines[i]}`);
        if (out.length >= max) break;
      }
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max).join("\n");
}

export const grep: Tool = {
  schema: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search workspace files using ripgrep-compatible regex. Prefer this over running grep/rg in run_bash. " +
        "Supports file filtering with glob, output modes (content, files_with_matches, count), and multiline search.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for (ripgrep syntax when rg is installed)." },
          path: { type: "string", description: "Optional workspace-relative directory to search within. Defaults to workspace root." },
          glob: { type: "string", description: "Optional glob filter, e.g. '*.ts' or 'src/**/*.tsx'." },
          output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Default files_with_matches. content returns file:line:match; count returns file:count." },
          multiline: { type: "boolean", description: "Allow patterns to match across lines. Default false." },
          limit: { type: "number", description: "Maximum result lines to return. Default 100, max 1000." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  async run({ pattern, path, glob, output_mode, multiline, limit }) {
    if (typeof pattern !== "string" || pattern === "") throw new Error("grep: 'pattern' must be a non-empty string");
    if (glob !== undefined && (typeof glob !== "string" || glob === "")) throw new Error("grep: 'glob' must be a non-empty string when provided");
    const root = normalizeSearchRoot(path);
    const mode = parseMode(output_mode);
    const multi = parseBoolean(multiline, "multiline");
    const max = validatePositiveInteger(limit, "limit", 100, 1000);

    const args = ["--color", "never", "--no-heading"];
    if (mode === "files_with_matches") args.push("--files-with-matches");
    if (mode === "count") args.push("--count");
    if (mode === "content") args.push("--line-number");
    if (multi) args.push("--multiline");
    if (glob) args.push("--glob", glob);
    args.push(pattern, ".");

    let result = await tryRipgrep(args, root.abs);
    if (result === null) result = await fallbackGrep(root.abs, root.rel, pattern, mode, glob, multi, max);
    else result = prefixRipgrepOutput(result, root.rel);
    const lines = result.split("\n").filter(Boolean).slice(0, max);
    return lines.length ? lines.join("\n") : "no matches";
  },
};
