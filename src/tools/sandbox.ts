// Platform sandbox wrapper for run_bash. This mirrors Codex's shape at a small scale:
// prefer a native OS sandbox, fail closed if unavailable, and require an explicit
// env opt-out for unrestricted shell execution.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { WORKSPACE } from "./workspace";

export type PreparedCommand = {
  program: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

const UNSAFE_MODES = new Set(["0", "false", "off", "none", "danger-full-access"]);

function sandboxDisabled(): boolean {
  const mode = process.env.AGENT_SANDBOX?.trim().toLowerCase();
  return mode ? UNSAFE_MODES.has(mode) : false;
}

function sbplString(s: string): string {
  return JSON.stringify(s);
}

export function macSeatbeltProfile(workspace: string): string {
  const ws = sbplString(workspace);
  return `(version 1)
(allow default)
(deny network*)
(deny file-write*
  (require-all
    (require-not (subpath ${ws}))
    (require-not (literal "/dev/null"))
    (require-not (literal "/dev/tty"))
    (require-not (regex #"^/dev/ttys[0-9]+"))
  ))
`;
}

function findOnPath(name: string): string | null {
  const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of paths) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function sandboxEnv(workspace: string, tmpDir: string): Promise<NodeJS.ProcessEnv> {
  await fsp.mkdir(tmpDir, { recursive: true });
  return { ...process.env, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir };
}

function unavailable(platform: NodeJS.Platform): Error {
  return new Error(
    `run_bash: no ${platform} sandbox is available; set AGENT_SANDBOX=danger-full-access to run unsandboxed`,
  );
}

export async function prepareBashCommand(command: string, workspace = WORKSPACE): Promise<PreparedCommand> {
  const localTmp = path.join(workspace, ".mini-agent", "tmp");
  if (sandboxDisabled()) {
    return {
      program: "bash",
      args: ["-c", command],
      env: await sandboxEnv(workspace, localTmp),
    };
  }

  if (process.platform === "darwin") {
    const sandboxExec = "/usr/bin/sandbox-exec";
    if (!fs.existsSync(sandboxExec)) throw unavailable(process.platform);
    return {
      program: sandboxExec,
      args: ["-p", macSeatbeltProfile(workspace), "bash", "-c", command],
      env: await sandboxEnv(workspace, localTmp),
    };
  }

  if (process.platform === "linux") {
    const bwrap = findOnPath("bwrap");
    if (!bwrap) throw unavailable(process.platform);
    return {
      program: bwrap,
      args: [
        "--die-with-parent",
        "--unshare-all",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        workspace,
        workspace,
        "--tmpfs",
        "/tmp",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--chdir",
        workspace,
        "--setenv",
        "TMPDIR",
        "/tmp",
        "--setenv",
        "TMP",
        "/tmp",
        "--setenv",
        "TEMP",
        "/tmp",
        "bash",
        "-c",
        command,
      ],
      env: await sandboxEnv(workspace, "/tmp"),
    };
  }

  throw unavailable(process.platform);
}
