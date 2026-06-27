// Tool for running bash commands within the workspace directory.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./types";
import { WORKSPACE } from "./workspace";
import { prepareBashCommand } from "./sandbox";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 120_000; // 2 minutes timeout

export const run_bash: Tool = {
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
  async run({ command }, signal) {
    if (typeof command !== "string") throw new Error("run_bash: 'command' must be a string");
    try {
      const prepared = await prepareBashCommand(command, WORKSPACE);
      const { stdout, stderr } = await execFileAsync(prepared.program, prepared.args, {
        cwd: WORKSPACE,
        env: prepared.env,
        timeout: TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer limit
        signal,
      });
      return `exit 0\n${stdout}${stderr}`;
    } catch (e: any) {
      if (e.name === "AbortError" || (e.killed && e.signal === "SIGTERM" && signal?.aborted)) {
        return `error: command interrupted by user\n${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      // Process timeout.
      if (e.killed && e.signal) {
        return `error: command timed out after ${TIMEOUT_MS / 1000}s\n${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      // Command failed with non-zero exit code.
      return `exit ${e.code ?? "?"}\n${e.stdout ?? ""}${e.stderr ?? e.message}`;
    }
  },
};
