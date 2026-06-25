// write_file: create or overwrite a whole workspace text file. For changing part of a file, use edit_file.
import fs from "node:fs/promises";
import type { Tool } from "./types";
import { resolveInWorkspace } from "./workspace";
import { writeAtomic } from "./atomic";
import { forgetFileRead, requireFreshWholeFileRead } from "./file-state";

export const write_file: Tool = {
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
    try {
      await fs.stat(abs);
      await requireFreshWholeFileRead(abs, "write_file");
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
    await writeAtomic(abs, content);
    forgetFileRead(abs);
    return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}`;
  },
};
