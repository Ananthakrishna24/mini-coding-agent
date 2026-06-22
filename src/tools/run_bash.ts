// run_bash: run a shell command in the workspace, returning combined output and the exit code.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./types";
import { WORKSPACE } from "./workspace";

const execFileAsync = promisify(execFile);

export const run_bash: Tool = {
  // ponytail: commands pass the deny-list gate in dispatch (permissions.ts) before they reach here,
  // but the shell itself is still unsandboxed — the gate is an accident-fence, not a jail. Real
  // containment = an OS sandbox (bubblewrap/Landlock, Seatbelt) with no net / no writes outside the tree.
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
