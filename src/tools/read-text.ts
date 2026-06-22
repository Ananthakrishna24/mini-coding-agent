// Shared text read for read_file and edit_file. Stats the file first and refuses anything too big,
// so the model can't OOM the process by reading a giant log or bundle — capResult only trims AFTER
// the read, which is too late. For files over the limit, run_bash (grep/sed/head) is the right tool.
import fs from "node:fs/promises";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB — larger than any real source file; a safety ceiling, not a target

export async function readTextFile(abs: string): Promise<string> {
  const { size } = await fs.stat(abs);
  if (size > MAX_FILE_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    throw new Error(
      `file is ${mb}MB, over the ${MAX_FILE_BYTES / 1024 / 1024}MB read limit — ` +
        "use run_bash with grep/sed/head to pull just the part you need",
    );
  }
  return fs.readFile(abs, "utf8");
}
