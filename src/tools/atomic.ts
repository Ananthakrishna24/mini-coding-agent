// Atomic file write shared by write_file and edit_file: temp file in the same dir + rename, so a
// crash mid-write leaves the original intact instead of a truncated half-file. rename is atomic on
// one filesystem, which is why the temp sits next to the target.
import fs from "node:fs/promises";
import path from "node:path";

export async function writeAtomic(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }); // don't leave a stray .tmp behind on failure
    throw e;
  }
}
