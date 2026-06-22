// write_file: create or overwrite a whole workspace text file. For changing part of a file, use edit_file.
import type { Tool } from "./types";
import { resolveInWorkspace } from "./workspace";
import { writeAtomic } from "./atomic";

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
    await writeAtomic(resolveInWorkspace(p), content);
    return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}`;
  },
};
