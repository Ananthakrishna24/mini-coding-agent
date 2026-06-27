// Tool for creating or overwriting workspace text files.
import fs from "node:fs/promises";
import type { Tool } from "./types";
import { resolveInWorkspace } from "./workspace";
import { writeAtomic } from "./atomic";
import { forgetFileRead, requireFreshWholeFileRead } from "./file-state";
import { withPathLock } from "./path-locks";

export const write_file: Tool = {
  schema: {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a UTF-8 text file within the workspace. Overwriting an existing file " +
        "requires a prior whole-file read; prefer edit_file or multi_edit for targeted changes.",
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
    return await withPathLock(abs, async () => {
      try {
        await fs.stat(abs);
        await requireFreshWholeFileRead(abs, "write_file");
      } catch (e: any) {
        if (e?.code !== "ENOENT") throw e;
      }
      await writeAtomic(abs, content);
      forgetFileRead(abs);
      return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}`;
    });
  },
};
