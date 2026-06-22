// edit_file: surgical edit — replace an exact text block with another, instead of rewriting the file.
// old_string must match exactly and be unique (unless replace_all), so an edit can't silently hit the
// wrong spot. This is the tool that makes the prompt's "prefer targeted edits over rewrites" real.
import type { Tool } from "./types";
import { resolveInWorkspace } from "./workspace";
import { writeAtomic } from "./atomic";
import { readTextFile } from "./read-text";

export const edit_file: Tool = {
  schema: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact block of text in a workspace file. 'old_string' must match the file " +
        "exactly (including whitespace) and be unique unless 'replace_all' is true. Prefer this over " +
        "write_file for changing part of a file — include enough surrounding context to be unambiguous.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace root." },
          old_string: { type: "string", description: "Exact text to find. Include surrounding lines so it matches one place." },
          new_string: { type: "string", description: "Text to put in its place." },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match. Default false." },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  async run({ path: p, old_string, new_string, replace_all }) {
    if (typeof p !== "string") throw new Error("edit_file: 'path' must be a string");
    if (typeof old_string !== "string" || typeof new_string !== "string") {
      throw new Error("edit_file: 'old_string' and 'new_string' must be strings");
    }
    if (old_string === "") throw new Error("edit_file: 'old_string' is empty — use write_file to create a file");
    if (old_string === new_string) throw new Error("edit_file: 'old_string' and 'new_string' are identical — nothing to change");

    const abs = resolveInWorkspace(p);
    const text = await readTextFile(abs);

    const matches = text.split(old_string).length - 1; // literal count, no regex
    if (matches === 0) throw new Error("edit_file: 'old_string' not found in the file");
    const all = replace_all === true;
    if (matches > 1 && !all) {
      throw new Error(`edit_file: 'old_string' matches ${matches} places — add surrounding context to make it unique, or set replace_all`);
    }

    // split/join (replace_all) and a function replacement (single) both insert new_string literally —
    // a string replacement would treat $&, $1, etc. in new_string as backreferences.
    const updated = all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
    await writeAtomic(abs, updated);

    const n = all ? matches : 1;
    return `edited ${p} (${n} replacement${n === 1 ? "" : "s"})`;
  },
};
