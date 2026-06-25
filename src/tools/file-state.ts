// Tracks file freshness between read_file and write/edit tools. This mirrors the reference harness
// safety contract: existing files must be read before they are overwritten or edited, and if they
// changed after that read, the model must read again instead of applying a stale patch.
import fs from "node:fs/promises";

export type FileReadState = {
  mtimeMs: number;
  isPartialView: boolean;
};

const readState = new Map<string, FileReadState>();

export function noteFileRead(abs: string, mtimeMs: number, isPartialView: boolean): void {
  readState.set(abs, { mtimeMs, isPartialView });
}

export function forgetFileRead(abs: string): void {
  readState.delete(abs);
}

export async function requireFreshWholeFileRead(abs: string, toolName: string): Promise<void> {
  const state = readState.get(abs);
  if (!state || state.isPartialView) {
    throw new Error(`${toolName}: existing file has not been read completely yet — use read_file first`);
  }

  const stat = await fs.stat(abs);
  if (stat.mtimeMs > state.mtimeMs) {
    throw new Error(`${toolName}: file has changed since it was read — read it again before modifying it`);
  }
}
