// read_file: read a workspace text file whole, or a line window for paging through big files.
import fs from "node:fs/promises";
import type { Tool } from "./types";
import { resolveInWorkspace } from "./workspace";
import { readTextFile } from "./read-text";
import { noteFileRead } from "./file-state";

export const read_file: Tool = {
  schema: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file within the workspace. Returns the whole file by default, or a line " +
        "window via offset/limit — use the window to page through a file too big to read at once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          offset: { type: "number", description: "1-based line to start from. Omit to read from the top." },
          limit: { type: "number", description: "Max lines to return. Omit to read to the end." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  async run({ path: p, offset, limit }) {
    if (typeof p !== "string") throw new Error("read_file: 'path' must be a string");
    const abs = resolveInWorkspace(p);
    const text = await readTextFile(abs);
    const stat = await fs.stat(abs);
    const isPartialView = offset !== undefined || limit !== undefined;
    if (!isPartialView) {
      noteFileRead(abs, stat.mtimeMs, false);
      return text; // whole-file: byte-identical, no header
    }

    // Validate the optional window at the trust boundary — these come straight from the model.
    const from = offset ?? 1;
    if (typeof from !== "number" || !Number.isInteger(from) || from < 1) {
      throw new Error("read_file: 'offset' must be a positive integer (1-based line number)");
    }
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
      throw new Error("read_file: 'limit' must be a positive integer");
    }

    noteFileRead(abs, stat.mtimeMs, true);
    const lines = text.split("\n");
    const start = from - 1;
    const end = typeof limit === "number" ? start + limit : undefined;
    const slice = lines.slice(start, end);
    // Tell the model where this window sits so it can page on without re-guessing the offset.
    return `# lines ${from}-${start + slice.length} of ${lines.length}\n${slice.join("\n")}`;
  },
};
