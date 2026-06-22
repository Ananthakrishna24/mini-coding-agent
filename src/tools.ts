// The agent's hands: each tool bundles the schema the model sees with the executor we run.
// Model output is untrusted — dispatch validates args and never throws.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";

const execFileAsync = promisify(execFile);

// File ops are confined to the working directory — the model's paths are untrusted input.
const WORKSPACE = process.cwd();
function resolveInWorkspace(p: string): string {
  const abs = path.resolve(WORKSPACE, p);
  if (abs !== WORKSPACE && !abs.startsWith(WORKSPACE + path.sep)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return abs;
}

type Tool = {
  schema: OpenAI.ChatCompletionTool;
  run: (args: Record<string, unknown>) => Promise<string>;
};

const read_file: Tool = {
  schema: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file within the workspace and return its contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  async run({ path: p }) {
    if (typeof p !== "string") throw new Error("read_file: 'path' must be a string");
    return await fs.readFile(resolveInWorkspace(p), "utf8");
  },
};

const write_file: Tool = {
  schema: {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 text file within the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          content: { type: "string", description: "Full contents to write." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  async run({ path: p, content }) {
    if (typeof p !== "string" || typeof content !== "string") {
      throw new Error("write_file: 'path' and 'content' must be strings");
    }
    const abs = resolveInWorkspace(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return `wrote ${content.length} bytes to ${p}`;
  },
};

const run_bash: Tool = {
  // ponytail: unsandboxed shell, intentional for a coding agent. Permission gating lands in the safety layer.
  schema: {
    type: "function",
    function: {
      name: "run_bash",
      description: "Run a shell command in the workspace; returns combined stdout/stderr and the exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  async run({ command }) {
    if (typeof command !== "string") throw new Error("run_bash: 'command' must be a string");
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
        cwd: WORKSPACE,
        timeout: 120_000, // real builds/test suites run long; capResult trims the output later
        maxBuffer: 10 * 1024 * 1024, // let verbose runs finish instead of dying on ENOBUFS
      });
      return `exit 0\n${stdout}${stderr}`;
    } catch (e: any) {
      // Non-zero exit or timeout is a result the model should see, not a crash.
      return `exit ${e.code ?? "?"}\n${e.stdout ?? ""}${e.stderr ?? e.message}`;
    }
  },
};

const registry: Record<string, Tool> = { read_file, write_file, run_bash };

// Schemas to hand the model.
export const toolSchemas: OpenAI.ChatCompletionTool[] = Object.values(registry).map((t) => t.schema);

// Cap one tool result before it enters the history. A single big read/run can blow the budget
// in one turn; keep the top and bottom (signatures, errors, exit code) and drop the middle.
// The model can re-read the range if it needs the gap.
const MAX_TOOL_RESULT = 12_000; // chars ≈ ~3k tokens
export function capResult(s: string): string {
  if (s.length <= MAX_TOOL_RESULT) return s;
  const head = s.slice(0, Math.floor(MAX_TOOL_RESULT * 0.7));
  const tail = s.slice(-Math.floor(MAX_TOOL_RESULT * 0.2));
  const cut = s.length - head.length - tail.length;
  return `${head}\n… [${cut} chars omitted — re-read the range if needed] …\n${tail}`;
}

// Run one tool call. Never throws — errors come back as the result so the model can recover.
export async function dispatch(name: string, argsJson: string): Promise<string> {
  const tool = registry[name];
  if (!tool) return `error: unknown tool '${name}'`;

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return `error: arguments for '${name}' were not valid JSON`;
  }

  try {
    return capResult(await tool.run(args));
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}
