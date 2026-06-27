// Shared utility to read text files with size and binary checks.
import fs from "node:fs/promises";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB safety limit
const NUL = String.fromCharCode(0);

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
  // Reject binary files.
  if (text.includes(NUL)) {
    throw new Error("file looks binary (contains NUL bytes) — read_file only handles UTF-8 text; use run_bash for binary files");
  }
  return text;
}

