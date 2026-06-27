// Atomic file write using a temp file in the same directory to prevent partial writes.
import fs from "node:fs/promises";
import path from "node:path";

export async function writeAtomic(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }); // Clean up temp file on error
    throw e;
  }
}

