// Shared text read for read_file and edit_file. Stats the file first and refuses anything too big,
// so the model can't OOM the process by reading a giant log or bundle — capResult only trims AFTER
// the read, which is too late. For files over the limit, run_bash (grep/sed/head) is the right tool.
import fs from "node:fs/promises";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB — larger than any real source file; a safety ceiling, not a target
const NUL = String.fromCharCode(0); // a real NUL byte, written without putting one in this source file

export async function readTextFile(abs: string): Promise<string> {
  const { size } = await fs.stat(abs);
  if (size > MAX_FILE_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    throw new Error(
      `file is ${mb}MB, over the ${MAX_FILE_BYTES / 1024 / 1024}MB read limit — ` +
        "use run_bash with grep/sed/head to pull just the part you need",
    );
  }

  const text = await fs.readFile(abs, "utf8");
  // NUL-byte heuristic, not libmagic. UTF-8 text never contains NUL; binaries (images, compiled
  // output, archives) do — reject them so their decoded garbage can't pollute the context.
  if (text.includes(NUL)) {
    throw new Error("file looks binary (contains NUL bytes) — read_file only handles UTF-8 text; use run_bash for binary files");
  }
  return text;
}
